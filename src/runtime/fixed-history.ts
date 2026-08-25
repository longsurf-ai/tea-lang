// Purpose: Fixed-historical DataProvider/OutputSink host adapter over
// JSRuntime.step, which remains the only JavaScript execution semantic core.

import {Effect} from 'effect';
import {fatal} from '../base/print';
import type {BuiltinSource} from '../ir/builtin';
import {Storage} from '../ir/node';
import type {BindInputs, BoundInput, FixedHistoryExecution} from './binding';
import {BindError, ExecutionError, RequestError} from './errors';
import {assertMergeAxis, sampleMergeMap} from './merge';
import {
  boundInputs,
  configureChildModule,
  configureModule,
  depthBars,
  moduleDeclaration,
  ModuleBindingEvaluationError,
  requireConcreteModule,
} from './module-binding';
import {
  RUNTIME_ABI_VERSION,
  type BuiltinSpec,
  type JSModule,
  type RequestSpec,
} from './module-abi';
import type {RowPublication} from './output';
import {resolveParamValues} from './params';
import {
  isContextError,
  type ProviderContext,
  type RangeDemand,
  type SeriesData,
} from './provider';
import {JSRuntime, type JSRuntimeOptions, type StepResult} from './js-runtime';
import {isTupleValue, type Value} from './value';
import {type LayoutId, ValueLayoutRegistry} from './value-layout';

const FULL_RANGE = {kind: 'full'} as const;
const DEFAULT_MAX_COLLECTION_ELEMENTS = 100_000;
const DEFAULT_MAX_REQUEST_CONTEXTS = 40;
const DEFAULT_MAX_FIXED_VALUE_LOGICAL_BYTES = 64 * 1024 * 1024;

interface RequestView {
  at(row: number): Value;
  release(): void;
}

interface ContextIdentity {
  readonly symbol: string;
  readonly timeframe: string;
}

interface StateStorageLease {
  readonly logicalBytes: number;
  release(): void;
}

interface RequestEnvironment {
  readonly provider: BindInputs['provider'];
  readonly params: readonly Value[];
  readonly layouts: ValueLayoutRegistry;
  readonly timeNow: number;
  readonly maxCollectionElements: number;
  readonly heapLimits: JSRuntimeOptions['heapLimits'];
  readonly contextBudget: {used: number; readonly max: number};
  readonly stateStorage: {
    usedLogicalBytes: number;
    readonly maxLogicalBytes: number;
  };
}

/** Bind the migration runtime to one finite provider context. */
export async function bindFixedHistory(
  module: JSModule,
  inputs: BindInputs,
): Promise<FixedHistoryExecution> {
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
  const maxFixedValueLogicalBytes =
    optionalLimit(
      inputs.maxFixedValueLogicalBytes,
      'maxFixedValueLogicalBytes',
    ) ?? DEFAULT_MAX_FIXED_VALUE_LOGICAL_BYTES;

  const params = resolveParamValues(module.manifest.params, inputs.params);
  let configured: JSModule;
  try {
    configured = configureModule(module, params);
    requireConcreteModule(configured);
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
  const contextIdentity = effectiveContextIdentity(
    context,
    inputs.symbol ?? '',
    inputs.timeframe ?? '',
  );

  const layouts = new ValueLayoutRegistry(configured.layout);
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
    timeNow,
    maxCollectionElements,
    heapLimits,
    contextBudget: {used: 0, max: maxRequestContexts},
    stateStorage: {
      usedLogicalBytes: 0,
      maxLogicalBytes: maxFixedValueLogicalBytes,
    },
  };
  const series = bindSeries(configured, context);
  const builtins = bindBuiltins(configured, context, layouts, timeNow);
  const workspace = reserveWorkspace(configured, environment, 'root state');
  let requests: readonly RequestView[] = [];
  let runtime: JSRuntime | null = null;
  try {
    requests = await bindStaticRequests(
      configured,
      context,
      contextIdentity,
      environment,
    );
    runtime = new JSRuntime(configured, {
      maxCollectionElements,
      heapLimits,
    });
    inputs.sink.declare(moduleDeclaration(configured));
    return new FixedHistoryExecutionImpl(
      runtime,
      boundInputs(configured),
      context,
      series,
      builtins,
      requests,
      inputs.sink,
      workspace,
    );
  } catch (error) {
    runtime?.dispose();
    requests.forEach(view => view.release());
    workspace.release();
    throw error;
  }
}

class FixedHistoryExecutionImpl implements FixedHistoryExecution {
  readonly rows: number;
  readonly inputs: readonly BoundInput[];
  private committedRows = 0;
  private pending: {readonly row: number; readonly result: StepResult} | null =
    null;
  private disposed = false;
  private terminalSinkFailure: unknown | null = null;

  constructor(
    private readonly runtime: JSRuntime,
    inputs: readonly BoundInput[],
    private readonly context: ProviderContext,
    private readonly series: readonly SeriesData[],
    private readonly builtins: readonly ((row: number) => Value)[],
    private readonly requests: readonly RequestView[],
    private readonly sink: BindInputs['sink'],
    private readonly workspace: StateStorageLease,
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
    this.requests.forEach(view => view.release());
    this.workspace.release();
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
  module: JSModule,
  parent: ProviderContext,
  parentIdentity: ContextIdentity,
  environment: RequestEnvironment,
): Promise<readonly RequestView[]> {
  const requests = module.manifest.requests;
  if (requests.length === 0) return [];
  requests.forEach((request, requestId) => {
    if (request.dynamic) {
      throw new BindError(
        `dynamic request ${requestId} is unsupported by fixed historical binding`,
      );
    }
  });
  if (parent.axis === null) {
    throw new BindError(
      "requests require a time axis on the primary context (a csv context needs a 'time' column)",
    );
  }
  assertMergeAxis(parent.axis, parent.rows, 'primary context');
  const views: RequestView[] = new Array(module.manifest.requests.length);
  try {
    for (const [requestId, spec] of requests.entries()) {
      const context = spec.context;
      if (context == null) {
        throw new BindError(
          `static request ${requestId} has incomplete context`,
        );
      }
      views[requestId] = await bindStaticRequest(
        requestId,
        context,
        module,
        parent,
        parentIdentity,
        environment,
      );
    }
    return views;
  } catch (error) {
    views.forEach(view => view?.release());
    throw error;
  }
}

async function bindStaticRequest(
  requestId: number,
  binding: NonNullable<RequestSpec['context']>,
  parentModule: JSModule,
  parent: ProviderContext,
  parentIdentity: ContextIdentity,
  environment: RequestEnvironment,
): Promise<RequestView> {
  const spec = parentModule.manifest.requests[requestId];
  if (spec === undefined || spec.dynamic) {
    throw new BindError(
      `dynamic request ${requestId} is unsupported by fixed historical binding`,
    );
  }
  assertRequestTransportLayout(environment.layouts, spec.layout);
  const symbol = binding.symbol === '' ? parentIdentity.symbol : binding.symbol;
  const timeframe =
    binding.timeframe === '' ? parentIdentity.timeframe : binding.timeframe;
  const what = `request '${symbol}','${timeframe}'`;
  environment.contextBudget.used += 1;
  if (environment.contextBudget.used > environment.contextBudget.max) {
    environment.contextBudget.used -= 1;
    throw new RequestError(
      `${what}: unique request contexts exceed the cap of ${environment.contextBudget.max}`,
    );
  }

  const range: RangeDemand =
    binding.calcBarsCount === 0
      ? FULL_RANGE
      : {kind: 'trailing-bars', bars: binding.calcBarsCount};
  const resolved = await environment.provider.resolveContext(
    symbol,
    timeframe,
    range,
  );
  if (isContextError(resolved)) {
    const ignorable =
      resolved.error === 'unknownSymbol' || resolved.error === 'unknownSource';
    if (binding.ignoreInvalidSymbol && ignorable) {
      const empty = environment.layouts.empty(spec.layout);
      return {at: () => empty, release() {}};
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
    const childIdentity = effectiveContextIdentity(
      childContext,
      symbol,
      timeframe,
    );
    const child = parentModule.requests[requestId];
    if (child === undefined) {
      throw new BindError(`static request ${requestId} has no child module`);
    }
    let childModule: JSModule;
    try {
      childModule = configureChildModule(child, environment.params);
    } catch (error) {
      if (error instanceof ModuleBindingEvaluationError) {
        throw new BindError(error.message);
      }
      throw error;
    }
    const result = await runRequestChild(
      childModule,
      childContext,
      childIdentity,
      spec.resultSlot,
      spec.layout,
      environment,
    );
    try {
      const map = sampleMergeMap(
        parent.axis,
        parent.rows,
        childContext.axis,
        childContext.rows,
        binding,
      );
      const empty = environment.layouts.empty(spec.layout);
      return {
        at(row) {
          const childRow = map[row];
          return childRow === undefined || childRow < 0
            ? empty
            : (result.values[childRow] ?? empty);
        },
        release: result.lease.release,
      };
    } catch (error) {
      result.lease.release();
      throw error;
    }
  } catch (error) {
    environment.contextBudget.used -= 1;
    throw error;
  }
}

async function runRequestChild(
  module: JSModule,
  context: ProviderContext,
  contextIdentity: ContextIdentity,
  resultSlot: number,
  resultLayout: LayoutId,
  environment: RequestEnvironment,
): Promise<{
  readonly values: readonly Value[];
  readonly lease: StateStorageLease;
}> {
  validateRows(context);
  const series = bindSeries(module, context);
  const builtins = bindBuiltins(
    module,
    context,
    environment.layouts,
    environment.timeNow,
  );
  const workspace = reserveWorkspace(
    module,
    environment,
    'request child state',
  );
  let requests: readonly RequestView[] = [];
  let resultLease: StateStorageLease | null = null;
  let runtime: JSRuntime | null = null;
  let completed = false;
  try {
    requests = await bindStaticRequests(
      module,
      context,
      contextIdentity,
      environment,
    );
    resultLease = reserveStateStorage(
      environment,
      resultLayout,
      context.rows,
      'request result column',
    );
    runtime = new JSRuntime(module, {
      maxCollectionElements: environment.maxCollectionElements,
      heapLimits: environment.heapLimits,
    });
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
    completed = true;
    return {values, lease: resultLease};
  } finally {
    runtime?.dispose();
    requests.forEach(view => view.release());
    workspace.release();
    if (!completed) resultLease?.release();
  }
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
  module: JSModule,
  context: ProviderContext,
): readonly SeriesData[] {
  return module.manifest.series.map((spec, sid) => {
    let id = spec.id;
    if (id === null) {
      const pid = module.manifest.params.findIndex(
        param => param.seriesSid === sid,
      );
      const selected = module.manifest.params[pid]?.value;
      if (pid < 0 || typeof selected !== 'string') {
        return fatal(`series slot ${sid} has neither host id nor parameter`);
      }
      id = selected;
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
  module: JSModule,
  context: ProviderContext,
  layouts: ValueLayoutRegistry,
  timeNow: number,
): readonly ((row: number) => Value)[] {
  let axisValidated = false;
  return module.manifest.builtin.map((spec, bid) => {
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

function effectiveContextIdentity(
  context: ProviderContext,
  fallbackSymbol: string,
  fallbackTimeframe: string,
): ContextIdentity {
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
  return {
    symbol: typeof symbol === 'string' ? symbol : fallbackSymbol,
    timeframe: typeof timeframe === 'string' ? timeframe : fallbackTimeframe,
  };
}

function validateRows(context: ProviderContext): void {
  if (!Number.isSafeInteger(context.rows) || context.rows < 0) {
    throw new BindError(
      `provider context row count must be a non-negative safe integer, got ${context.rows}`,
    );
  }
}

function reserveWorkspace(
  module: JSModule,
  environment: RequestEnvironment,
  what: string,
): StateStorageLease {
  let logicalBytes = 0;
  const add = (layout: LayoutId, cells: number, label: string) => {
    const bytes = fixedLogicalBytes(environment.layouts, layout, cells, label);
    logicalBytes = addLogicalBytes(logicalBytes, bytes, what);
  };

  const active = new Set<number>();
  const frame = (fid: number): void => {
    if (active.has(fid)) {
      throw new ExecutionError(
        'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED',
        `${what} has recursively sized frame ${fid}`,
      );
    }
    const spec = module.manifest.frames[fid];
    if (spec === undefined) {
      return fatal(`${what} references unknown frame ${fid}`);
    }
    active.add(fid);
    spec.locals.forEach((local, slot) => {
      const retained =
        local.storage === Storage.Var || local.storage === Storage.Varip
          ? Math.max(1, depthBars(local.depth))
          : depthBars(local.depth);
      add(local.layout, retained + 1, `${what} frame ${fid} slot ${slot}`);
    });
    spec.subs.forEach(sub => frame(sub.fid));
    active.delete(fid);
  };
  frame(0);

  module.manifest.series.forEach((_spec, sid) => {
    const label = `${what} series ${sid}`;
    logicalBytes = addLogicalBytes(
      logicalBytes,
      fixedRawBytes(8, depthBars(module.manifest.series[sid]!.depth), label),
      what,
    );
  });
  module.manifest.builtin.forEach((spec, bid) =>
    add(spec.layout, depthBars(spec.depth), `${what} builtin ${bid}`),
  );
  module.manifest.requests.forEach((spec, rid) =>
    add(spec.layout, depthBars(spec.depth), `${what} request ${rid}`),
  );
  return reserveLogicalBytes(environment, logicalBytes, what);
}

function reserveStateStorage(
  environment: RequestEnvironment,
  layout: LayoutId,
  cells: number,
  what: string,
): StateStorageLease {
  return reserveLogicalBytes(
    environment,
    fixedLogicalBytes(environment.layouts, layout, cells, what),
    what,
  );
}

function fixedRawBytes(bytesPerCell: number, cells: number, what: string) {
  if (!Number.isSafeInteger(cells) || cells < 0) {
    return fatal(`${what} requested invalid state cell count ${cells}`);
  }
  const bytes = bytesPerCell * cells;
  if (!Number.isSafeInteger(bytes)) {
    throw new ExecutionError(
      'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED',
      `${what} state storage size overflowed`,
    );
  }
  return bytes;
}

function fixedLogicalBytes(
  layouts: ValueLayoutRegistry,
  layout: LayoutId,
  cells: number,
  what: string,
): number {
  return fixedRawBytes(layouts.shallowBytes(layout), cells, what);
}

function addLogicalBytes(current: number, added: number, what: string): number {
  const next = current + added;
  if (!Number.isSafeInteger(next)) {
    throw new ExecutionError(
      'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED',
      `${what} state storage size overflowed`,
    );
  }
  return next;
}

function reserveLogicalBytes(
  environment: RequestEnvironment,
  logicalBytes: number,
  what: string,
): StateStorageLease {
  const next = addLogicalBytes(
    environment.stateStorage.usedLogicalBytes,
    logicalBytes,
    what,
  );
  if (next > environment.stateStorage.maxLogicalBytes) {
    throw new ExecutionError(
      'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED',
      `${what} requires ${logicalBytes} bytes; shared state storage would exceed ${environment.stateStorage.maxLogicalBytes} bytes`,
    );
  }
  environment.stateStorage.usedLogicalBytes = next;
  let released = false;
  return Object.freeze({
    logicalBytes,
    release() {
      if (released) return;
      released = true;
      const remaining =
        environment.stateStorage.usedLogicalBytes - logicalBytes;
      if (remaining < 0) return fatal('state storage accounting underflow');
      environment.stateStorage.usedLogicalBytes = remaining;
    },
  });
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
