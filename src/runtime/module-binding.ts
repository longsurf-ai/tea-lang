// Purpose: Immutable concrete-manifest snapshots shared by JavaScript and GPU
// execution hosts.

import {Storage} from '../ir/node';
import {Field, Float64, Schema} from 'apache-arrow';
import {cloneSchema, decodeSchema} from './io';
import {
  isHistoryOffset,
  RUNTIME_ABI_VERSION,
  type DepthSpec,
  type JSModule,
  type ModuleBinding,
  type ModuleManifest,
} from './module-abi';
import type {BoundInput} from './binding';
import {BindError} from './errors';
import {outputSchema, type ExecutionDeclaration} from './output';
import {resolveParamValues} from './params';
import type {ManifestValue, Value} from './value';
import {ValueLayoutRegistry} from './value-layout';

type GeneratedModule = Pick<
  JSModule,
  'abi' | 'layout' | 'manifest' | 'requests' | 'concretize' | 'funcs' | 'main'
>;

export class ModuleBindingEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleBindingEvaluationError';
  }
}

/** Attach derived ready/remaining methods and freeze a raw generated tree. */
export function initializeModuleTree(code: GeneratedModule): JSModule {
  requireCurrentAbi(code);
  const requests = code.requests.map(child => initializeModuleTree(child));
  return moduleSnapshot(code, initialManifest(code.manifest), requests);
}

/** Test-fixture compatibility name for initializing hand-authored modules. */
export function createGeneratedModule(code: GeneratedModule): JSModule {
  return initializeModuleTree(code);
}

/**
 * Copy binding facts and Arrow schemas without losing their classes or sharing
 * mutable metadata. Raw IPC fields are decoded during initial loading.
 * @example Changing a copied field's metadata leaves the old manifest unchanged.
 */
export function cloneModuleManifest(manifest: ModuleManifest): ModuleManifest {
  const {inputs, outputs, effects, ...data} = manifest;
  return {
    ...structuredClone(data),
    inputs:
      inputs instanceof Schema
        ? cloneSchema(inputs)
        : decodeSchema(inputs as unknown as number[]),
    outputs: outputs.map(({channels, ...output}) => ({
      ...structuredClone(output),
      channels: channels.every(field => field instanceof Field)
        ? cloneSchema(new Schema([...channels])).fields
        : decodeSchema(channels as unknown as number[]).fields,
    })),
    effects: effects.map(({declaration, ...effect}) => ({
      ...structuredClone(effect),
      declaration: {
        payload:
          declaration.payload instanceof Field
            ? cloneSchema(new Schema([declaration.payload])).fields[0]
            : decodeSchema(declaration.payload as unknown as number[])
                .fields[0],
      },
    })),
  };
}

function initialManifest(manifest: ModuleManifest): ModuleManifest {
  const copy = cloneModuleManifest(manifest);
  copy.params.forEach(param => {
    if (param.bindable === undefined) Object.assign(param, {bindable: true});
    if (param.active === undefined) Object.assign(param, {active: true});
  });
  copy.series.forEach(series => {
    if (series.supplied === undefined) Object.assign(series, {supplied: false});
  });
  copy.outputs.forEach(output => {
    if (output.boundArgs === undefined) Object.assign(output, {boundArgs: []});
  });
  copy.requests.forEach(request => {
    if (request.context === undefined) Object.assign(request, {context: null});
  });
  return copy;
}

/** Ordered parameter and named-series states, derived only from the manifest. */
export function moduleBindings(module: JSModule): readonly ModuleBinding[] {
  const series = new Map<string, boolean>();
  module.manifest.series.forEach((spec, sid) => {
    const name = seriesBindingName(module.manifest, sid);
    if (name === null) return;
    series.set(name, (series.get(name) ?? true) && spec.supplied === true);
  });
  return Object.freeze([
    ...module.manifest.params.flatMap((spec): readonly ModuleBinding[] => {
      if (spec.bindable === false) return [];
      return [
        Object.freeze(
          Object.hasOwn(spec, 'value')
            ? {kind: 'parameter' as const, name: spec.name, value: spec.value}
            : {kind: 'parameter' as const, name: spec.name},
        ),
      ];
    }),
    ...[...series].map(([name, supplied]) =>
      Object.freeze({kind: 'series' as const, name, supplied}),
    ),
  ]);
}

/** Return one source-series name per manifest sid, preserving duplicates. */
export function moduleSeriesNames(module: JSModule): readonly string[] {
  return Object.freeze(
    module.manifest.series.map((_series, sid) => {
      const name = seriesBindingName(module.manifest, sid);
      if (name === null) {
        throw new ModuleBindingEvaluationError(
          `series slot ${sid} has no concrete binding name`,
        );
      }
      return name;
    }),
  );
}

/** Missing host bindings in this module context. */
export function moduleRemaining(module: JSModule): readonly ModuleBinding[] {
  return Object.freeze(
    moduleBindings(module).filter(binding => !bindingSupplied(binding)),
  );
}

/** Whether this context's manifest is fully supplied and concrete. */
export function moduleReady(module: JSModule): boolean {
  return (
    moduleRemaining(module).length === 0 &&
    module.manifest.params.every(
      param =>
        Object.hasOwn(param, 'value') && typeof param.active === 'boolean',
    ) &&
    allDepths(module.manifest).every(depth => depth.kind !== 'bound') &&
    module.manifest.outputs.every(output => output.boundArgs != null) &&
    module.manifest.requests.every(request => request.context != null)
  );
}

/**
 * Apply derived binding states to a fresh recursive manifest snapshot.
 * Parameter values are compilation-global and are copied into request children.
 */
export function withModuleBindings(
  module: JSModule,
  bindings: readonly ModuleBinding[],
  contextConstants: ReadonlyMap<number, Value> = new Map(),
): JSModule {
  const manifest = cloneModuleManifest(module.manifest);
  writeBindingStates(manifest, bindings);
  const parameters = completeParameterValues(manifest);
  const requests = module.requests.map(child =>
    propagateParameters(child, parameters),
  );
  const snapshot = moduleSnapshot(module, manifest, requests);
  return parameters === null
    ? snapshot
    : concretizeTree(snapshot, contextConstants);
}

/** Return a parent snapshot whose request path contains the new child. */
export function withRequestModule(
  module: JSModule,
  requestId: number,
  child: JSModule,
): JSModule {
  if (module.requests[requestId] === undefined) {
    throw new ModuleBindingEvaluationError(
      `unknown generated request child ${requestId}`,
    );
  }
  if (child.abi !== module.abi || child.layout !== module.layout) {
    throw new ModuleBindingEvaluationError(
      `request child ${requestId} does not belong to this generated module tree`,
    );
  }
  const requests = [...module.requests];
  requests[requestId] = child;
  return moduleSnapshot(module, cloneModuleManifest(module.manifest), requests);
}

/** Throw unless this module context has a complete concrete manifest. */
export function requireConcreteModule(module: JSModule): JSModule {
  if (!module.ready()) {
    throw new ModuleBindingEvaluationError(
      'JavaScript module has incomplete input bindings or manifest data',
    );
  }
  validateConcreteManifest(module);
  return module;
}

/** Ordered validated root parameters exposed by execution hosts. */
export function boundInputs(module: JSModule): readonly BoundInput[] {
  requireConcreteModule(module);
  return Object.freeze(
    module.manifest.params.flatMap((spec): readonly BoundInput[] => {
      if (spec.bindable === false) return [];
      const {value, active, bindable: _bindable, ...declaration} = spec;
      if (value === undefined || typeof active !== 'boolean') {
        throw new ModuleBindingEvaluationError(
          `parameter '${spec.name}' is not concrete`,
        );
      }
      return [
        Object.freeze({
          spec: deepFreeze(declaration),
          value,
          active,
        }),
      ];
    }),
  );
}

/**
 * Project host declarations while keeping physical storage IDs private.
 * @example `moduleDeclaration(module).schema` describes the rows Node publishes.
 */
export function moduleDeclaration(module: JSModule): ExecutionDeclaration {
  return deepFreeze({
    schema: module.outputs,
    outputs: module.manifest.outputs.map(output => {
      const {boundArgs, layouts: _layouts, ...spec} = output;
      if (boundArgs == null) {
        throw new ModuleBindingEvaluationError(
          `output '${output.effect}' has no concrete declaration arguments`,
        );
      }
      return {spec, boundArgs};
    }),
    effects: module.manifest.effects.map(effect => effect.declaration),
  });
}

export interface GeneratedBindingLayout {
  readonly frameHistoryCapacities: readonly (readonly number[])[];
  readonly inputs: readonly BoundInput[];
}

/** Apply one complete parameter vector to a generated root context. */
export function configureModule(
  code: JSModule,
  paramValues: readonly Value[],
  contextConstants: ReadonlyMap<number, Value> = new Map(),
): JSModule {
  return configure(code, paramValues, true, contextConstants);
}

/** Apply compilation-global parameters to one generated request context. */
export function configureChildModule(
  code: JSModule,
  paramValues: readonly Value[],
  contextConstants: ReadonlyMap<number, Value> = new Map(),
): JSModule {
  return configure(code, paramValues, false, contextConstants);
}

/** Resolve concrete parameters and project GPU frame capacities by extent. */
export function resolveGeneratedBindingLayout(
  code: JSModule,
  paramsInput: Readonly<Record<string, unknown>>,
  indices: number,
): GeneratedBindingLayout {
  requireCurrentAbi(code);
  if (!Number.isSafeInteger(indices) || indices < 0) {
    throw new BindError(
      `GPU binding indices must be a non-negative safe integer, got ${indices}`,
    );
  }
  const params = resolveParamValues(code.manifest.params, paramsInput);
  const configured = configureModule(code, params);
  return Object.freeze({
    frameHistoryCapacities: Object.freeze(
      configured.manifest.frames.map((frame, fid) =>
        Object.freeze(
          frame.locals.map((local, slot) => {
            let capacity = Math.min(
              depthBars(local.depth, `frame ${fid} slot ${slot}`),
              indices,
            );
            if (
              local.storage === Storage.Var ||
              local.storage === Storage.Varip
            ) {
              capacity = Math.max(capacity, 1);
            }
            return capacity;
          }),
        ),
      ),
    ),
    inputs: boundInputs(configured),
  });
}

/** Concrete retained bars represented by one manifest depth. */
export function depthBars(depth: DepthSpec, label = 'depth'): number {
  switch (depth.kind) {
    case 'none':
      return 0;
    case 'const':
    case 'capped':
      if (!isHistoryOffset(depth.bars)) {
        throw new ModuleBindingEvaluationError(
          `${label} has invalid history depth`,
        );
      }
      return depth.bars;
    case 'bound':
      throw new ModuleBindingEvaluationError(`${label} is not concrete`);
  }
}

function configure(
  code: JSModule,
  paramValues: readonly Value[],
  exactParams: boolean,
  contextConstants: ReadonlyMap<number, Value>,
): JSModule {
  requireCurrentAbi(code);
  validateParamCount(code, paramValues, exactParams);
  const manifest = cloneModuleManifest(code.manifest);
  manifest.params.forEach((param, pid) => {
    const value = paramValues[pid];
    if (!isManifestValue(value)) {
      throw new ModuleBindingEvaluationError(
        `parameter '${param.name}' is not a manifest scalar`,
      );
    }
    Object.assign(param, {value});
  });
  manifest.series.forEach(series => Object.assign(series, {supplied: true}));
  const requests = code.requests.map(child =>
    concretizeAvailableTree(
      propagateParameters(child, paramValues as readonly ManifestValue[]),
    ),
  );
  return concretizeSnapshot(
    moduleSnapshot(code, manifest, requests),
    contextConstants,
  );
}

function propagateParameters(
  module: JSModule,
  values: readonly ManifestValue[] | null,
): JSModule {
  const manifest = cloneModuleManifest(module.manifest);
  manifest.params.forEach((param, pid) => {
    if (values === null) {
      delete (param as {value?: ManifestValue}).value;
      return;
    }
    const value = values[pid];
    if (value === undefined) {
      throw new ModuleBindingEvaluationError(
        `request child is missing compilation-global parameter ${pid}`,
      );
    }
    Object.assign(param, {value});
  });
  const requests = module.requests.map(child =>
    propagateParameters(child, values),
  );
  return moduleSnapshot(module, manifest, requests);
}

function concretizeTree(
  module: JSModule,
  contextConstants: ReadonlyMap<number, Value>,
): JSModule {
  const requests = module.requests.map(child =>
    concretizeTree(child, new Map()),
  );
  return concretizeSnapshot(
    moduleSnapshot(module, cloneModuleManifest(module.manifest), requests),
    contextConstants,
  );
}

function concretizeAvailableTree(module: JSModule): JSModule {
  const requests = module.requests.map(concretizeAvailableTree);
  const snapshot = moduleSnapshot(
    module,
    cloneModuleManifest(module.manifest),
    requests,
  );
  try {
    return concretizeSnapshot(snapshot, new Map());
  } catch (error) {
    if (
      error instanceof Error &&
      /^builtin '.+' is not bind-visible$/.test(error.message)
    ) {
      return snapshot;
    }
    throw error;
  }
}

function concretizeSnapshot(
  module: JSModule,
  contextConstants: ReadonlyMap<number, Value>,
): JSModule {
  const manifest = cloneModuleManifest(module.manifest);
  module.concretize(manifest, contextConstants);
  validateManifestShape(module, manifest);
  return moduleSnapshot(module, manifest, module.requests);
}

function writeBindingStates(
  manifest: ModuleManifest,
  bindings: readonly ModuleBinding[],
): void {
  for (const binding of bindings) {
    if (binding.kind === 'parameter') {
      const param = manifest.params.find(
        candidate =>
          candidate.bindable !== false && candidate.name === binding.name,
      );
      if (param === undefined) {
        throw new ModuleBindingEvaluationError(
          `unknown parameter binding '${binding.name}'`,
        );
      }
      if (Object.hasOwn(binding, 'value')) {
        if (
          param.seriesSid !== null &&
          param.value !== binding.value &&
          manifest.series[param.seriesSid] !== undefined
        ) {
          Object.assign(manifest.series[param.seriesSid]!, {supplied: false});
        }
        Object.assign(param, {value: binding.value});
      } else {
        if (
          param.seriesSid !== null &&
          manifest.series[param.seriesSid] !== undefined
        ) {
          Object.assign(manifest.series[param.seriesSid]!, {supplied: false});
        }
        delete (param as {value?: ManifestValue}).value;
      }
      continue;
    }
    let found = false;
    manifest.series.forEach((series, sid) => {
      if (seriesBindingName(manifest, sid) === binding.name) {
        Object.assign(series, {supplied: binding.supplied});
        found = true;
      }
    });
    if (!found) {
      throw new ModuleBindingEvaluationError(
        `unknown series binding '${binding.name}'`,
      );
    }
  }
}

function seriesBindingName(
  manifest: ModuleManifest,
  sid: number,
): string | null {
  const series = manifest.series[sid];
  if (series === undefined) return null;
  if (series.id !== null) return series.id;
  const parameter = manifest.params.find(param => param.seriesSid === sid);
  return typeof parameter?.value === 'string' ? parameter.value : null;
}

function completeParameterValues(
  manifest: ModuleManifest,
): readonly ManifestValue[] | null {
  const values: ManifestValue[] = [];
  for (const param of manifest.params) {
    if (!Object.hasOwn(param, 'value')) return null;
    values.push(param.value as ManifestValue);
  }
  return values;
}

function moduleSnapshot(
  code: GeneratedModule,
  manifest: ModuleManifest,
  requests: readonly JSModule[],
): JSModule {
  let module!: JSModule;
  const {abi, layout, concretize, funcs, main} = code;
  module = {
    abi,
    layout,
    concretize,
    funcs,
    main,
    get inputs() {
      const fields = new Map(
        manifest.inputs.fields.map(field => [field.name, field]),
      );
      manifest.series.forEach((_, sid) => {
        const name = seriesBindingName(manifest, sid);
        if (name !== null && !fields.has(name))
          fields.set(name, new Field(name, new Float64(), false));
      });
      return cloneSchema(
        new Schema([...fields.values()], manifest.inputs.metadata),
      );
    },
    get outputs() {
      return cloneSchema(
        outputSchema(
          manifest.outputs,
          manifest.effects.map(effect => effect.declaration),
        ),
      );
    },
    manifest: deepFreeze(manifest),
    requests: Object.freeze([...requests]),
    ready: () => moduleReady(module),
    remaining: () => moduleRemaining(module),
  };
  return deepFreeze(module);
}

function bindingSupplied(binding: ModuleBinding): boolean {
  return binding.kind === 'series'
    ? binding.supplied
    : Object.hasOwn(binding, 'value');
}

function allDepths(manifest: ModuleManifest): readonly DepthSpec[] {
  return [
    ...manifest.frames.flatMap(frame => frame.locals.map(local => local.depth)),
    ...manifest.series.map(series => series.depth),
    ...manifest.builtin.map(builtin => builtin.depth),
    ...manifest.requests.map(request => request.depth),
  ];
}

function validateConcreteManifest(module: JSModule): void {
  const layouts = new ValueLayoutRegistry(module.layout);
  module.manifest.params.forEach((param, pid) => {
    if (!Object.hasOwn(param, 'value') || typeof param.active !== 'boolean') {
      throw new ModuleBindingEvaluationError(`parameter ${pid} is incomplete`);
    }
  });
  allDepths(module.manifest).forEach((depth, index) =>
    depthBars(depth, `manifest depth ${index}`),
  );
  module.manifest.outputs.forEach((output, oid) => {
    if (output.boundArgs === null) {
      throw new ModuleBindingEvaluationError(`output ${oid} is incomplete`);
    }
  });
  module.manifest.requests.forEach((request, rid) => {
    if (request.name.length === 0) {
      throw new ModuleBindingEvaluationError(
        `request ${rid} has no binding name`,
      );
    }
    layouts.layout(request.resultLayout);
    const parent = layouts.layout(request.layout);
    if (
      (request.merge.mode === 'sample' &&
        request.layout !== request.resultLayout) ||
      (request.merge.mode === 'collect' &&
        (parent.kind !== 'array' || parent.element !== request.resultLayout))
    ) {
      throw new ModuleBindingEvaluationError(
        `request ${rid} has inconsistent ${request.merge.mode} layouts`,
      );
    }
    if (request.dynamic) {
      throw new ModuleBindingEvaluationError(
        `dynamic request ${rid} is unsupported`,
      );
    }
    if (module.requests[rid] === undefined) {
      throw new ModuleBindingEvaluationError(
        `static request ${rid} has no generated child module`,
      );
    }
    validateRequestContext(request.context, rid);
  });
}

function validateManifestShape(
  module: JSModule,
  manifest: ModuleManifest,
): void {
  if (
    manifest.params.length !== module.manifest.params.length ||
    manifest.series.length !== module.manifest.series.length ||
    manifest.builtin.length !== module.manifest.builtin.length ||
    manifest.outputs.length !== module.manifest.outputs.length ||
    manifest.frames.length !== module.manifest.frames.length ||
    manifest.requests.length !== module.manifest.requests.length
  ) {
    throw new ModuleBindingEvaluationError(
      'generated concretizer changed manifest topology',
    );
  }
  manifest.params.forEach((param, pid) => {
    if (param.active !== null && typeof param.active !== 'boolean') {
      throw new ModuleBindingEvaluationError(
        `parameter ${pid} active expression did not produce bool`,
      );
    }
  });
  allDepths(manifest).forEach((depth, index) => {
    if (depth.kind !== 'bound') depthBars(depth, `manifest depth ${index}`);
  });
  manifest.outputs.forEach((output, oid) => {
    output.boundArgs?.forEach((arg, index) => {
      if (typeof arg.name !== 'string') {
        throw new ModuleBindingEvaluationError(
          `output ${oid} argument ${index} is invalid`,
        );
      }
    });
  });
  manifest.requests.forEach((request, rid) => {
    if (request.context !== null) validateRequestContext(request.context, rid);
  });
}

function validateRequestContext(
  context: ModuleManifest['requests'][number]['context'],
  rid: number,
): void {
  if (
    context == null ||
    typeof context.symbol !== 'string' ||
    typeof context.timeframe !== 'string' ||
    (context.availability !== 'start' && context.availability !== 'end') ||
    (context.fill !== 'carry' && context.fill !== 'sparse') ||
    typeof context.ignoreInvalidSymbol !== 'boolean' ||
    !Number.isSafeInteger(context.calcBarsCount) ||
    context.calcBarsCount < 0
  ) {
    throw new ModuleBindingEvaluationError(
      `request ${rid} has invalid concrete context`,
    );
  }
}

function validateParamCount(
  code: JSModule,
  paramValues: readonly Value[],
  exactParams: boolean,
): void {
  if (
    (exactParams && paramValues.length !== code.manifest.params.length) ||
    (!exactParams && paramValues.length < code.manifest.params.length)
  ) {
    throw new ModuleBindingEvaluationError(
      `expected ${code.manifest.params.length} parameter values, got ${paramValues.length}`,
    );
  }
}

function requireCurrentAbi(code: Pick<JSModule, 'abi'>): void {
  if (code.abi !== RUNTIME_ABI_VERSION) {
    throw new ModuleBindingEvaluationError(
      `unsupported module ABI ${String(code.abi)}; expected ${RUNTIME_ABI_VERSION}`,
    );
  }
}

function isManifestValue(value: Value | undefined): value is ManifestValue {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  );
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const property of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (property.enumerable && 'value' in property) deepFreeze(property.value);
  }
  return Object.freeze(value);
}
