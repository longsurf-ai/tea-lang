// Purpose: Evaluate generated binding code and return immutable JSModule
// snapshots consumed by JavaScript and GPU execution hosts.

import {Storage} from '../ir/node';
import {
  RUNTIME_ABI_VERSION,
  type BuiltinSpec,
  type CollectionEntries,
  type CollectionMutation,
  type CollectionMutationOperation,
  type CollectionOperation,
  type DepthSpec,
  type Frame,
  type JSModule,
  type JSModuleBinding,
  type ModuleInputBinding,
} from './module-abi';
import type {BindInputs, BoundInput} from './binding';
import {CollectionRuntime} from './collections';
import {BindError} from './errors';
import {ArenaHeap, type HeapTransaction, type Ref} from './heap';
import {assertMergeAxis} from './merge';
import type {ExecutionDeclaration} from './output';
import {resolveParamValues} from './params';
import type {ProviderContext, SeriesData} from './provider';
import {isHistoryOffset} from './history';
import {StructStorageRuntime} from './struct-storage';
import type {Value} from './value';
import {type LayoutId, ValueLayoutRegistry} from './value-layout';

const DEFAULT_MAX_COLLECTION_ELEMENTS = 100_000;

type GeneratedModule = Pick<
  JSModule,
  | 'abi'
  | 'layout'
  | 'manifest'
  | 'requests'
  | 'evaluateBinding'
  | 'funcs'
  | 'main'
>;

/** Attach immutable host-neutral binding state to generated module code. */
export function createGeneratedModule(code: GeneratedModule): JSModule {
  const requests = code.requests.map(child =>
    'bindings' in child ? child : createGeneratedModule(child),
  );
  return moduleSnapshot(code, initialInputBindings(code), null, null, requests);
}

/** Initialize one freshly loaded request tree with its global parameter state. */
export function initializeModuleTree(module: JSModule): JSModule {
  const parameterValues =
    module.manifest.params.length === 0 ? Object.freeze([]) : null;
  return installParameterValues(module, parameterValues);
}

/** Return a module snapshot with new host-neutral input bindings. */
export function withModuleBindings(
  module: JSModule,
  bindings: readonly ModuleInputBinding[],
  parameterValues: readonly Value[] | null,
): JSModule {
  const requests = module.requests.map(child =>
    installParameterValues(child, parameterValues),
  );
  return completeModule(
    moduleSnapshot(module, bindings, parameterValues, null, requests),
  );
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
  return moduleSnapshot(
    module,
    module.bindings,
    module.parameterValues,
    module.binding,
    requests,
  );
}

/** Require the completed generated configuration of one module context. */
export function requireModuleBinding(module: JSModule): JSModuleBinding {
  if (module.binding === null) {
    throw new ModuleBindingEvaluationError(
      'JavaScript module has incomplete input bindings',
    );
  }
  return module.binding;
}

/** Ordered validated parameters exposed by execution hosts. */
export function boundInputs(module: JSModule): readonly BoundInput[] {
  const values = module.parameterValues;
  const binding = requireModuleBinding(module);
  if (values === null) {
    throw new ModuleBindingEvaluationError(
      'JavaScript module has no compilation-global parameter vector',
    );
  }
  return Object.freeze(
    module.manifest.params.map((spec, pid) =>
      Object.freeze({
        spec,
        value: values[pid]!,
        active: binding.activeParams[pid]!,
      }),
    ),
  );
}

/** Host output declaration after generated binding expressions are evaluated. */
export function moduleDeclaration(module: JSModule): ExecutionDeclaration {
  const binding = requireModuleBinding(module);
  return deepFreeze({
    outputs: module.manifest.outputs.map((spec, oid) => ({
      spec,
      boundArgs: binding.outputs[oid]!,
    })),
    effects: module.manifest.effects.map(effect => effect.declaration),
  });
}

export interface GeneratedBindingLayout {
  readonly frameHistoryCapacities: readonly (readonly number[])[];
  readonly inputs: readonly BoundInput[];
}

export class ModuleBindingEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleBindingEvaluationError';
  }
}

/** Apply one complete parameter vector to a generated root module. */
export function configureModule(
  code: JSModule,
  paramValues: readonly Value[],
  bindBuiltinValues: ReadonlyMap<number, Value> = new Map(),
): JSModule {
  return configure(code, paramValues, true, bindBuiltinValues);
}

/** Apply compilation-global parameters to one generated request child. */
export function configureChildModule(
  code: JSModule,
  paramValues: readonly Value[],
  bindBuiltinValues: ReadonlyMap<number, Value> = new Map(),
): JSModule {
  return configure(code, paramValues, false, bindBuiltinValues);
}

/**
 * Call the generated pure binding function with one already-resolved provider
 * context and project only the capacities required by GPU preparation.
 */
export function resolveGeneratedBindingLayout(
  code: JSModule,
  inputs: BindInputs,
  context: ProviderContext,
): GeneratedBindingLayout {
  if (code.abi !== RUNTIME_ABI_VERSION) {
    throw new BindError(
      `unsupported module ABI ${String(code.abi)}; expected ${RUNTIME_ABI_VERSION}`,
    );
  }
  bindTimeNow(inputs.timeNow);
  optionalBindLimit(inputs.maxRequestContexts, 'maxRequestContexts');
  optionalBindLimit(inputs.maxCollectionElements, 'maxCollectionElements');
  optionalBindLimit(inputs.maxHeapStorageCells, 'maxHeapStorageCells');
  optionalBindLimit(inputs.maxHeapLogicalBytes, 'maxHeapLogicalBytes');
  optionalBindLimit(
    inputs.maxHeapTransientStorageCells,
    'maxHeapTransientStorageCells',
  );
  optionalBindLimit(
    inputs.maxHeapTransientLogicalBytes,
    'maxHeapTransientLogicalBytes',
  );
  optionalBindLimit(
    inputs.maxFixedValueLogicalBytes,
    'maxFixedValueLogicalBytes',
  );
  if (!Number.isSafeInteger(context.rows) || context.rows < 0) {
    throw new BindError(
      `provider context row count must be a non-negative safe integer, got ${context.rows}`,
    );
  }
  validateContextIdentity(context);
  const params = resolveParamValues(code.manifest.params, inputs.params);
  const layouts = new ValueLayoutRegistry(code.layout);
  const builtinValues = validateProviderBuiltins(code, context, layouts);
  const series = providerSeries(code, params, context);
  const configured = configure(code, params, true, builtinValues);
  const binding = requireModuleBinding(configured);
  series.forEach((data, sid) => {
    if (data.length !== context.rows) {
      throw new BindError(
        `series ${sid} has ${data.length} rows, context has ${context.rows}`,
      );
    }
  });
  return Object.freeze({
    frameHistoryCapacities: Object.freeze(
      binding.retention.frames.map((frame, fid) =>
        Object.freeze(
          frame.map((retention, slot) => {
            const storage = code.manifest.frames[fid]?.locals[slot]?.storage;
            let capacity = Math.min(retention, context.rows);
            if (storage === Storage.Var || storage === Storage.Varip) {
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

function optionalBindLimit(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new BindError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function bindTimeNow(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new BindError('timeNow must be a finite safe epoch-ms integer');
  }
  return value;
}

function validateContextIdentity(context: ProviderContext): void {
  const symbol = context.builtinValue({domain: 'syminfo', field: 'tickerid'});
  const timeframe = context.builtinValue({
    domain: 'timeframe',
    field: 'period',
  });
  if (symbol !== undefined && symbol !== null && typeof symbol !== 'string') {
    throw new BindError(
      "provider builtin 'syminfo.tickerid' must be a string or typed empty",
    );
  }
  if (
    timeframe !== undefined &&
    timeframe !== null &&
    typeof timeframe !== 'string'
  ) {
    throw new BindError(
      "provider builtin 'timeframe.period' must be a string or typed empty",
    );
  }
}

function providerSeries(
  code: JSModule,
  params: readonly Value[],
  context: ProviderContext,
): readonly SeriesData[] {
  return code.manifest.series.map((spec, sid) => {
    let id = spec.id;
    if (id === null) {
      const parameter = code.manifest.params.find(
        param => param.seriesSid === sid,
      );
      if (parameter === undefined) {
        throw new ModuleBindingEvaluationError(
          `series slot ${sid} has neither host id nor parameter`,
        );
      }
      const value = params[code.manifest.params.indexOf(parameter)];
      if (typeof value !== 'string') {
        throw new BindError(
          `series parameter '${parameter.name}' is not a string`,
        );
      }
      id = value;
    }
    const data = context.series(id);
    if (data === null) {
      throw new BindError(`series '${id}' is not provided by this context`);
    }
    return data;
  });
}

function validateProviderBuiltins(
  code: JSModule,
  context: ProviderContext,
  layouts: ValueLayoutRegistry,
): ReadonlyMap<number, Value> {
  let axisValidated = false;
  const values = new Map<number, Value>();
  code.manifest.builtin.forEach((spec, bid) => {
    layouts.layout(spec.layout);
    const source = spec.source;
    if (source.domain === 'syminfo' || source.domain === 'timeframe') {
      const value = context.builtinValue(source);
      if (value === undefined) {
        throw new BindError(
          `builtin '${builtinSourceName(spec)}' is not provided by this context`,
        );
      }
      layouts.assertValue(
        spec.layout,
        value,
        `provider builtin '${builtinSourceName(spec)}'`,
      );
      values.set(bid, value);
      return;
    }
    if (
      source.domain === 'time' &&
      (source.field === 'time' || source.field === 'time_close')
    ) {
      const axis = context.axis;
      if (axis === null) {
        throw new BindError(
          `builtin '${source.field}' requires a time axis in this context`,
        );
      }
      if (!axisValidated) {
        assertMergeAxis(axis, context.rows, 'runtime context');
        axisValidated = true;
      }
    }
  });
  return values;
}

function builtinSourceName(spec: BuiltinSpec): string {
  const source = spec.source;
  switch (source.domain) {
    case 'time':
    case 'bar':
      return source.field;
    case 'barstate':
    case 'syminfo':
    case 'timeframe':
      return `${source.domain}.${source.field}`;
  }
}

function configure(
  code: JSModule,
  paramValues: readonly Value[],
  exactParams: boolean,
  bindBuiltinValues: ReadonlyMap<number, Value> = new Map(),
): JSModule {
  validateParamCount(code, paramValues, exactParams);
  const raw = code.evaluateBinding({
    params: paramValues,
    builtins: bindBuiltinValues,
  }) as unknown;
  validateBindingShape(code, raw);
  code.manifest.requests.forEach((spec, requestId) => {
    if (spec.dynamic) {
      throw new ModuleBindingEvaluationError(
        `dynamic request ${requestId} is unsupported`,
      );
    }
    if (code.requests[requestId] === undefined) {
      throw new ModuleBindingEvaluationError(
        `static request ${requestId} has no generated child module`,
      );
    }
  });
  const requests = code.requests.map(child =>
    installParameterValues(child, paramValues),
  );
  const bindings = code.bindings.map(input =>
    input.kind === 'series'
      ? Object.freeze({...input, supplied: true})
      : Object.freeze({
          ...input,
          value:
            paramValues[
              code.manifest.params.findIndex(spec => spec.name === input.name)
            ],
        }),
  );
  return moduleSnapshot(
    {...code, manifest: concreteManifest(code, raw.retention)},
    bindings,
    paramValues,
    raw,
    requests,
  );
}

/** @internal Loader injection; the operational callback has no exported type. */
export function evaluateGeneratedModule(
  code: JSModule,
  values: Parameters<JSModule['evaluateBinding']>[0],
  body: unknown,
): JSModuleBinding {
  if (typeof body !== 'function') {
    throw new ModuleBindingEvaluationError(
      'generated module binding body is not callable',
    );
  }
  const heap = new ArenaHeap();
  const transaction = heap.begin('module-binding');
  try {
    const layouts = new ValueLayoutRegistry(code.layout);
    const structs = new StructStorageRuntime(heap, layouts);
    const collections = new CollectionRuntime(
      heap,
      layouts,
      DEFAULT_MAX_COLLECTION_ELEMENTS,
      structs,
    );
    const evaluation = new ModuleBindEvaluation(
      code,
      values.params,
      transaction,
      structs,
      collections,
      values.builtins ?? new Map(),
    );
    const evaluate = body as (
      evaluation: ModuleBindEvaluation,
      root: Frame,
    ) => void;
    evaluate(evaluation, evaluation.root());
    return evaluation.finish();
  } finally {
    try {
      transaction.abort();
    } finally {
      heap.dispose();
    }
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

function validateBindingShape(
  code: JSModule,
  value: unknown,
): asserts value is JSModuleBinding {
  const binding = requireRecord(value, 'module binding');
  const retention = requireRecord(
    binding.retention,
    'module binding retention',
  );
  const frames = requireArray(retention.frames, 'frame retention');
  requireCount(frames, code.manifest.frames.length, 'frame retention');
  frames.forEach((value, fid) => {
    const frame = requireArray(value, `frame ${fid} retention`);
    requireCount(
      frame,
      code.manifest.frames[fid]!.locals.length,
      `frame ${fid} retention`,
    );
    frame.forEach((bars, slot) =>
      requireRetention(bars, `frame ${fid} slot ${slot}`),
    );
  });
  const vectors = [
    ['series', retention.series, code.manifest.series.length],
    ['builtin', retention.builtins, code.manifest.builtin.length],
    ['request', retention.requests, code.manifest.requests.length],
  ] as const;
  vectors.forEach(([label, value, count]) => {
    const values = requireArray(value, `${label} retention`);
    requireCount(values, count, `${label} retention`);
    values.forEach((bars, index) =>
      requireRetention(bars, `${label} ${index}`),
    );
  });
  const activeParams = requireArray(binding.activeParams, 'parameter activity');
  requireCount(activeParams, code.manifest.params.length, 'parameter activity');
  activeParams.forEach((active, pid) => {
    if (typeof active !== 'boolean') {
      throw new ModuleBindingEvaluationError(
        `parameter ${pid} active expression did not produce bool`,
      );
    }
  });
  const outputs = requireArray(binding.outputs, 'output binding');
  requireCount(outputs, code.manifest.outputs.length, 'output binding');
  outputs.forEach((value, oid) => {
    const args = requireArray(value, `output ${oid} binding`);
    args.forEach((value, index) => {
      const arg = requireRecord(value, `output ${oid} argument ${index}`);
      if (typeof arg.name !== 'string' || !('value' in arg)) {
        throw new ModuleBindingEvaluationError(
          `output ${oid} argument ${index} is invalid`,
        );
      }
    });
  });
  const requests = requireArray(binding.requests, 'request binding');
  requireCount(requests, code.manifest.requests.length, 'request binding');
  requests.forEach((value, rid) => {
    const request = requireRecord(value, `request ${rid} binding`);
    if (
      typeof request.symbol !== 'string' ||
      typeof request.timeframe !== 'string' ||
      typeof request.gaps !== 'boolean' ||
      typeof request.lookahead !== 'boolean' ||
      typeof request.ignoreInvalidSymbol !== 'boolean' ||
      typeof request.calcBarsCount !== 'number' ||
      !Number.isSafeInteger(request.calcBarsCount) ||
      request.calcBarsCount < 0
    ) {
      throw new ModuleBindingEvaluationError(
        `request ${rid} has invalid binding data`,
      );
    }
  });
}

function requireRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModuleBindingEvaluationError(`${label} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ModuleBindingEvaluationError(`${label} is not an array`);
  }
  return value;
}

function requireCount(
  values: readonly unknown[],
  expected: number,
  label: string,
): void {
  if (values.length !== expected) {
    throw new ModuleBindingEvaluationError(
      `${label} expected ${expected} entries, got ${values.length}`,
    );
  }
}

function requireRetention(bars: unknown, label: string): void {
  if (typeof bars !== 'number' || !Number.isSafeInteger(bars) || bars < 0) {
    throw new ModuleBindingEvaluationError(`${label} has invalid retention`);
  }
}

function initialInputBindings(
  code: Pick<JSModule, 'manifest'>,
): readonly ModuleInputBinding[] {
  const series = new Set<string>();
  return Object.freeze([
    ...code.manifest.params.map(
      (spec): ModuleInputBinding =>
        Object.freeze({kind: 'parameter', name: spec.name}),
    ),
    ...code.manifest.series.flatMap((spec): readonly ModuleInputBinding[] => {
      if (spec.id === null || series.has(spec.id)) return [];
      series.add(spec.id);
      return [Object.freeze({kind: 'series', name: spec.id, supplied: false})];
    }),
  ]);
}

function moduleSnapshot(
  code: GeneratedModule,
  bindings: readonly ModuleInputBinding[],
  parameterValues: readonly Value[] | null,
  binding: JSModuleBinding | null,
  requests: readonly JSModule[],
): JSModule {
  let module!: JSModule;
  module = {
    ...code,
    requests: Object.freeze([...requests]),
    bindings: Object.freeze(bindings.map(input => Object.freeze({...input}))),
    parameterValues:
      parameterValues === null ? null : Object.freeze([...parameterValues]),
    binding: binding === null ? null : deepFreeze(binding),
    ready: () => module.binding !== null,
    remaining: () =>
      Object.freeze(module.bindings.filter(input => !inputSupplied(input))),
  };
  return deepFreeze(module);
}

function inputSupplied(input: ModuleInputBinding): boolean {
  return input.kind === 'series'
    ? input.supplied
    : Object.hasOwn(input, 'value');
}

function installParameterValues(
  module: JSModule,
  parameterValues: readonly Value[] | null,
): JSModule {
  const requests = module.requests.map(child =>
    installParameterValues(child, parameterValues),
  );
  const snapshot = moduleSnapshot(
    module,
    module.bindings,
    parameterValues,
    null,
    requests,
  );
  return snapshot;
}

function completeModule(module: JSModule): JSModule {
  if (
    module.parameterValues === null ||
    module.bindings.some(input => !inputSupplied(input))
  ) {
    return module;
  }
  const configured = configure(
    module,
    module.parameterValues,
    module.manifest.params.length !== 0,
  );
  return moduleSnapshot(
    configured,
    module.bindings,
    module.parameterValues,
    configured.binding,
    configured.requests,
  );
}

const UNSET = Symbol('unset binding value');

class BindFrame implements Frame {
  readonly kind = 'frame' as const;
  readonly values: (Value | typeof UNSET)[];
  readonly subs: (BindFrame | null)[];

  constructor(
    readonly fid: number,
    localCount: number,
    subCount: number,
  ) {
    this.values = new Array(localCount).fill(UNSET);
    this.subs = new Array(subCount).fill(null);
  }
}

// Private evaluator captured by the loader-injected `$evaluate` function. It is
// neither the generated JSModule interface nor the per-step RuntimeContext ABI.
class ModuleBindEvaluation {
  private readonly rootFrame: BindFrame;
  private readonly localDepths: (number | null)[][];
  private readonly seriesDepths: (number | null)[];
  private readonly builtinDepths: (number | null)[];
  private readonly requestDepths: (number | null)[];
  private readonly paramActive: boolean[];
  private readonly outputArgs: {name: string; value: Value}[][];
  private readonly requestOptions: (Omit<
    JSModuleBinding['requests'][number],
    'symbol' | 'timeframe'
  > | null)[];
  private readonly requestPairs: ({
    readonly symbol: string;
    readonly timeframe: string;
  } | null)[];

  constructor(
    private readonly code: JSModule,
    private readonly paramValues: readonly Value[],
    private readonly transaction: HeapTransaction,
    private readonly structs: StructStorageRuntime,
    private readonly collections: CollectionRuntime,
    private readonly bindBuiltinValues: ReadonlyMap<number, Value>,
  ) {
    this.rootFrame = this.newFrame(0);
    this.localDepths = code.manifest.frames.map(frame =>
      frame.locals.map(local => staticRetention(local.depth)),
    );
    this.seriesDepths = code.manifest.series.map(series =>
      staticRetention(series.depth),
    );
    this.builtinDepths = code.manifest.builtin.map(builtin =>
      staticRetention(builtin.depth),
    );
    this.requestDepths = code.manifest.requests.map(request =>
      staticRetention(request.depth),
    );
    this.paramActive = code.manifest.params.map(() => true);
    this.outputArgs = code.manifest.outputs.map(() => []);
    this.requestOptions = code.manifest.requests.map(() => null);
    this.requestPairs = code.manifest.requests.map(() => null);
  }

  finish(): JSModuleBinding {
    const retention = deepFreeze({
      frames: this.localDepths.map((depths, fid) =>
        depths.map((depth, slot) =>
          requiredDepth(depth, `frame ${fid} slot ${slot}`),
        ),
      ),
      series: this.seriesDepths.map((depth, sid) =>
        requiredDepth(depth, `series ${sid}`),
      ),
      builtins: this.builtinDepths.map((depth, bid) =>
        requiredDepth(depth, `builtin ${bid}`),
      ),
      requests: this.requestDepths.map((depth, rid) =>
        requiredDepth(depth, `request ${rid}`),
      ),
    });

    const requests = this.code.manifest.requests.map((spec, requestId) => {
      if (spec.dynamic) {
        throw new ModuleBindingEvaluationError(
          `dynamic request ${requestId} is unsupported`,
        );
      }
      const pair = this.requestPairs[requestId];
      const options = this.requestOptions[requestId];
      const child = this.code.requests[requestId];
      if (pair === null || options === null || child === undefined) {
        throw new ModuleBindingEvaluationError(
          `static request ${requestId} has incomplete binding data`,
        );
      }
      return {
        ...pair,
        ...options,
      } satisfies JSModuleBinding['requests'][number];
    });

    return deepFreeze({
      retention,
      activeParams: this.paramActive,
      outputs: this.outputArgs,
      requests,
    });
  }

  root(): Frame {
    return this.rootFrame;
  }

  frame(frame: Frame, slot: number): Frame {
    const parent = this.requireFrame(frame);
    const spec = this.frameLayout(parent.fid).subs[slot];
    if (spec === undefined) {
      throw new ModuleBindingEvaluationError(
        `binding frame ${parent.fid} has no subframe slot ${slot}`,
      );
    }
    let child = parent.subs[slot];
    if (child === null) {
      child = this.newFrame(spec.fid);
      parent.subs[slot] = child;
    }
    return child;
  }

  param(pid: number): Value {
    const value = this.paramValues[pid];
    if (value === undefined) {
      throw new ModuleBindingEvaluationError(`unknown parameter ${pid}`);
    }
    return value;
  }

  read(frame: Frame, slot: number, offset: number): Value {
    if (offset !== 0) {
      return this.unsupported('history reads');
    }
    const owner = this.requireFrame(frame);
    const value = owner.values[slot];
    if (value === undefined || value === UNSET) {
      throw new ModuleBindingEvaluationError(
        `binding read of uninitialized frame ${owner.fid} slot ${slot}`,
      );
    }
    return value;
  }

  write(frame: Frame, slot: number, value: Value): void {
    const owner = this.requireLocal(frame, slot);
    owner.values[slot] = value;
  }

  historyDepth(offset: number): number {
    return retentionForOffset(offset);
  }

  bindDepth(fid: number, slot: number, bars: number): void {
    const depths = this.localDepths[fid];
    if (depths === undefined || depths[slot] === undefined) {
      throw new ModuleBindingEvaluationError(
        `bound depth targets unknown frame ${fid} slot ${slot}`,
      );
    }
    this.reportDepth(depths, slot, bars, `frame ${fid} slot ${slot}`);
  }

  bindSeriesDepth(sid: number, bars: number): void {
    this.reportDepth(this.seriesDepths, sid, bars, `series ${sid}`);
  }

  bindBuiltinDepth(bid: number, bars: number): void {
    this.reportDepth(this.builtinDepths, bid, bars, `builtin ${bid}`);
  }

  bindOutput(oid: number, argName: string, value: Value): void {
    const args = this.outputArgs[oid];
    if (args === undefined) {
      throw new ModuleBindingEvaluationError(`unknown output ${oid}`);
    }
    args.push(deepFreeze({name: argName, value}));
  }

  bindParamActive(pid: number, active: Value): void {
    if (this.paramActive[pid] === undefined) {
      throw new ModuleBindingEvaluationError(`unknown parameter ${pid}`);
    }
    if (typeof active !== 'boolean') {
      throw new ModuleBindingEvaluationError(
        `parameter ${pid} active expression did not produce bool`,
      );
    }
    this.paramActive[pid] = active;
  }

  bindRequestOptions(
    rid: number,
    gaps: Value,
    lookahead: Value,
    ignoreInvalidSymbol: Value,
    calcBarsCount: Value,
  ): void {
    if (this.requestOptions[rid] === undefined) {
      throw new ModuleBindingEvaluationError(`unknown request ${rid}`);
    }
    if (
      typeof gaps !== 'boolean' ||
      typeof lookahead !== 'boolean' ||
      typeof ignoreInvalidSymbol !== 'boolean' ||
      typeof calcBarsCount !== 'number' ||
      !Number.isSafeInteger(calcBarsCount) ||
      calcBarsCount < 0
    ) {
      throw new ModuleBindingEvaluationError(
        `request ${rid} has invalid bound options`,
      );
    }
    this.requestOptions[rid] = deepFreeze({
      gaps,
      lookahead,
      ignoreInvalidSymbol,
      calcBarsCount,
    });
  }

  bindRequest(rid: number, symbol: Value, timeframe: Value): void {
    const spec = this.code.manifest.requests[rid];
    if (spec === undefined) {
      throw new ModuleBindingEvaluationError(`unknown request ${rid}`);
    }
    if (spec.dynamic) {
      throw new ModuleBindingEvaluationError(
        `dynamic request ${rid} is unsupported`,
      );
    }
    if (typeof symbol !== 'string' || typeof timeframe !== 'string') {
      throw new ModuleBindingEvaluationError(
        `request ${rid} symbol and timeframe must bind to strings`,
      );
    }
    this.requestPairs[rid] = deepFreeze({symbol, timeframe});
  }

  builtin(bid: number, offset: number): Value {
    const spec = this.code.manifest.builtin[bid];
    if (spec === undefined) {
      throw new ModuleBindingEvaluationError(
        `builtin read from unknown input ${bid}`,
      );
    }
    if (
      offset === 0 &&
      (spec.source.domain === 'syminfo' ||
        spec.source.domain === 'timeframe') &&
      this.bindBuiltinValues.has(bid)
    ) {
      return this.bindBuiltinValues.get(bid) as Value;
    }
    throw new ModuleBindingEvaluationError(
      `builtin '${builtinSourceName(spec)}' is not bind-visible`,
    );
  }

  newStruct(layout: LayoutId, fields: readonly Value[]): Ref<unknown> {
    return this.structs.newStruct(this.transaction, layout, fields);
  }

  requireStruct(value: Value, layout: LayoutId): Ref<unknown> {
    return this.structs.requireStruct(value, layout, this.transaction);
  }

  structField(value: Value, layout: LayoutId, index: number): Value {
    return this.structs.field(value, layout, index, this.transaction);
  }

  storeStructField(
    value: Value,
    layout: LayoutId,
    index: number,
    replacement: Value,
  ): void {
    this.structs.storeField(
      this.transaction,
      value,
      layout,
      index,
      replacement,
    );
  }

  callCollection(
    operation: CollectionOperation,
    resultLayout: LayoutId,
    args: readonly Value[],
  ): Value {
    return this.collections.call(
      this.transaction,
      operation,
      resultLayout,
      args,
    );
  }

  mutateCollection(
    operation: CollectionMutationOperation,
    collectionLayout: LayoutId,
    receiver: Value,
    args: readonly Value[],
  ): CollectionMutation {
    return this.collections.mutate(
      this.transaction,
      operation,
      collectionLayout,
      receiver,
      args,
    );
  }

  collectionEntries(value: Value): CollectionEntries {
    return this.collections.entries(value, this.transaction);
  }

  private newFrame(fid: number): BindFrame {
    const layout = this.frameLayout(fid);
    return new BindFrame(fid, layout.locals.length, layout.subs.length);
  }

  private frameLayout(fid: number) {
    const layout = this.code.manifest.frames[fid];
    if (layout === undefined) {
      throw new ModuleBindingEvaluationError(`unknown frame ${fid}`);
    }
    return layout;
  }

  private requireFrame(frame: Frame): BindFrame {
    if (!(frame instanceof BindFrame)) {
      throw new ModuleBindingEvaluationError('foreign binding frame');
    }
    return frame;
  }

  private requireLocal(frame: Frame, slot: number): BindFrame {
    const owner = this.requireFrame(frame);
    if (this.frameLayout(owner.fid).locals[slot] === undefined) {
      throw new ModuleBindingEvaluationError(
        `binding frame ${owner.fid} has no local slot ${slot}`,
      );
    }
    return owner;
  }

  private reportDepth(
    depths: (number | null)[],
    index: number,
    bars: number,
    label: string,
  ): void {
    if (depths[index] === undefined) {
      throw new ModuleBindingEvaluationError(
        `bound depth targets unknown ${label}`,
      );
    }
    if (depths[index] !== null) {
      throw new ModuleBindingEvaluationError(
        `${label} does not have a bound depth`,
      );
    }
    depths[index] = retentionForOffset(bars);
  }

  private unsupported(capability: string): never {
    throw new ModuleBindingEvaluationError(
      `binding expression requires ${capability}, which is unavailable before runtime`,
    );
  }
}

function staticRetention(depth: DepthSpec): number | null {
  switch (depth.kind) {
    case 'none':
      return 0;
    case 'const':
    case 'capped':
      return retentionForOffset(depth.bars);
    case 'bound':
      return null;
  }
}

function retentionForOffset(offset: number): number {
  return isHistoryOffset(offset) ? offset : 0;
}

function requiredDepth(depth: number | null, label: string): number {
  if (depth === null) {
    throw new ModuleBindingEvaluationError(
      `${label} did not report its bound history depth`,
    );
  }
  return depth;
}

function concreteManifest(
  code: JSModule,
  retention: JSModuleBinding['retention'],
): JSModule['manifest'] {
  return deepFreeze({
    ...code.manifest,
    frames: code.manifest.frames.map((frame, fid) => ({
      ...frame,
      locals: frame.locals.map((local, slot) => ({
        ...local,
        depth: concreteDepth(local.depth, retention.frames[fid]![slot]!),
      })),
    })),
    series: code.manifest.series.map((series, sid) => ({
      ...series,
      depth: concreteDepth(series.depth, retention.series[sid]!),
    })),
    builtin: code.manifest.builtin.map((builtin, bid) => ({
      ...builtin,
      depth: concreteDepth(builtin.depth, retention.builtins[bid]!),
    })),
    requests: code.manifest.requests.map((request, rid) => ({
      ...request,
      depth: concreteDepth(request.depth, retention.requests[rid]!),
    })),
  });
}

function concreteDepth(original: DepthSpec, bars: number): DepthSpec {
  return original.kind === 'bound' ? {kind: 'const', bars} : original;
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
