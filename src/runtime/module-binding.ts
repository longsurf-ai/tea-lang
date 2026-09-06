// One parameter-binding implementation for compiled modules, independent of stream ownership.

import {DataType, Field, Float64, Schema, util} from 'apache-arrow';
import {cloneSchema} from './io';
import {BindError} from './errors';
import {resolveParamValues} from './params';
import {
  isHistoryOffset,
  RUNTIME_ABI_VERSION,
  type Depth,
  type Request,
} from './module-abi';
import {outputFields, outputSchema} from './output';
import type {Scalar} from './value';
import {StorageTypes, type StorageType} from './storage-types';
import type {Context} from './js/context';
import type {Parameter} from './params';
import type {Builtin, FrameLayout} from './module-abi';

const coordinates = cloneSchema(outputSchema([])).fields;

/**
 * A compiled program's configuration and ordinary TypeScript entry function.
 * Binding changes this object atomically; execution state belongs to Context.
 * @example `const configured = program.bind({length: 20}); configured === program`.
 * Use `program.clone()` for a separate run with different parameters.
 */
export class Module<C extends Context = Context> {
  declare readonly abi: typeof RUNTIME_ABI_VERSION;
  declare readonly inputs: {
    readonly schema: Schema;
    readonly series: readonly {
      readonly name?: string;
      readonly id: string | null;
      readonly depth: Depth;
    }[];
    readonly builtins: readonly Builtin[];
  };
  declare readonly parameters: readonly (Parameter & {
    readonly value?: Scalar;
    readonly active: boolean | null;
  })[];
  /** Static storage descriptions, not live execution state. */
  declare readonly state: {
    readonly layout: readonly StorageType[];
    readonly frames: readonly FrameLayout[];
  };
  /** The schema is the sole owner of output fields, names and write modes. */
  declare readonly outputs: {
    readonly schema: Schema;
    readonly declarations: readonly {
      /** Private storage descriptor used to detach each written value. */
      readonly layout: number;
    }[];
  };
  declare readonly requests: readonly Request[];

  private readonly execute: (context: Context) => void;

  constructor(
    data: Pick<
      Module,
      'abi' | 'inputs' | 'parameters' | 'state' | 'outputs' | 'requests'
    >,
    execute: (context: C) => void,
    private readonly calculate: (
      data: ReturnType<typeof copyData>,
      constants: ReadonlyMap<number, Scalar>,
    ) => void = () => {},
  ) {
    this.execute = execute as (context: Context) => void;
    currentAbi(data);
    Object.assign(this, copyData(data));
    freeze(this.state.layout);
  }

  /** Validate a patch and update this module tree only after all calculations pass. */
  bind(
    values: Readonly<Record<string, unknown>> = {},
    context: ReadonlyMap<number, Scalar> = new Map(),
  ): this {
    const pending: [Module, ReturnType<typeof copyData>][] = [];
    const visit = (
      target: Module,
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
        if (!known.has(name))
          throw new BindError(`unknown parameter '${name}'`);
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
        const layouts = new StorageTypes(data.state.layout);
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
          Object.hasOwn(builtin, 'value')
            ? [[id, builtin.value!] as const]
            : [],
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
        (target as Module).calculate(data, constants);
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
        data.outputs.declarations.length !==
          target.outputs.declarations.length ||
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

  /** Configuration readiness; Node separately verifies connected source streams. */
  ready(): boolean {
    return this.remaining().length === 0 && concrete(this);
  }
  remaining(): readonly string[] {
    return this.parameters
      .filter(parameter => !Object.hasOwn(parameter, 'value'))
      .map(parameter => parameter.name);
  }
  main(context: C): void {
    this.execute(context);
  }

  /** Copy configuration and Arrow metadata for an independent execution. */
  clone(): Module<C> {
    const requests = this.requests.map(request => ({
      ...request,
      module: request.module.clone(),
    }));
    return new Module<C>({...this, requests}, this.execute, this.calculate);
  }
}

function copyData(
  module: Pick<
    Module,
    'abi' | 'inputs' | 'parameters' | 'state' | 'outputs' | 'requests'
  >,
  copySchemas = true,
) {
  const {schema, series, builtins} = module.inputs;
  return {
    abi: module.abi,
    inputs: {
      schema: copySchemas ? cloneSchema(schema) : schema,
      series: series.map(series => ({...structuredClone(series)})),
      builtins: builtins.map(builtin => ({...structuredClone(builtin)})),
    },
    parameters: module.parameters.map(parameter => ({
      ...structuredClone(parameter),
    })),
    state: {
      layout: module.state.layout,
      frames: module.state.frames.map(frame => ({
        ...frame,
        locals: frame.locals.map(local => ({...structuredClone(local)})),
        subs: frame.subs.map(child => ({...child})),
      })),
    },
    outputs: {
      schema: copySchemas
        ? cloneSchema(module.outputs.schema)
        : module.outputs.schema,
      declarations: module.outputs.declarations.map(output => ({
        ...structuredClone(output),
      })),
    },
    requests: module.requests.map(({module: child, ...request}) => ({
      ...structuredClone(request),
      module: child,
    })),
  };
}

function concrete(
  module: Pick<
    Module,
    'parameters' | 'state' | 'inputs' | 'outputs' | 'requests'
  >,
): boolean {
  return (
    module.parameters.every(
      parameter => typeof parameter.active === 'boolean',
    ) &&
    depths(module).every(depth => depth.kind !== 'bound') &&
    module.requests.every(request => request.context != null)
  );
}

function depths(
  module: Pick<Module, 'inputs' | 'state' | 'requests'>,
): readonly Depth[] {
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
  module: Pick<Module, 'inputs' | 'parameters'>,
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
export function moduleSeriesNames(module: Module): readonly string[] {
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
export function requireConcreteModule(module: Module): Module {
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
  const layouts = new StorageTypes(module.state.layout);
  fields.forEach((field, id) => {
    if (field.metadata.get('tea:write') === 'set') {
      if (!field.nullable) {
        throw new BindError(
          `output '${field.name}' requires a nullable set field`,
        );
      }
    } else if (field.metadata.get('tea:write') === 'append') {
      if (field.nullable || !DataType.isList(field.type)) {
        throw new BindError(
          `output '${field.name}' requires a non-nullable append list`,
        );
      }
    } else throw new BindError(`output '${field.name}' has no write mode`);
    layouts.layout(module.outputs.declarations[id].layout);
  });
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
 * Return a concrete retention count, rejecting unresolved or invalid values.
 * @example `depthBars({kind: 'const', bars: 4})` returns 4.
 */
export function depthBars(depth: Depth, label = 'depth'): number {
  if (depth.kind === 'none') return 0;
  if (depth.kind === 'bound' || !isHistoryOffset(depth.bars))
    throw new BindError(`${label} is not a concrete history depth`);
  return depth.bars;
}

function validateContext(request: Request, id: number): void {
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

function currentAbi(module: Pick<Module, 'abi'>): void {
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
