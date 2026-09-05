// One parameter-binding implementation for compiled modules, independent of stream ownership.

import {DataType, Field, Float64, Schema, util} from 'apache-arrow';
import {cloneSchema, decodeSchema} from './io';
import {BindError} from './errors';
import {resolveParamValues} from './params';
import {
  isHistoryOffset,
  RUNTIME_ABI_VERSION,
  type DepthSpec,
  type JSModule,
  type RequestSpec,
} from './module-abi';
import type {BoundInput} from './binding';
import {outputFields, publicationSchema} from './output';
import type {Scalar} from './value';
import {ValueLayoutRegistry} from './value-layout';

const coordinates = cloneSchema(publicationSchema([])).fields;

type GeneratedModule = Omit<
  JSModule,
  'bind' | 'ready' | 'remaining' | 'requests'
> & {
  bind(
    module: Omit<JSModule, 'bind' | 'ready' | 'remaining'>,
    context: ReadonlyMap<number, Scalar>,
  ): void;
  readonly requests: readonly (Omit<RequestSpec, 'module'> & {
    readonly module: GeneratedModule;
  })[];
};

const calculation = Symbol('binding calculation');
type Module = JSModule & {[calculation]: GeneratedModule['bind']};

/**
 * Load one mutable compiled module. Its private generated arithmetic is shared
 * as code; parameters, requirements and request contexts belong to this object.
 * @example `const module = initializeModule(raw); module.bind({length: 10})`
 * returns that same module with its history requirements updated.
 */
export function initializeModule(raw: GeneratedModule): JSModule {
  currentAbi(raw);
  const data = copyData(raw as unknown as JSModule);
  data.requests = data.requests.map((request, id) => ({
    ...request,
    module: initializeModule(raw.requests[id].module),
  }));
  return assemble(data, raw.bind);
}

// Draft only binding facts, sharing schemas and code. No module is replaced.
// A failed calculation discards the drafts before any object in the tree changes.
function bind(
  this: JSModule,
  values: Readonly<Record<string, unknown>> = {},
  context: ReadonlyMap<number, Scalar> = new Map(),
): JSModule {
  const pending: [JSModule, ReturnType<typeof copyData>][] = [];
  const visit = (
    target: JSModule,
    values: Readonly<Record<string, unknown>>,
    context: ReadonlyMap<number, Scalar>,
  ): void => {
    if (Object.isFrozen(target))
      throw new BindError('module binding is closed after execution starts');
    if (
      values === null ||
      typeof values !== 'object' ||
      Array.isArray(values)
    ) {
      throw new BindError('parameters must be a named object');
    }
    if (
      context === null ||
      typeof context.size !== 'number' ||
      typeof context[Symbol.iterator] !== 'function'
    ) {
      throw new BindError('fixed context must be a map');
    }
    const data = copyData(target, false);
    const known = new Set(data.parameters.map(parameter => parameter.name));
    for (const name of Object.keys(values)) {
      if (!known.has(name)) throw new BindError(`unknown parameter '${name}'`);
    }
    data.parameters.forEach(parameter => {
      const supplied = Object.hasOwn(values, parameter.name);
      const existing = Object.hasOwn(parameter, 'value');
      const candidate = supplied
        ? values[parameter.name]
        : existing
          ? parameter.value
          : parameter.defaultValue;
      if (!supplied && !existing && candidate === null) return;
      if (candidate === undefined)
        throw new BindError(`parameter '${parameter.name}' is undefined`);
      const value = resolveParamValues([parameter], {
        [parameter.name]: candidate,
      })[0] as Scalar;
      // Generated arithmetic may update active/settings/depths, never the
      // validated input values from which those facts were calculated.
      Object.defineProperty(parameter, 'value', {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    });
    if (context.size > 0) {
      const layouts = new ValueLayoutRegistry(data.state.layout);
      for (const [id, value] of context) {
        const builtin = data.inputs.builtins[id];
        if (!Number.isSafeInteger(id) || builtin?.constant !== true) {
          throw new BindError(`builtin ${id} is not a fixed binding input`);
        }
        if (!scalar(value))
          throw new BindError(`builtin ${id} requires a scalar value`);
        const layout = layouts.layout(builtin.layout);
        if (
          layout.kind === 'number' &&
          layout.numeric === 'int' &&
          typeof value === 'number' &&
          !Number.isNaN(value) &&
          !Number.isSafeInteger(value)
        ) {
          throw new BindError(
            `builtin ${id} expects a safe integer or numeric na`,
          );
        }
        try {
          layouts.assertValue(builtin.layout, value, `binding builtin ${id}`);
        } catch (error) {
          throw new BindError(
            error instanceof Error ? error.message : String(error),
          );
        }
        Object.assign(builtin, {value});
      }
    }
    const parameters = Object.fromEntries(
      data.parameters.flatMap(parameter =>
        Object.hasOwn(parameter, 'value')
          ? [[parameter.name, parameter.value]]
          : [],
      ),
    );
    for (const request of data.requests)
      visit(request.module, parameters, new Map());
    const constants = new Map(
      data.inputs.builtins.flatMap((builtin, id) =>
        Object.hasOwn(builtin, 'value') ? [[id, builtin.value!] as const] : [],
      ),
    );
    for (const [id, value] of constants) {
      Object.defineProperty(data.inputs.builtins[id], 'value', {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    try {
      (target as Module)[calculation](data, constants);
    } catch (error) {
      // Generated code resets late facts first. Missing context can therefore
      // remain pending without ever preserving stale, apparently ready facts.
      if (
        !(
          error instanceof Error &&
          /^builtin '.+' is not bind-visible$/.test(error.message) &&
          !concrete(data)
        )
      )
        throw error;
    }
    if (
      data.parameters.length !== target.parameters.length ||
      data.state.frames.length !== target.state.frames.length ||
      data.inputs.series.length !== target.inputs.series.length ||
      data.inputs.builtins.length !== target.inputs.builtins.length ||
      data.outputs.declarations.length !== target.outputs.declarations.length ||
      data.requests.length !== target.requests.length
    ) {
      throw new BindError('generated binding changed module structure');
    }
    depths(data).forEach((depth, id) => {
      if (depth.kind !== 'bound') depthBars(depth, `history ${id}`);
    });
    data.requests.forEach((request, id) => {
      if (request.context != null) validateContext(request, id);
    });
    const fields = new Map(
      data.inputs.schema.fields.map(field => [field.name, field]),
    );
    const names = [
      ...new Set(
        data.inputs.series.flatMap((_, id) => {
          const name = seriesName(data, id);
          return name === null ? [] : [name];
        }),
      ),
    ];
    data.inputs.schema = new Schema(
      names.map(
        name => fields.get(name) ?? new Field(name, new Float64(), false),
      ),
      data.inputs.schema.metadata,
    );
    pending.push([target, data]);
  };
  visit(this, values, context);
  for (const [module, data] of pending) Object.assign(module, data);
  return this;
}

/**
 * Create an independent configuration for another execution, copying Arrow
 * metadata and request children while sharing executable code and descriptors.
 * Ordinary binding and Node inspection do not call this function.
 * @example GPU jobs use `cloneModule(template).bind(job.params)` so each job
 * has its own mutable configuration.
 */
export function cloneModule(module: JSModule): JSModule {
  currentAbi(module);
  const data = copyData(module);
  data.requests = data.requests.map(request => ({
    ...request,
    module: cloneModule(request.module),
  }));
  return assemble(data, (module as Module)[calculation]);
}

function copyData(module: JSModule, copySchemas = true) {
  const {schema, series, builtins} = module.inputs;
  return {
    abi: module.abi,
    inputs: {
      schema: copySchemas ? readSchema(schema) : schema,
      series: structuredClone(series),
      builtins: structuredClone(builtins),
    },
    parameters: structuredClone(module.parameters),
    state: {
      layout: module.state.layout,
      frames: structuredClone(module.state.frames),
    },
    outputs: {
      schema: copySchemas
        ? readSchema(module.outputs.schema)
        : module.outputs.schema,
      declarations: structuredClone(module.outputs.declarations),
    },
    requests: module.requests.map(({module: child, ...request}) => ({
      ...structuredClone(request),
      module: child,
    })),
    funcs: module.funcs,
    main: module.main,
  };
}

function readSchema(schema: Schema): Schema {
  return schema instanceof Schema
    ? cloneSchema(schema)
    : decodeSchema(schema as unknown as number[]);
}

function assemble(
  data: ReturnType<typeof copyData>,
  calculate: GeneratedModule['bind'],
): JSModule {
  if (typeof calculate !== 'function')
    throw new BindError('module has no binding code');
  freeze(data.state.layout);
  return {
    ...data,
    [calculation]: calculate,
    bind,
    ready() {
      return this.remaining().length === 0 && concrete(this);
    },
    remaining() {
      return this.parameters
        .filter(parameter => !Object.hasOwn(parameter, 'value'))
        .map(parameter => parameter.name);
    },
  } as Module;
}

function concrete(
  module: Omit<JSModule, 'bind' | 'ready' | 'remaining'>,
): boolean {
  return (
    module.parameters.every(
      parameter => typeof parameter.active === 'boolean',
    ) &&
    depths(module).every(depth => depth.kind !== 'bound') &&
    module.outputs.declarations.every(output => output.args !== null) &&
    module.requests.every(request => request.context != null)
  );
}

function depths(
  module: Pick<JSModule, 'inputs' | 'state' | 'requests'>,
): readonly DepthSpec[] {
  return [
    ...module.state.frames.flatMap(frame =>
      frame.locals.map(local => local.depth),
    ),
    ...module.inputs.series.map(series => series.depth),
    ...module.inputs.builtins.map(builtin => builtin.depth),
    ...module.requests.map(request => request.depth),
  ];
}

function seriesName(
  module: Pick<JSModule, 'inputs' | 'parameters'>,
  id: number,
): string | null {
  const series = module.inputs.series[id];
  if (series.id !== null) return series.id;
  const parameter = module.parameters.find(
    parameter => parameter.seriesSid === id,
  );
  return typeof parameter?.value === 'string' ? parameter.value : null;
}

/**
 * Read one required source name per runtime series slot. Availability belongs to
 * Node, so this function never reports or changes a supplied marker.
 * @example `moduleSeriesNames(module)` is `['close']` for `plot(close)`.
 */
export function moduleSeriesNames(module: JSModule): readonly string[] {
  return module.inputs.series.map((_, id) => {
    const name = seriesName(module, id);
    if (name === null)
      throw new BindError(`series slot ${id} has no bound source name`);
    return name;
  });
}

/**
 * Validate concrete execution requirements without inventing stream readiness.
 * @example A bound `plot(close)` module passes even before a Node connects close;
 * Node.ready() is the separate stream/graph gate.
 */
export function requireConcreteModule(module: JSModule): JSModule {
  if (!module.ready())
    throw new BindError('module configuration is incomplete');
  depths(module).forEach((depth, id) => depthBars(depth, `history ${id}`));
  const fields = outputFields(module.outputs.schema);
  const schema = module.outputs.schema;
  if (
    schema.fields.length !== coordinates.length + fields.length ||
    new Set(schema.fields.map(field => field.name)).size !==
      schema.fields.length ||
    coordinates.some((field, i) => !util.compareFields(field, schema.fields[i]))
  ) {
    throw new BindError('invalid output coordinates');
  }
  if (fields.length !== module.outputs.declarations.length)
    throw new BindError('output fields and declarations disagree');
  fields.forEach((field, id) => {
    const count = module.outputs.declarations[id].layouts.length;
    if (field.metadata.get('tea:write') === 'set') {
      if (
        !field.nullable ||
        !DataType.isStruct(field.type) ||
        field.type.children.length !== count
      ) {
        throw new BindError(
          `output '${field.name}' requires a nullable record`,
        );
      }
    } else if (field.metadata.get('tea:write') === 'append') {
      const item = field.type.children?.[0];
      if (
        field.nullable ||
        !DataType.isList(field.type) ||
        item?.nullable !== false ||
        !DataType.isStruct(item.type) ||
        item.type.children.length !== 2 ||
        count !== 1 ||
        !util.compareFields(
          coordinates[0].clone({name: 'ordinal'}),
          item.type.children[0],
        ) ||
        item.type.children[1].name !== 'payload'
      ) {
        throw new BindError(
          `output '${field.name}' requires an ordinal/payload event list`,
        );
      }
    } else throw new BindError(`output '${field.name}' has no write mode`);
  });
  const layouts = new ValueLayoutRegistry(module.state.layout);
  module.requests.forEach((request, id) => {
    const layout = layouts.layout(request.layout);
    layouts.layout(request.resultLayout);
    if (
      (request.mode === 'sample' && request.layout !== request.resultLayout) ||
      (request.mode === 'collect' &&
        (layout.kind !== 'array' || layout.element !== request.resultLayout))
    ) {
      throw new BindError(
        `request ${id} has inconsistent ${request.mode} layouts`,
      );
    }
    validateContext(request, id);
  });
  return module;
}

/**
 * Project bound parameter values for reports; this is a view, not a second owner.
 * @example `boundInputs(module)[0].value` is 20 after module.bind({length: 20}).
 */
export function boundInputs(module: JSModule): readonly BoundInput[] {
  requireConcreteModule(module);
  return module.parameters.map(({value, active, ...spec}) =>
    freeze({spec, value: value!, active: active!}),
  );
}

/**
 * Return a concrete retention count, rejecting unresolved or invalid values.
 * @example `depthBars({kind: 'const', bars: 4})` returns 4.
 */
export function depthBars(depth: DepthSpec, label = 'depth'): number {
  if (depth.kind === 'none') return 0;
  if (depth.kind === 'bound' || !isHistoryOffset(depth.bars))
    throw new BindError(`${label} is not a concrete history depth`);
  return depth.bars;
}

function validateContext(request: RequestSpec, id: number): void {
  const context = request.context;
  if (
    context == null ||
    typeof context.symbol !== 'string' ||
    typeof context.timeframe !== 'string' ||
    !['start', 'end'].includes(context.availability) ||
    !['carry', 'sparse'].includes(context.fill) ||
    typeof context.ignoreInvalidSymbol !== 'boolean' ||
    !Number.isSafeInteger(context.calcBarsCount) ||
    context.calcBarsCount < 0
  ) {
    throw new BindError(`request ${id} has invalid concrete context`);
  }
}

function currentAbi(module: Pick<JSModule, 'abi'>): void {
  if (module.abi !== RUNTIME_ABI_VERSION)
    throw new BindError(
      `unsupported module ABI ${module.abi}; expected ${RUNTIME_ABI_VERSION}`,
    );
}

function scalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' &&
      (Number.isFinite(value) || Number.isNaN(value)))
  );
}

function freeze<T>(value: T): T {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    Object.isFrozen(value)
  )
    return value;
  for (const property of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (property.enumerable && 'value' in property) freeze(property.value);
  }
  return Object.freeze(value);
}
