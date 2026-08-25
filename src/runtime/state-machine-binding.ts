// Purpose: Temporary fixed-historical BoundProgram adapter over the
// state-owning step runtime. This preserves legacy host call sites while
// StateMachineRuntime.step remains the only execution semantic core.

import {Effect} from 'effect';
import {fatal} from '../base/print';
import type {BuiltinSource} from '../ir/builtin';
import type {BindInputs, BoundInput, BoundProgram} from './binding';
import {BindError, ExecutionError, RequestError} from './errors';
import {assertMergeAxis, sampleMergeMap} from './merge';
import {
  ModuleBindingEvaluationError,
  evaluateChildModuleBinding,
  evaluateModuleBinding,
  type BoundModuleFacts,
  type StaticRequestBinding,
} from './module-binding';
import {
  RUNTIME_ABI_VERSION,
  type BuiltinSpec,
  type ModuleCode,
  type TeaModule,
} from './module-abi';
import type {RowPublication} from './output';
import {resolveParamValues} from './params';
import {
  isContextError,
  type ProviderContext,
  type RangeDemand,
  type SeriesData,
} from './provider';
import {
  StateMachineRuntime,
  type StateMachineRuntimeOptions,
  type StepResult,
} from './state-machine-runtime';
import {isTupleValue, type Value} from './value';
import {
  type AggregateLayoutManifest,
  type LayoutId,
  ValueLayoutRegistry,
} from './value-layout';

const FULL_RANGE = {kind: 'full'} as const;
const DEFAULT_MAX_COLLECTION_ELEMENTS = 100_000;
const DEFAULT_MAX_REQUEST_CONTEXTS = 40;

interface RequestView {
  at(row: number): Value;
}

interface RequestEnvironment {
  readonly provider: BindInputs['provider'];
  readonly params: readonly Value[];
  readonly layouts: ValueLayoutRegistry;
  readonly aggregateLayouts: AggregateLayoutManifest;
  readonly timeNow: number;
  readonly maxCollectionElements: number;
  readonly heapLimits: StateMachineRuntimeOptions['heapLimits'];
  readonly contextBudget: {used: number; readonly max: number};
}

/** Bind the migration runtime to one finite provider context. */
export async function bindStateMachine(
  module: TeaModule,
  inputs: BindInputs,
): Promise<BoundProgram> {
  if (module.abi !== RUNTIME_ABI_VERSION) {
    throw new BindError(
      `unsupported module ABI ${String(module.abi)}; expected ${RUNTIME_ABI_VERSION}`,
    );
  }
  const timeNow = bindTimeNow(inputs.timeNow);
  const maxCollectionElements =
    optionalLimit(inputs.maxCollectionElements, 'maxCollectionElements') ??
    DEFAULT_MAX_COLLECTION_ELEMENTS;
  const maxRequestContexts =
    optionalLimit(inputs.maxRequestContexts, 'maxRequestContexts') ??
    DEFAULT_MAX_REQUEST_CONTEXTS;
  if (inputs.maxFixedValueLogicalBytes !== undefined) {
    throw new BindError(
      'state-machine compatibility binding does not support maxFixedValueLogicalBytes',
    );
  }

  const params = resolveParamValues(module.manifest.params, inputs.params);
  let facts: BoundModuleFacts;
  try {
    facts = evaluateModuleBinding(module, params);
  } catch (error) {
    if (error instanceof ModuleBindingEvaluationError) {
      throw new BindError(error.message);
    }
    throw error;
  }
  const context = await inputs.provider.resolveContext(
    inputs.symbol ?? '',
    inputs.timeframe ?? '',
    FULL_RANGE,
  );
  if (isContextError(context)) {
    throw new BindError(
      `primary context: ${context.error} (${context.detail})`,
    );
  }
  validateRows(context);

  const layouts = new ValueLayoutRegistry(facts.code.aggregateLayouts);
  const heapLimits = {
    maxStorageCells: optionalLimit(
      inputs.maxHeapStorageCells,
      'maxHeapStorageCells',
    ),
    maxLogicalBytes: optionalLimit(
      inputs.maxHeapLogicalBytes,
      'maxHeapLogicalBytes',
    ),
    maxTransientStorageCells: optionalLimit(
      inputs.maxHeapTransientStorageCells,
      'maxHeapTransientStorageCells',
    ),
    maxTransientLogicalBytes: optionalLimit(
      inputs.maxHeapTransientLogicalBytes,
      'maxHeapTransientLogicalBytes',
    ),
  };
  const environment: RequestEnvironment = {
    provider: inputs.provider,
    params,
    layouts,
    aggregateLayouts: facts.code.aggregateLayouts,
    timeNow,
    maxCollectionElements,
    heapLimits,
    contextBudget: {used: 0, max: maxRequestContexts},
  };
  const series = bindSeries(facts, params, context);
  const builtins = bindBuiltins(facts, context, layouts, timeNow);
  const requests = await bindStaticRequests(facts, context, environment);
  const runtime = new StateMachineRuntime(
    facts.code,
    facts.params.map(param => param.value),
    layouts,
    {
      maxCollectionElements,
      heapLimits,
    },
  );

  try {
    inputs.sink.declare(facts.declaration);
    return new FixedHistoricalStateMachineBinding(
      runtime,
      facts.params,
      context,
      series,
      builtins,
      requests,
      inputs.sink,
    );
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}

class FixedHistoricalStateMachineBinding implements BoundProgram {
  readonly rows: number;
  readonly inputs: readonly BoundInput[];
  private committedRows = 0;
  private pending: {readonly row: number; readonly result: StepResult} | null =
    null;
  private disposed = false;
  private terminalSinkFailure: unknown | null = null;

  constructor(
    private readonly runtime: StateMachineRuntime,
    inputs: readonly BoundInput[],
    private readonly context: ProviderContext,
    private readonly series: readonly SeriesData[],
    private readonly builtins: readonly ((row: number) => Value)[],
    private readonly requests: readonly RequestView[],
    private readonly sink: BindInputs['sink'],
  ) {
    this.rows = context.rows;
    this.inputs = inputs;
  }

  executeRow(row: number, provisional: boolean): void {
    this.assertLive();
    if (row !== this.committedRows) {
      return fatal(
        `executeRow(${row}) out of order: next committable row is ${this.committedRows}`,
      );
    }
    if (this.pending !== null) {
      return fatal('executeRow before the prior final execution was committed');
    }
    const result = Effect.runSync(
      this.runtime.step({
        series: this.series.map((value, sid) => {
          const current = value.at(row);
          if (!Number.isFinite(current) && !Number.isNaN(current)) {
            return fatal(
              `provider series ${sid} returned a non-finite value at row ${row}`,
            );
          }
          return current;
        }),
        builtins: this.builtins.map(value => value(row)),
        requests: this.requests.map(value => value.at(row)),
        provisional,
      }),
    );
    if (!provisional) {
      this.pending = {row, result};
      return;
    }
    this.publish(row, result);
  }

  commitRow(row: number): void {
    this.assertLive();
    const pending = this.pending;
    if (pending === null || pending.row !== row || row !== this.committedRows) {
      return fatal(`commitRow(${row}) without a matching execute`);
    }
    this.pending = null;
    this.committedRows = row + 1;
    this.publish(row, pending.result);
  }

  async resolvePending(): Promise<void> {
    this.assertLive();
  }

  async runAll(): Promise<void> {
    this.assertLive();
    if (this.pending !== null) {
      return fatal('runAll with a pending final execution');
    }
    while (this.committedRows < this.rows) {
      const row = this.committedRows;
      this.executeRow(row, false);
      this.commitRow(row);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = null;
    this.runtime.dispose();
  }

  private publish(row: number, result: StepResult): void {
    const effects =
      this.sink.capabilities?.effects === 'none' ? [] : result.effects;
    const finalDenseOnly = this.sink.capabilities?.denseRows === 'final';
    const outputs =
      finalDenseOnly && row !== this.rows - 1 ? [] : result.output;
    if (finalDenseOnly && row !== this.rows - 1 && effects.length === 0) {
      return;
    }
    const publication: RowPublication = {
      row,
      ...(this.context.axis === null
        ? {}
        : {time: this.context.axis.time(row)}),
      outputs,
      effects,
      provisional: result.provisional,
    };
    try {
      this.sink.publish(publication);
    } catch (error) {
      this.terminalSinkFailure = error;
      throw error;
    }
  }

  private assertLive(): void {
    if (this.disposed) fatal('runtime is disposed');
    if (this.terminalSinkFailure !== null) throw this.terminalSinkFailure;
  }
}

async function bindStaticRequests(
  facts: BoundModuleFacts,
  parent: ProviderContext,
  environment: RequestEnvironment,
): Promise<readonly RequestView[]> {
  if (facts.requests.length === 0) return [];
  if (parent.axis === null) {
    throw new BindError(
      "requests require a time axis on the primary context (a csv context needs a 'time' column)",
    );
  }
  assertMergeAxis(parent.axis, parent.rows, 'primary context');
  const views: RequestView[] = new Array(facts.code.manifest.requests.length);
  for (const binding of facts.requests) {
    views[binding.requestId] = await bindStaticRequest(
      binding,
      facts,
      parent,
      environment,
    );
  }
  return views;
}

async function bindStaticRequest(
  binding: StaticRequestBinding,
  parentFacts: BoundModuleFacts,
  parent: ProviderContext,
  environment: RequestEnvironment,
): Promise<RequestView> {
  const spec = parentFacts.code.manifest.requests[binding.requestId];
  if (spec === undefined || spec.dynamic) {
    throw new BindError(
      `dynamic request ${binding.requestId} is unsupported by fixed historical binding`,
    );
  }
  assertRequestTransportLayout(environment.layouts, spec.layout);
  const what = `request '${binding.symbol}','${binding.timeframe}'`;
  environment.contextBudget.used += 1;
  if (environment.contextBudget.used > environment.contextBudget.max) {
    environment.contextBudget.used -= 1;
    throw new RequestError(
      `${what}: unique request contexts exceed the cap of ${environment.contextBudget.max}`,
    );
  }

  const range: RangeDemand =
    binding.options.calcBarsCount === 0
      ? FULL_RANGE
      : {kind: 'trailing-bars', bars: binding.options.calcBarsCount};
  const resolved = await environment.provider.resolveContext(
    binding.symbol,
    binding.timeframe,
    range,
  );
  if (isContextError(resolved)) {
    const ignorable =
      resolved.error === 'unknownSymbol' || resolved.error === 'unknownSource';
    if (binding.options.ignoreInvalidSymbol && ignorable) {
      const empty = environment.layouts.empty(spec.layout);
      return {at: () => empty};
    }
    environment.contextBudget.used -= 1;
    throw new BindError(`${what}: ${resolved.error} (${resolved.detail})`);
  }

  try {
    const childContext = clampContext(resolved, range, what);
    if (parent.axis === null || childContext.axis === null) {
      throw new BindError(
        `${what}: merge requires a time axis on both contexts (a csv context needs a 'time' column)`,
      );
    }
    assertMergeAxis(
      childContext.axis,
      childContext.rows,
      `${what} child context`,
    );
    const code = childModule(binding.child, environment.aggregateLayouts);
    let childFacts: BoundModuleFacts;
    try {
      childFacts = evaluateChildModuleBinding(code, environment.params);
    } catch (error) {
      if (error instanceof ModuleBindingEvaluationError) {
        throw new BindError(error.message);
      }
      throw error;
    }
    const values = await runRequestChild(
      childFacts,
      childContext,
      spec.resultSlot,
      spec.layout,
      environment,
    );
    const map = sampleMergeMap(
      parent.axis,
      parent.rows,
      childContext.axis,
      childContext.rows,
      binding.options,
    );
    const empty = environment.layouts.empty(spec.layout);
    return {
      at(row) {
        const childRow = map[row];
        return childRow === undefined || childRow < 0
          ? empty
          : (values[childRow] ?? empty);
      },
    };
  } catch (error) {
    environment.contextBudget.used -= 1;
    throw error;
  }
}

async function runRequestChild(
  facts: BoundModuleFacts,
  context: ProviderContext,
  resultSlot: number,
  resultLayout: LayoutId,
  environment: RequestEnvironment,
): Promise<readonly Value[]> {
  validateRows(context);
  const series = bindSeries(facts, environment.params, context);
  const builtins = bindBuiltins(
    facts,
    context,
    environment.layouts,
    environment.timeNow,
  );
  const requests = await bindStaticRequests(facts, context, environment);
  const runtime = new StateMachineRuntime(
    facts.code,
    environment.params,
    environment.layouts,
    {
      maxCollectionElements: environment.maxCollectionElements,
      heapLimits: environment.heapLimits,
    },
  );
  try {
    const values: Value[] = [];
    for (let row = 0; row < context.rows; row += 1) {
      Effect.runSync(
        runtime.step({
          series: series.map(value => value.at(row)),
          builtins: builtins.map(value => value(row)),
          requests: requests.map(value => value.at(row)),
          provisional: false,
        }),
      );
      values.push(
        copyRequestResult(
          environment.layouts,
          resultLayout,
          runtime.readResult(resultSlot, resultLayout),
        ),
      );
    }
    return values;
  } finally {
    runtime.dispose();
  }
}

function childModule(
  code: ModuleCode,
  aggregateLayouts: AggregateLayoutManifest,
): TeaModule {
  return {
    ...code,
    abi: RUNTIME_ABI_VERSION,
    aggregateLayouts,
  };
}

function assertRequestTransportLayout(
  layouts: ValueLayoutRegistry,
  id: LayoutId,
): void {
  const layout = layouts.layout(id);
  switch (layout.kind) {
    case 'number':
    case 'boolean':
    case 'nullable-scalar':
    case 'enum':
      return;
    case 'tuple':
      layout.elements.forEach(element =>
        assertRequestTransportLayout(layouts, element),
      );
      return;
    case 'resource':
    case 'struct':
    case 'array':
    case 'matrix':
    case 'map':
      throw new BindError(
        `request result layout ${id} (${layout.kind}) cannot cross a runtime Heap boundary`,
      );
  }
}

function copyRequestResult(
  layouts: ValueLayoutRegistry,
  id: LayoutId,
  value: Value,
): Value {
  layouts.assertValue(id, value, 'request result transport');
  if (value === null) return null;
  const layout = layouts.layout(id);
  if (layout.kind !== 'tuple') return value;
  if (!isTupleValue(value)) {
    return fatal(`validated request tuple layout ${id} lost its tuple shape`);
  }
  return Object.freeze(
    layout.elements.map((element, index) =>
      copyRequestResult(layouts, element, value[index]),
    ),
  );
}

function clampContext(
  context: ProviderContext,
  range: RangeDemand,
  what: string,
): ProviderContext {
  validateRows(context);
  if (range.kind === 'full' || range.bars >= context.rows) return context;
  const start = context.rows - range.bars;
  const rows = range.bars;
  return {
    rows,
    axis:
      context.axis === null
        ? null
        : {
            time: row => context.axis!.time(start + row),
            closeTime: row => context.axis!.closeTime(start + row),
          },
    series(id) {
      const value = context.series(id);
      if (value === null) return null;
      if (value.length !== context.rows) {
        throw new BindError(
          `${what}: series '${id}' has ${value.length} rows, context has ${context.rows}`,
        );
      }
      return {length: rows, at: row => value.at(start + row)};
    },
    builtinValue: source => context.builtinValue(source),
  };
}

function bindSeries(
  facts: BoundModuleFacts,
  params: readonly Value[],
  context: ProviderContext,
): readonly SeriesData[] {
  return facts.code.manifest.series.map((spec, sid) => {
    let id = spec.id;
    if (id === null) {
      const pid = facts.code.manifest.params.findIndex(
        param => param.seriesSid === sid,
      );
      if (pid < 0 || typeof params[pid] !== 'string') {
        return fatal(`series slot ${sid} has neither host id nor parameter`);
      }
      id = params[pid];
    }
    const value = context.series(id);
    if (value === null) {
      throw new BindError(`series '${id}' is not provided by this context`);
    }
    if (value.length !== context.rows) {
      throw new BindError(
        `series ${sid} has ${value.length} rows, context has ${context.rows}`,
      );
    }
    return value;
  });
}

function bindBuiltins(
  facts: BoundModuleFacts,
  context: ProviderContext,
  layouts: ValueLayoutRegistry,
  timeNow: number,
): readonly ((row: number) => Value)[] {
  let axisValidated = false;
  return facts.code.manifest.builtin.map((spec, bid) => {
    layouts.layout(spec.layout);
    const source = spec.source;
    if (source.domain === 'syminfo' || source.domain === 'timeframe') {
      const value = context.builtinValue(source);
      if (value === undefined) {
        throw new BindError(
          `builtin '${builtinSourceName(source)}' is not provided by this context`,
        );
      }
      assertBindValue(layouts, spec, value);
      return () => value;
    }
    if (
      source.domain === 'time' &&
      (source.field === 'time' || source.field === 'time_close')
    ) {
      if (context.axis === null) {
        throw new BindError(
          `builtin '${source.field}' requires a time axis in this context`,
        );
      }
      if (!axisValidated) {
        assertMergeAxis(context.axis, context.rows, 'runtime context');
        axisValidated = true;
      }
    }
    return row => builtinAt(spec, row, context, timeNow);
  });
}

function builtinAt(
  spec: BuiltinSpec,
  row: number,
  context: ProviderContext,
  timeNow: number,
): Value {
  const source = spec.source;
  switch (source.domain) {
    case 'time':
      switch (source.field) {
        case 'time':
          return context.axis?.time(row) ?? null;
        case 'time_close':
          return context.axis?.closeTime(row) ?? null;
        case 'timenow':
          return timeNow;
      }
    case 'bar':
      return source.field === 'bar_index' ? row : context.rows - 1;
    case 'barstate':
      switch (source.field) {
        case 'isfirst':
          return row === 0;
        case 'islast':
          return row === context.rows - 1;
        case 'isrealtime':
          return false;
        case 'ishistory':
        case 'isconfirmed':
        case 'isnew':
          return true;
      }
    case 'syminfo':
    case 'timeframe':
      return fatal(
        `context builtin '${builtinSourceName(source)}' was not prebound`,
      );
  }
}

function assertBindValue(
  layouts: ValueLayoutRegistry,
  spec: BuiltinSpec,
  value: Value,
): void {
  try {
    layouts.assertValue(
      spec.layout,
      value,
      `builtin '${builtinSourceName(spec.source)}'`,
    );
  } catch (error) {
    if (error instanceof ExecutionError) throw new BindError(error.message);
    throw error;
  }
}

function builtinSourceName(source: BuiltinSource): string {
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

function validateRows(context: ProviderContext): void {
  if (!Number.isSafeInteger(context.rows) || context.rows < 0) {
    throw new BindError(
      `provider context row count must be a non-negative safe integer, got ${context.rows}`,
    );
  }
}

function bindTimeNow(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new BindError('timeNow must be a finite safe epoch-ms integer');
  }
  return value;
}

function optionalLimit(value: number | undefined, name: string) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new BindError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
