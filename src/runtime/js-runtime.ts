// Purpose: The JS runtime — implements the Runtime ABI and owns the main loop: binding, frame trees, ring allocation, request-child scheduling, the provisional/commit protocol, and emission flushing. docs/runtime.md and docs/requests.md are the authorities.

import {log} from '../base/log';
import {fatal} from '../base/print';
import type {BuiltinSource} from '../ir/builtin';
import {Storage} from '../ir/node';
import type {EffectValueSchema} from '../ir/program';
import type {BindInputs, BoundInput, BoundProgram} from './binding';
import {
  BindError,
  ContextSuspension,
  ExecutionError,
  RequestError,
} from './errors';
import {
  RUNTIME_ABI_VERSION,
  type CollectionEntries,
  type CollectionMutation,
  type CollectionMutationOperation,
  type CollectionOperation,
  type ContextBudget,
  type DepthSpec,
  type FixedValueStorageBudget,
  type Frame,
  type FrameLayout,
  type ModuleCode,
  type ModuleManifest,
  type RequestSpec,
  type Runtime,
  type TeaModule,
} from './module-abi';
import type {
  DenseEmission,
  EffectEmission,
  OutputSink,
  RowPublication,
} from './output';
import {
  isContextError,
  type ContextError,
  type DataProvider,
  type ProviderContext,
  type RangeDemand,
  type SeriesData,
} from './provider';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  isTupleValue,
  isUserTypeValue,
  type EffectValue,
  type UserTypeValue,
  type Value,
} from './value';
import {CollectionRuntime} from './collections';
import {
  HeapArena,
  type HeapTransaction,
  type PreparedHeapCommit,
  type StorageRef,
} from './heap';
import {assertMergeAxis, sampleMergeMap} from './merge';
import {resolveParamValues} from './params';
import {isHistoryOffset, Ring, type RingCommitMode} from './ring';
import {rebuildUserPath, newUserValue, userField} from './user-value';
import {type LayoutId, ValueLayoutRegistry} from './value-layout';

const FULL_RANGE: RangeDemand = {kind: 'full'};
const DEFAULT_MAX_COLLECTION_ELEMENTS = 100_000;
const DEFAULT_MAX_REQUEST_CONTEXTS = 40;
const DEFAULT_MAX_FIXED_VALUE_LOGICAL_BYTES = 64 * 1024 * 1024;

const requestLog = log.child('runtime.request');

function optionalBindLimit(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new BindError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function fixedValueStorageLimit(value: number | undefined): number {
  return (
    optionalBindLimit(value, 'maxFixedValueLogicalBytes') ??
    DEFAULT_MAX_FIXED_VALUE_LOGICAL_BYTES
  );
}

function requestContextLimit(value: number | undefined): number {
  return (
    optionalBindLimit(value, 'maxRequestContexts') ??
    DEFAULT_MAX_REQUEST_CONTEXTS
  );
}

function bindTimeNow(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new BindError('timeNow must be a finite safe epoch-ms integer');
  }
  return value;
}

// A bound depth is the same value the read will later use as its history
// offset. Invalid offsets always read empty, so they retain no committed cells.
function retentionForOffset(offset: number): number {
  return isHistoryOffset(offset) ? offset : 0;
}

// Bind a lowered module to parameter values, a data provider, and an output
// sink. Everything bind-time happens here: validation, context resolution,
// running the module's init/bind sections, request-child execution and merge,
// sizing rings, declaring outputs. Async because context resolution is the
// seam where drivers fetch; the per-row hot path never awaits.
export async function bind(
  module: TeaModule,
  inputs: BindInputs,
): Promise<BoundProgram> {
  const abi =
    typeof module === 'object' && module !== null
      ? (module as {readonly abi?: unknown}).abi
      : undefined;
  if (abi !== RUNTIME_ABI_VERSION) {
    throw new BindError(
      `unsupported module ABI ${String(abi)}; expected ${RUNTIME_ABI_VERSION}`,
    );
  }
  const timeNow = bindTimeNow(inputs.timeNow);
  const maxRequestContexts = requestContextLimit(inputs.maxRequestContexts);
  const maxCollectionElements =
    optionalBindLimit(inputs.maxCollectionElements, 'maxCollectionElements') ??
    DEFAULT_MAX_COLLECTION_ELEMENTS;
  const heapLimits = {
    maxStorageCells: optionalBindLimit(
      inputs.maxHeapStorageCells,
      'maxHeapStorageCells',
    ),
    maxLogicalBytes: optionalBindLimit(
      inputs.maxHeapLogicalBytes,
      'maxHeapLogicalBytes',
    ),
    maxTransientStorageCells: optionalBindLimit(
      inputs.maxHeapTransientStorageCells,
      'maxHeapTransientStorageCells',
    ),
    maxTransientLogicalBytes: optionalBindLimit(
      inputs.maxHeapTransientLogicalBytes,
      'maxHeapTransientLogicalBytes',
    ),
  };
  const symbol = inputs.symbol ?? '';
  const timeframe = inputs.timeframe ?? '';
  const context = await inputs.provider.resolveContext(
    symbol,
    timeframe,
    FULL_RANGE,
  );
  if (isContextError(context)) {
    throw new BindError(formatContextError('primary context', context));
  }
  const contextIdentity = effectiveContextIdentity(context, symbol, timeframe);
  const params = resolveParamValues(module.manifest.params, inputs.params);
  const layouts = new ValueLayoutRegistry(module.aggregateLayouts);
  const shared: SharedRuntimeState = {
    aggregateLayouts: layouts,
    heap: new HeapArena(heapLimits),
    contextBudget: {used: 0, max: maxRequestContexts},
    fixedValueStorage: {
      usedLogicalBytes: 0,
      maxLogicalBytes: fixedValueStorageLimit(inputs.maxFixedValueLogicalBytes),
    },
    runtimes: new Set(),
    resultBuilders: new Set(),
    disposed: false,
  };
  let rt: JSRuntime | null = null;
  try {
    rt = new JSRuntime(
      module,
      inputs.provider,
      inputs.sink,
      context,
      contextIdentity.symbol,
      contextIdentity.timeframe,
      timeNow,
      params,
      shared,
      maxCollectionElements,
      true,
    );
    await rt.bindRequests();
    rt.finishBind();
    return rt;
  } catch (error) {
    if (rt === null) {
      shared.heap.dispose();
      shared.disposed = true;
    } else {
      rt.dispose();
    }
    throw error;
  }
}

// The generated frame-aware bind section is shared by both execution
// targets. GPU binding needs its concrete per-frame retention without
// allocating the final CPU Rings, so it runs the same provisional JSRuntime
// phase against an already resolved provider context and snapshots the
// resulting capacities.
export interface GeneratedBindingLayout {
  readonly frameHistoryCapacities: readonly (readonly number[])[];
  readonly inputs: readonly BoundInput[];
}

export function resolveGeneratedBindingLayout(
  module: TeaModule,
  inputs: BindInputs,
  context: ProviderContext,
): GeneratedBindingLayout {
  if (module.abi !== RUNTIME_ABI_VERSION) {
    throw new BindError(
      `unsupported module ABI ${String(module.abi)}; expected ${RUNTIME_ABI_VERSION}`,
    );
  }
  const timeNow = bindTimeNow(inputs.timeNow);
  const maxRequestContexts = requestContextLimit(inputs.maxRequestContexts);
  const maxCollectionElements =
    optionalBindLimit(inputs.maxCollectionElements, 'maxCollectionElements') ??
    DEFAULT_MAX_COLLECTION_ELEMENTS;
  const symbol = inputs.symbol ?? '';
  const timeframe = inputs.timeframe ?? '';
  const identity = effectiveContextIdentity(context, symbol, timeframe);
  const params = resolveParamValues(module.manifest.params, inputs.params);
  const shared: SharedRuntimeState = {
    aggregateLayouts: new ValueLayoutRegistry(module.aggregateLayouts),
    heap: new HeapArena({
      maxStorageCells: optionalBindLimit(
        inputs.maxHeapStorageCells,
        'maxHeapStorageCells',
      ),
      maxLogicalBytes: optionalBindLimit(
        inputs.maxHeapLogicalBytes,
        'maxHeapLogicalBytes',
      ),
      maxTransientStorageCells: optionalBindLimit(
        inputs.maxHeapTransientStorageCells,
        'maxHeapTransientStorageCells',
      ),
      maxTransientLogicalBytes: optionalBindLimit(
        inputs.maxHeapTransientLogicalBytes,
        'maxHeapTransientLogicalBytes',
      ),
    }),
    contextBudget: {used: 0, max: maxRequestContexts},
    fixedValueStorage: {
      usedLogicalBytes: 0,
      maxLogicalBytes: fixedValueStorageLimit(inputs.maxFixedValueLogicalBytes),
    },
    runtimes: new Set(),
    resultBuilders: new Set(),
    disposed: false,
  };
  let rt: JSRuntime | null = null;
  try {
    rt = new JSRuntime(
      module,
      inputs.provider,
      null,
      context,
      identity.symbol,
      identity.timeframe,
      timeNow,
      params,
      shared,
      maxCollectionElements,
      true,
      true,
    );
    return rt.generatedBindingLayout();
  } finally {
    if (rt === null) {
      shared.heap.dispose();
      shared.disposed = true;
    } else {
      rt.dispose();
    }
  }
}

function pairKey(rid: number, symbol: string, timeframe: string): string {
  return `${rid}\u0000${symbol}\u0000${timeframe}`;
}

function effectiveContextIdentity(
  context: ProviderContext,
  fallbackSymbol: string,
  fallbackTimeframe: string,
): {readonly symbol: string; readonly timeframe: string} {
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

// A child runs its full history at resolution time; nested dynamic edges
// may suspend, so the loop resolves as it goes — the same protocol runAll
// follows for the root.
async function runChildRows(
  child: JSRuntime,
  resultSlot: number,
  layout: LayoutId,
  shared: SharedRuntimeState,
): Promise<ResultBuilder> {
  let storageLease: FixedValueStorageLease;
  try {
    storageLease = reserveFixedValueStorage(
      shared,
      layout,
      child.rows,
      'request result column',
    );
  } catch (error) {
    child.retireCompletedChild();
    throw error;
  }
  const builder: ResultBuilder = {
    layout,
    runtime: child,
    resultSlot,
    values: [],
    storageLease,
  };
  shared.resultBuilders.add(builder);
  const childRoot = child.root();
  try {
    for (let row = 0; row < child.rows; row += 1) {
      for (;;) {
        try {
          child.executeRow(row, false);
          break;
        } catch (error) {
          if (error instanceof ContextSuspension) {
            await child.resolvePending();
            continue;
          }
          throw error;
        }
      }
      builder.values.push(child.read(childRoot, resultSlot, 0));
      child.commitRow(row);
    }
    return builder;
  } catch (error) {
    shared.resultBuilders.delete(builder);
    storageLease.release();
    child.retireCompletedChild();
    throw error;
  }
}

function formatContextError(what: string, error: ContextError): string {
  return `${what}: ${error.error} (${error.detail})`;
}

interface FrameImpl extends Frame {
  readonly fid: number;
  readonly layout: FrameLayout;
  readonly rings: Ring[];
  // Physical allocation is independent from semantic activation. Root starts
  // active; a child call marks scratchActive tentatively, and final commit
  // promotes it to committedActive.
  committedActive: boolean;
  scratchActive: boolean;
  // Persistent initialization has a durable committed bit and a tentative
  // scratch bit. The latter follows row rollback/provisional semantics just
  // like the Ring scratch value it qualifies.
  readonly committedInitialization: boolean[];
  readonly scratchInitialization: boolean[];
  readonly subs: (FrameImpl | null)[];
}

interface VaripSnapshot {
  readonly value: Value;
  readonly initialized: boolean;
}

interface ResultBuilder {
  readonly layout: LayoutId;
  readonly runtime: JSRuntime;
  readonly resultSlot: number;
  readonly values: Value[];
  readonly storageLease: FixedValueStorageLease;
}

interface SharedRuntimeState {
  readonly aggregateLayouts: ValueLayoutRegistry;
  readonly heap: HeapArena;
  readonly contextBudget: ContextBudget;
  readonly fixedValueStorage: FixedValueStorageBudget;
  readonly runtimes: Set<JSRuntime>;
  readonly resultBuilders: Set<ResultBuilder>;
  disposed: boolean;
}

interface BoundRequestOptions {
  readonly gaps: boolean;
  readonly lookahead: boolean;
  readonly ignoreInvalidSymbol: boolean;
  readonly range: RangeDemand;
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

// Providers are allowed to over-return. The runtime owns the exact child row
// space exposed to generated code, so a positive trailing demand is always
// enforced here as a shifted immutable view.
function clampProviderContext(
  context: ProviderContext,
  range: RangeDemand,
  what: string,
  makeError: (message: string) => Error,
): ProviderContext {
  if (!Number.isSafeInteger(context.rows) || context.rows < 0) {
    throw makeError(
      `${what}: provider context row count must be a non-negative safe integer, got ${context.rows}`,
    );
  }
  if (range.kind === 'full' || range.bars >= context.rows) {
    return context;
  }
  const start = context.rows - range.bars;
  const rows = range.bars;
  const axis = context.axis;
  return {
    rows,
    axis:
      axis === null
        ? null
        : {
            time: row => axis.time(start + row),
            closeTime: row => axis.closeTime(start + row),
          },
    series(id) {
      const data = context.series(id);
      if (data === null) {
        return null;
      }
      if (data.length !== context.rows) {
        throw makeError(
          `${what}: series '${id}' has ${data.length} rows, context has ${context.rows}`,
        );
      }
      return {
        length: rows,
        at: row => data.at(start + row),
      };
    },
    builtinValue: source => context.builtinValue(source),
  };
}

// A merged request result: a parent-row-indexed view. Slice A materializes
// the mapping plus the child's result column; the contract (docs/requests.md)
// is the view, so a zero-copy mapping over child storage can replace this
// without touching the ABI.
interface MergedView {
  readonly layout: LayoutId;
  at(row: number): Value;
  visitValues(visit: (value: Value) => void): void;
  releaseBuilder(): void;
  releaseStorage(): void;
}

interface FixedValueStorageLease {
  readonly logicalBytes: number;
  release(): void;
}

function reserveFixedValueStorage(
  shared: SharedRuntimeState,
  layout: LayoutId,
  cells: number,
  what: string,
): FixedValueStorageLease {
  if (!Number.isSafeInteger(cells) || cells < 0) {
    return fatal(`${what} requested invalid fixed-value cell count ${cells}`);
  }
  const logicalBytes = shared.aggregateLayouts.shallowBytes(layout) * cells;
  const next = shared.fixedValueStorage.usedLogicalBytes + logicalBytes;
  if (!Number.isSafeInteger(logicalBytes) || !Number.isSafeInteger(next)) {
    throw new ExecutionError(
      'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED',
      `${what} fixed-value storage size overflowed`,
    );
  }
  if (next > shared.fixedValueStorage.maxLogicalBytes) {
    throw new ExecutionError(
      'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED',
      `${what} requires ${logicalBytes} bytes; shared fixed-value storage would exceed ${shared.fixedValueStorage.maxLogicalBytes} bytes`,
    );
  }
  shared.fixedValueStorage.usedLogicalBytes = next;
  let released = false;
  return Object.freeze({
    logicalBytes,
    release() {
      if (released) {
        return;
      }
      released = true;
      const remaining =
        shared.fixedValueStorage.usedLogicalBytes - logicalBytes;
      if (remaining < 0) {
        return fatal('fixed-value storage accounting underflow');
      }
      shared.fixedValueStorage.usedLogicalBytes = remaining;
    },
  });
}

interface PendingFinalCommit {
  readonly heap: PreparedHeapCommit;
  readonly publication: RowEmissionSnapshot;
}

interface RowEmissionSnapshot {
  readonly outputs: readonly DenseEmission[];
  readonly effects: readonly EffectEmission[];
}

type Phase = 'binding' | 'executing';

class JSRuntime implements Runtime, BoundProgram {
  readonly rows: number;
  readonly inputs: readonly BoundInput[];

  private phase: Phase = 'binding';
  private readonly paramValues: readonly Value[];
  private readonly paramActive: boolean[];
  private readonly seriesData: (SeriesData | null)[] = [];
  private readonly builtinContextValues = new Map<number, Value>();
  // Bind-time depth reports from the module's frame-aware bind section.
  private readonly boundLocalDepths = new Map<string, number>();
  private readonly boundOutputArgs: {name: string; value: Value}[][];
  // Static request pairs declared by bind (rt.bindRequest), then the merged
  // views bindRequests() builds from them (null entries = dynamic edges,
  // whose reads go through their result ring and the pair-view table).
  private readonly requestPairs = new Map<
    number,
    {symbol: string; timeframe: string}
  >();
  private readonly requestOptions = new Map<number, BoundRequestOptions>();
  private readonly requestViews: (MergedView | null)[] = [];
  // Dynamic request machinery: rid-indexed result rings (null for static
  // edges), per-pair merged views ('invalid' = swallowed by
  // ignore_invalid_symbol), and the pair the last suspension recorded.
  private readonly requestRings: (Ring | null)[] = [];
  private readonly pairViews = new Map<string, MergedView | 'invalid'>();
  private pendingPair: {
    rid: number;
    symbol: string;
    timeframe: string;
  } | null = null;
  // A suspended execution vanishes: its retry restores varip scratch from
  // the snapshot taken at the aborted transaction's start (var/perBar re-seed
  // from committed anyway), so results are byte-identical to having had
  // the data upfront — including varip accumulated by prior COMPLETED
  // provisional ticks of the same row.
  private suspendedRow = -1;
  private varipSnapshot: Map<Ring, VaripSnapshot> | null = null;
  private activationSnapshot: Map<FrameImpl, boolean> | null = null;
  private rootFrame: FrameImpl | null = null;
  // module.bind needs real frame identity for input aliases/UDFs before bound
  // capacities are known. Its frames therefore use scratch-only rings and are
  // discarded; the final tree is rebuilt immediately after all depth reports.
  private provisionalBindFrames = false;
  private readonly collections: CollectionRuntime;
  private readonly ringStorageLeases: FixedValueStorageLease[] = [];
  private heapTransaction: HeapTransaction | null = null;
  private pendingFinalCommit: PendingFinalCommit | null = null;
  private disposed = false;

  // Main-loop state.
  private cursor = -1;
  private committedRows = 0;
  private executedRow = -1;
  private emitBuf = new Map<number, Value[]>();
  private effectBuf: EffectEmission[] = [];
  private terminalSinkFailure: {readonly cause: unknown} | null = null;

  // The runtime instance for one module against one resolved context —
  // request children recurse through the same class with a null sink, the
  // parent's resolved params, and the shared context budget.
  constructor(
    private readonly module: ModuleCode,
    private readonly provider: DataProvider,
    private readonly sink: OutputSink | null,
    private readonly context: ProviderContext,
    private readonly contextSymbol: string,
    private readonly contextTimeframe: string,
    private readonly timeNow: number,
    params: readonly Value[],
    private readonly shared: SharedRuntimeState,
    private readonly maxCollectionElements: number,
    private readonly ownsShared: boolean,
    bindingOnly = false,
  ) {
    if (
      !Number.isSafeInteger(maxCollectionElements) ||
      maxCollectionElements < 0
    ) {
      throw new BindError(
        'maxCollectionElements must be a non-negative safe integer',
      );
    }
    this.paramValues = params;
    if (!Number.isSafeInteger(context.rows) || context.rows < 0) {
      throw new BindError(
        `provider context row count must be a non-negative safe integer, got ${context.rows}`,
      );
    }
    this.rows = context.rows;
    this.paramActive = module.manifest.params.map(() => true);
    this.boundOutputArgs = module.manifest.outputs.map(() => []);
    this.validateEffectSchemas();
    this.collections = new CollectionRuntime(
      shared.heap,
      shared.aggregateLayouts,
      maxCollectionElements,
    );

    try {
      const transaction = shared.heap.beginTransaction(
        `bind:${shared.runtimes.size}`,
      );
      this.heapTransaction = transaction;
      try {
        this.bindBuiltin();
        this.bindSeries();

        // Reserved frame-free preparation runs after context carriers bind
        // but before any frame exists, so simple metadata is available.
        this.module.init(this);

        // One context, one axis: the context owns the row space, and every
        // series it serves must fill it — the runtime refuses misaligned data
        // instead of silently truncating.
        this.seriesData.forEach((data, sid) => {
          if (data !== null && data.length !== this.rows) {
            throw new BindError(
              `series ${sid} has ${data.length} rows, context has ${this.rows}`,
            );
          }
        });

        // Input-qualified aliases and UDFs need frame identity before their
        // bound depth reports can size rings. These scratch-only Rings are a
        // temporary fixed-value owner and are released before final sizing.
        this.provisionalBindFrames = true;
        this.rootFrame = this.newFrame(0, true);
        this.module.bind(this, this.rootFrame);
        this.provisionalBindFrames = false;
        this.rootFrame = null;
        this.releaseRingStorage();
        this.inputs = module.manifest.params.map((spec, pid) => ({
          spec,
          value: this.paramValues[pid],
          active: this.paramActive[pid],
        }));
        if (!bindingOnly) {
          this.rootFrame = this.newFrame(0, true);
        }
      } finally {
        transaction.abort();
        this.heapTransaction = null;
        this.provisionalBindFrames = false;
      }
      shared.runtimes.add(this);
    } catch (error) {
      this.releaseOwnedFixedValueStorage();
      throw error;
    }
  }

  // ---- binding --------------------------------------------------------------

  generatedBindingLayout(): GeneratedBindingLayout {
    this.assertBinding('generatedBindingLayout');
    return Object.freeze({
      frameHistoryCapacities: Object.freeze(
        this.module.manifest.frames.map((frame, fid) =>
          Object.freeze(
            frame.locals.map((local, slot) =>
              this.localHistoryCapacity(fid, slot, local.storage, local.depth),
            ),
          ),
        ),
      ),
      inputs: Object.freeze([...this.inputs]),
    });
  }

  // Resolve every static request edge before row 0: fetch the child
  // context, bind and run the child over its full history, and build the
  // merged view. Dynamic edges only allocate their result rings here —
  // their pairs are runtime values, resolved via requestFor/resolvePending.
  async bindRequests(): Promise<void> {
    const specs = this.module.manifest.requests;
    specs.forEach((spec, rid) => {
      void spec;
      if (!this.requestOptions.has(rid)) {
        fatal(`request ${rid} was never given bind options`);
      }
      if (!spec.dynamic && !this.requestPairs.has(rid)) {
        fatal(`request ${rid} was never declared by bind`);
      }
    });
    if (specs.length > 0) {
      if (this.context.axis === null) {
        throw new BindError(
          'requests require a time axis on the primary context' +
            " (a csv context needs a 'time' column)",
        );
      }
      assertMergeAxis(this.context.axis, this.rows, 'primary context');
    }
    for (let rid = 0; rid < specs.length; rid += 1) {
      const spec = specs[rid];
      if (spec.dynamic) {
        this.requestRings[rid] = this.newRequestRing(spec);
        this.requestViews.push(null);
        continue;
      }
      this.requestRings[rid] = null;
      const pair = this.requestPairs.get(rid);
      if (pair === undefined) {
        return fatal(`request ${rid} was never declared by bind`);
      }
      const view = await this.resolveAndMerge(
        rid,
        spec,
        pair.symbol,
        pair.timeframe,
        message => new BindError(message),
      );
      const empty = this.shared.aggregateLayouts.empty(spec.layout);
      if (view === 'invalid') {
        this.requestViews.push({
          layout: spec.layout,
          at: () => empty,
          visitValues() {},
          releaseBuilder() {},
          releaseStorage() {},
        });
      } else {
        this.requestViews.push(view);
        view.releaseBuilder();
      }
    }
  }

  // One pair's full resolution: context, budget, axes, child bind + run
  // (suspension-aware — nested dynamic edges resolve as they arise), merge
  // mapping. 'invalid' = swallowed by ignore_invalid_symbol (warned, never
  // silent). makeError picks the failure type for context/merge failures:
  // BindError for static edges at bind, RequestError for dynamic pairs
  // mid-run. The shared unique-context ceiling is always a RequestError.
  private async resolveAndMerge(
    rid: number,
    spec: RequestSpec,
    symbol: string,
    timeframe: string,
    makeError: (message: string) => Error,
  ): Promise<MergedView | 'invalid'> {
    const what = `request '${symbol}','${timeframe}'`;

    // The cache owner calls this only for a new pair. Reserve its lifetime
    // budget before provider resolution so ignored-invalid pairs cannot grow
    // pairViews without participating in the same deterministic ceiling.
    this.shared.contextBudget.used += 1;
    if (this.shared.contextBudget.used > this.shared.contextBudget.max) {
      this.shared.contextBudget.used -= 1;
      throw new RequestError(
        `${what}: unique request contexts exceed the cap of ${this.shared.contextBudget.max}`,
      );
    }
    try {
      return await this.resolveAndMergeReserved(
        rid,
        spec,
        symbol,
        timeframe,
        makeError,
        what,
      );
    } catch (error) {
      // Hard failures are not cached, so a later retry of the same pair must
      // be able to reserve exactly once again.
      this.shared.contextBudget.used -= 1;
      throw error;
    }
  }

  private async resolveAndMergeReserved(
    rid: number,
    spec: RequestSpec,
    symbol: string,
    timeframe: string,
    makeError: (message: string) => Error,
    what: string,
  ): Promise<MergedView | 'invalid'> {
    const options = this.mustRequestOptions(rid);
    const resolveDone = requestLog.startTimer('context resolved');
    const resolved = await this.provider.resolveContext(
      symbol,
      timeframe,
      options.range,
    );
    if (isContextError(resolved)) {
      const invalidSymbol =
        resolved.error === 'unknownSymbol' ||
        resolved.error === 'unknownSource';
      if (options.ignoreInvalidSymbol && invalidSymbol) {
        // The na result is the ignore_invalid_symbol CONTRACT; the warn
        // reports it so a missing key or a typo is never silent.
        requestLog.warn('request context unavailable; values are na', {
          symbol,
          timeframe,
          error: resolved.error,
          detail: resolved.detail,
        });
        return 'invalid';
      }
      throw makeError(formatContextError(what, resolved));
    }
    const bounded = clampProviderContext(
      resolved,
      options.range,
      what,
      makeError,
    );
    resolveDone({symbol, timeframe, rows: bounded.rows});

    const parentAxis = this.context.axis;
    const childAxis = bounded.axis;
    if (parentAxis === null || childAxis === null) {
      throw makeError(
        `${what}: merge requires a time axis on both contexts` +
          " (a csv context needs a 'time' column)",
      );
    }
    assertMergeAxis(childAxis, bounded.rows, `${what} child context`);
    const childIdentity = effectiveContextIdentity(bounded, symbol, timeframe);

    const child = new JSRuntime(
      this.module.requests[rid],
      this.provider,
      null,
      bounded,
      childIdentity.symbol,
      childIdentity.timeframe,
      this.timeNow,
      this.paramValues,
      this.shared,
      this.maxCollectionElements,
      false,
    );
    try {
      await child.bindRequests();
      child.finishBind();
    } catch (error) {
      child.retireCompletedChild();
      throw error;
    }

    const executeDone = requestLog.startTimer('child executed');
    const builder = await runChildRows(
      child,
      spec.resultSlot,
      spec.layout,
      this.shared,
    );
    executeDone({symbol, rows: child.rows});

    let map: Int32Array;
    let empty: Value;
    try {
      map = sampleMergeMap(
        parentAxis,
        this.rows,
        childAxis,
        child.rows,
        options,
      );
      empty = this.shared.aggregateLayouts.empty(spec.layout);
    } catch (error) {
      // runChildRows has transferred ownership to the registered builder.
      // Until a MergedView is constructed, every post-child failure must
      // release that builder, its fixed-value lease, and the child runtime.
      this.shared.resultBuilders.delete(builder);
      builder.storageLease.release();
      child.retireCompletedChild();
      throw error;
    }
    const values = builder.values;
    const storageLease = builder.storageLease;
    let pendingBuilder: ResultBuilder | null = builder;
    let pendingChild: JSRuntime | null = child;
    const view: MergedView = {
      layout: spec.layout,
      at: row => {
        // Out-of-extent rows (a host executing past the bound extent) are
        // na, never an undefined leak.
        if (row < 0 || row >= map.length) {
          return empty;
        }
        const childRow = map[row];
        return childRow < 0 ? empty : values[childRow];
      },
      visitValues: visit => values.forEach(visit),
      releaseBuilder: () => {
        const completedBuilder = pendingBuilder;
        const completedChild = pendingChild;
        if (completedBuilder === null || completedChild === null) {
          return;
        }
        pendingBuilder = null;
        pendingChild = null;
        this.shared.resultBuilders.delete(completedBuilder);
        // Once the merged view owns every result value, no later execution
        // can observe the completed child's frames. Keeping it registered
        // would retain unrelated child-local aggregate state forever.
        completedChild.retireCompletedChild();
      },
      releaseStorage: () => storageLease.release(),
    };
    return view;
  }

  // Resolve the pair the last suspension recorded; idempotent when nothing
  // is pending. The host awaits this, then re-executes the suspended row.
  async resolvePending(): Promise<void> {
    const pending = this.pendingPair;
    if (pending === null) {
      return;
    }
    this.pendingPair = null;
    const key = pairKey(pending.rid, pending.symbol, pending.timeframe);
    if (this.pairViews.has(key)) {
      return;
    }
    const spec = this.module.manifest.requests[pending.rid];
    const view = await this.resolveAndMerge(
      pending.rid,
      spec,
      pending.symbol,
      pending.timeframe,
      message => new RequestError(message),
    );
    this.pairViews.set(key, view);
    if (view !== 'invalid') {
      view.releaseBuilder();
    }
  }

  // A dynamic edge's result ring: the parent-row history of "whatever the
  // request returned each row", whichever pair served it. Generated code
  // materializes dynamic request history through per-row Names (the noder),
  // so the ring serves hand-written modules; a bound depth has no report
  // channel here and cannot be sized honestly.
  private newRequestRing(spec: RequestSpec): Ring {
    const depth = spec.depth;
    if (depth.kind === 'bound') {
      return fatal(
        'bound request-ring depths are unsupported; materialize history through a name',
      );
    }
    const keep =
      depth.kind === 'const' || depth.kind === 'capped'
        ? Math.min(retentionForOffset(depth.bars), this.rows)
        : 0;
    return this.allocateRing(keep, spec.layout, 'request result Ring');
  }

  // The bind barrier: everything after this is the synchronous execution
  // phase — outputs declared, program frame allocated, no more awaits.
  finishBind(): void {
    this.phase = 'executing';
    if (this.sink !== null) {
      this.sink.declare({
        outputs: this.module.manifest.outputs.map((spec, oid) => ({
          spec,
          boundArgs: this.boundOutputArgs[oid],
        })),
        effects: this.module.manifest.effects.map(effect => effect.declaration),
      });
    }
  }

  private mustRoot(): FrameImpl {
    if (this.rootFrame === null) {
      return fatal('execution before finishBind');
    }
    return this.rootFrame;
  }

  private bindSeries(): void {
    const manifest = this.module.manifest;
    manifest.series.forEach((spec, sid) => {
      let id = spec.id;
      if (id === null) {
        const param = manifest.params.find(p => p.seriesSid === sid);
        if (param === undefined) {
          return fatal(`series slot ${sid} has neither host id nor param`);
        }
        id = this.paramValues[manifest.params.indexOf(param)] as string;
      }
      const data = this.context.series(id);
      if (data === null) {
        throw new BindError(`series '${id}' is not provided by this context`);
      }
      this.seriesData.push(data);
    });
  }

  private bindBuiltin(): void {
    let axisValidated = false;
    this.module.manifest.builtin.forEach((spec, bid) => {
      // Force every layout id through the registry even if this source is not
      // read until a later row.
      this.shared.aggregateLayouts.layout(spec.layout);
      const source = spec.source;
      if (source.domain === 'syminfo' || source.domain === 'timeframe') {
        const value = this.context.builtinValue(source);
        if (value === undefined) {
          throw new BindError(
            `builtin '${builtinSourceName(source)}' is not provided by this context`,
          );
        }
        this.shared.aggregateLayouts.assertValue(
          spec.layout,
          value,
          `provider builtin '${builtinSourceName(source)}'`,
        );
        this.builtinContextValues.set(bid, value);
        return;
      }
      if (
        source.domain === 'time' &&
        (source.field === 'time' || source.field === 'time_close')
      ) {
        const axis = this.context.axis;
        if (axis === null) {
          throw new BindError(
            `builtin '${source.field}' requires a time axis in this context`,
          );
        }
        if (!axisValidated) {
          assertMergeAxis(axis, this.rows, 'runtime context');
          axisValidated = true;
        }
      }
    });
  }

  private validateEffectSchemas(): void {
    const active = new Set<LayoutId>();
    const validate = (
      layoutId: LayoutId,
      schema: (typeof this.module.manifest.effects)[number]['declaration']['payload'],
    ): void => {
      if (active.has(layoutId)) {
        return fatal(`effect payload layout ${layoutId} is recursively sized`);
      }
      active.add(layoutId);
      const layout = this.shared.aggregateLayouts.layout(layoutId);
      switch (layout.kind) {
        case 'number':
          if (schema.kind !== layout.numeric) {
            return fatal(
              `effect payload layout ${layoutId} disagrees with logical ${schema.kind} schema`,
            );
          }
          break;
        case 'boolean':
          if (schema.kind !== 'bool') {
            return fatal(
              `effect payload layout ${layoutId} disagrees with logical ${schema.kind} schema`,
            );
          }
          break;
        case 'nullable-scalar':
          if (schema.kind !== layout.scalar) {
            return fatal(
              `effect payload layout ${layoutId} disagrees with logical ${schema.kind} schema`,
            );
          }
          break;
        case 'enum':
          if (
            schema.kind !== 'enum' ||
            schema.typeId !== layout.typeId ||
            schema.displayName !== layout.name ||
            schema.members.length !== layout.members.length ||
            schema.members.some(
              (member, index) => member.name !== layout.members[index],
            )
          ) {
            return fatal(
              `effect payload layout ${layoutId} disagrees with logical enum schema`,
            );
          }
          break;
        case 'user-type':
          if (
            schema.kind !== 'user-type' ||
            schema.typeId !== layout.typeId ||
            schema.displayName !== layout.name ||
            schema.fields.length !== layout.fields.length
          ) {
            return fatal(
              `effect payload layout ${layoutId} disagrees with logical user-type schema`,
            );
          }
          for (const [index, field] of layout.fields.entries()) {
            const logicalField = schema.fields[index];
            if (
              logicalField === undefined ||
              logicalField.name !== field.name
            ) {
              return fatal(
                `effect payload layout ${layoutId} disagrees at field ${index}`,
              );
            }
            validate(field.layout, logicalField.value);
          }
          break;
        case 'resource':
        case 'array':
        case 'matrix':
        case 'map':
        case 'tuple':
          return fatal(
            `effect payload layout ${layoutId} has unsupported ${layout.kind} transport`,
          );
      }
      active.delete(layoutId);
    };
    this.module.manifest.effects.forEach(effect =>
      validate(effect.layout, effect.declaration.payload),
    );
  }

  // ---- frames ---------------------------------------------------------------

  private newFrame(fid: number, active = false): FrameImpl {
    const layout = this.module.manifest.frames[fid];
    if (layout === undefined) {
      return fatal(`module has no frame layout ${fid}`);
    }
    const leaseCheckpoint = this.ringStorageLeases.length;
    try {
      const frame: FrameImpl = {
        kind: 'frame',
        fid,
        layout,
        committedActive: active,
        scratchActive: active,
        rings: layout.locals.map((local, slot) =>
          this.newRing(fid, slot, local.layout, local.storage, local.depth),
        ),
        committedInitialization: layout.locals.map(() => false),
        scratchInitialization: layout.locals.map(() => false),
        subs: layout.subs.map(() => null),
      };
      return frame;
    } catch (error) {
      this.releaseRingStorageSince(leaseCheckpoint);
      throw error;
    }
  }

  private newRing(
    fid: number,
    slot: number,
    layout: LayoutId,
    storage: string,
    depth: DepthSpec,
  ): Ring {
    if (this.provisionalBindFrames) {
      return this.allocateRing(0, layout, `provisional frame ${fid}:${slot}`);
    }
    const keep = this.localHistoryCapacity(fid, slot, storage, depth);
    return this.allocateRing(keep, layout, `frame ${fid}:${slot}`);
  }

  private localHistoryCapacity(
    fid: number,
    slot: number,
    storage: string,
    depth: DepthSpec,
  ): number {
    let keep: number;
    switch (depth.kind) {
      case 'none':
        keep = 0;
        break;
      case 'const':
      case 'capped':
        keep = retentionForOffset(depth.bars);
        break;
      case 'bound': {
        const bound = this.boundLocalDepths.get(`${fid}:${slot}`);
        if (bound === undefined) {
          return fatal(
            `bound depth for frame ${fid} slot ${slot} was never reported by bind`,
          );
        }
        keep = retentionForOffset(bound);
        break;
      }
    }
    // A fixed context can never expose more committed history than its row
    // extent, even when a bind-time offset is much larger.
    keep = Math.min(keep, this.rows);
    // var/varip must retain at least the last committed value: the next
    // row's scratch seeds from it even when the body never reads history.
    if (storage === Storage.Var || storage === Storage.Varip) {
      keep = Math.max(keep, 1);
    }
    return keep;
  }

  private allocateRing(keep: number, layout: LayoutId, what: string): Ring {
    const lease = reserveFixedValueStorage(this.shared, layout, keep + 1, what);
    try {
      const ring = new Ring(keep, layout, this.shared.aggregateLayouts);
      this.ringStorageLeases.push(lease);
      return ring;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  // Execution-start scratch protocol (docs/runtime.md): perBar resets to na;
  // initialized var/varip seed from their last committed value. An
  // uninitialized persistent slot stays empty and eligible for its lexical
  // InitName statement. varip alone keeps a successful same-row candidate.
  private resetFrameScratch(frame: FrameImpl, sameRow: boolean): void {
    if (!frame.scratchActive) {
      return;
    }
    frame.layout.locals.forEach((local, slot) => {
      const ring = frame.rings[slot];
      if (local.storage === Storage.Varip && sameRow) {
        return;
      }
      if (local.storage === Storage.Var || local.storage === Storage.Varip) {
        if (frame.committedInitialization[slot]) {
          ring.resetScratch(ring.lastCommitted());
          frame.scratchInitialization[slot] = true;
          return;
        }
        ring.resetScratch(ring.emptyValue);
        frame.scratchInitialization[slot] = false;
        return;
      }
      ring.resetScratch(ring.emptyValue);
      frame.scratchInitialization[slot] = false;
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        sub.scratchActive =
          sub.committedActive || (sameRow && sub.scratchActive);
        if (sub.scratchActive) {
          this.resetFrameScratch(sub, sameRow);
        }
      }
    }
  }

  private commitFrame(frame: FrameImpl): void {
    if (!frame.scratchActive) {
      return;
    }
    frame.committedActive = true;
    frame.rings.forEach((ring, slot) => {
      const storage = frame.layout.locals[slot]?.storage;
      if (storage === Storage.Var || storage === Storage.Varip) {
        frame.committedInitialization[slot] = frame.scratchInitialization[slot];
      }
      ring.commit();
      frame.scratchInitialization[slot] = false;
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.commitFrame(sub);
      }
    }
    frame.scratchActive = frame.fid === 0;
  }

  private captureActivation(
    frame: FrameImpl,
    out: Map<FrameImpl, boolean>,
  ): Map<FrameImpl, boolean> {
    out.set(frame, frame.scratchActive);
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.captureActivation(sub, out);
      }
    }
    return out;
  }

  private restoreActivation(
    frame: FrameImpl,
    snapshot: ReadonlyMap<FrameImpl, boolean>,
  ): void {
    frame.scratchActive = snapshot.get(frame) ?? frame.committedActive;
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.restoreActivation(sub, snapshot);
      }
    }
  }

  // ---- main loop ------------------------------------------------------------

  executeRow(row: number, provisional: boolean): void {
    this.assertLive();
    if (row !== this.committedRows) {
      return fatal(
        `executeRow(${row}) out of order: next committable row is ${this.committedRows}`,
      );
    }
    if (this.pendingFinalCommit !== null) {
      return fatal('executeRow before the prior final execution was committed');
    }
    // A suspended execution vanishes entirely. var/perBar re-seed from
    // committed state on every execution anyway; varip — which survives
    // same-row re-executions by design — restores from the snapshot taken
    // at the aborted transaction's start, so accumulation from prior COMPLETED
    // provisional ticks is preserved while the abort's writes are not.
    const sameRow = this.executedRow === row;
    this.suspendedRow = -1;
    this.cursor = row;
    this.executedRow = row;
    const transaction = this.shared.heap.beginTransaction(`row:${row}`);
    this.heapTransaction = transaction;
    this.activationSnapshot = this.captureActivation(
      this.mustRoot(),
      new Map(),
    );
    const retryAfterAbort = sameRow && this.varipSnapshot !== null;
    if (!retryAfterAbort) {
      // Capture the state that existed before this transaction. On a new row,
      // committed values are the pre-state; a missing entry means the ring
      // has never committed and its initializer must run again after abort.
      this.varipSnapshot = this.captureVarip(
        this.mustRoot(),
        new Map(),
        sameRow,
      );
    }
    let provisionalPublication: RowEmissionSnapshot | null = null;
    try {
      this.resetFrameScratch(this.mustRoot(), sameRow);
      if (retryAfterAbort) {
        this.restoreVarip(this.mustRoot());
      }
      for (const ring of this.requestRings) {
        ring?.resetScratch(ring.emptyValue);
      }
      this.emitBuf = new Map();
      this.effectBuf = [];
      this.module.main(this, this.mustRoot());
      const heapCommit = transaction.prepareCommit(
        this.heapCommitRoots(
          provisional ? 'provisional-candidate' : 'final-candidate',
        ),
      );
      const rowPublication = this.snapshotPublication(
        this.wantsDenseOutputs(row),
      );
      if (provisional) {
        heapCommit.commit();
        this.heapTransaction = null;
        this.varipSnapshot = null;
        this.activationSnapshot = null;
        provisionalPublication = rowPublication;
      } else {
        this.pendingFinalCommit = {
          heap: heapCommit,
          publication: rowPublication,
        };
      }
    } catch (error) {
      if (this.heapTransaction !== null) {
        this.heapTransaction.abort();
        this.heapTransaction = null;
      }
      this.discardTransactionScratch(this.mustRoot());
      if (this.activationSnapshot !== null) {
        this.restoreActivation(this.mustRoot(), this.activationSnapshot);
        this.activationSnapshot = null;
      }
      for (const ring of this.requestRings) {
        ring?.resetScratch(ring.emptyValue);
      }
      this.pendingFinalCommit = null;
      this.emitBuf = new Map();
      this.effectBuf = [];
      throw error;
    }
    if (provisionalPublication === null) {
      return;
    }
    try {
      this.publishRow(row, true, provisionalPublication);
    } finally {
      this.discardProvisionalScratch(this.mustRoot());
      for (const ring of this.requestRings) {
        ring?.resetScratch(ring.emptyValue);
      }
      this.collectShared('provisional-candidate');
    }
  }

  private captureVarip(
    frame: FrameImpl,
    out: Map<Ring, VaripSnapshot>,
    sameRow: boolean,
  ): Map<Ring, VaripSnapshot> {
    if (!frame.scratchActive) {
      return out;
    }
    frame.layout.locals.forEach((local, slot) => {
      if (local.storage === Storage.Varip) {
        const ring = frame.rings[slot];
        if (sameRow) {
          out.set(ring, {
            value: ring.peek(),
            initialized: frame.scratchInitialization[slot],
          });
        } else if (ring.hasCommitted()) {
          out.set(ring, {
            value: ring.lastCommitted(),
            initialized: frame.committedInitialization[slot],
          });
        }
      }
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.captureVarip(sub, out, sameRow);
      }
    }
    return out;
  }

  private restoreVarip(frame: FrameImpl): void {
    if (!frame.scratchActive) {
      return;
    }
    frame.layout.locals.forEach((local, slot) => {
      if (local.storage !== Storage.Varip) {
        return;
      }
      const ring = frame.rings[slot];
      const snapshot = this.varipSnapshot?.get(ring);
      if (snapshot !== undefined) {
        ring.setScratch(snapshot.value);
        frame.scratchInitialization[slot] = snapshot.initialized;
        return;
      }
      // The ring was born during the aborted transaction, or had no
      // pre-transaction
      // candidate: re-seed exactly as a fresh execution would.
      if (frame.committedInitialization[slot]) {
        ring.resetScratch(ring.lastCommitted());
        frame.scratchInitialization[slot] = true;
        return;
      }
      ring.resetScratch(ring.emptyValue);
      frame.scratchInitialization[slot] = false;
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.restoreVarip(sub);
      }
    }
  }

  commitRow(row: number): void {
    this.assertLive();
    if (row !== this.executedRow || row !== this.committedRows) {
      return fatal(`commitRow(${row}) without a matching execute`);
    }
    // Committing an aborted transaction would seal partial scratch into
    // history — protocol misuse.
    if (this.suspendedRow === row) {
      return fatal(
        `commitRow(${row}) after a suspended execution: await resolvePending() and re-execute the row first`,
      );
    }
    const pending = this.pendingFinalCommit;
    if (pending === null || this.heapTransaction === null) {
      return fatal(`commitRow(${row}) has no prepared final transition`);
    }
    pending.heap.commit();
    this.commitFrame(this.mustRoot());
    for (const ring of this.requestRings) {
      ring?.commit();
    }
    this.heapTransaction = null;
    this.pendingFinalCommit = null;
    this.varipSnapshot = null;
    this.activationSnapshot = null;
    this.committedRows = row + 1;
    try {
      this.publishRow(row, false, pending.publication);
    } finally {
      // Delivery is outside Tea's atomic transition. Even a failing sink
      // cannot skip post-commit reclamation or roll back published state.
      this.collectShared('committed-only');
    }
  }

  async runAll(): Promise<void> {
    this.assertLive();
    for (let row = 0; row < this.rows; row += 1) {
      for (;;) {
        try {
          this.executeRow(row, false);
          break;
        } catch (error) {
          if (error instanceof ContextSuspension) {
            await this.resolvePending();
            continue;
          }
          throw error;
        }
      }
      this.commitRow(row);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.shared.runtimes.delete(this);
    if (!this.ownsShared) {
      this.releaseOwnedFixedValueStorage();
      return;
    }
    this.shared.disposed = true;
    if (this.heapTransaction !== null) {
      this.heapTransaction.abort();
      this.heapTransaction = null;
    }
    this.pendingFinalCommit = null;
    for (const runtime of this.shared.runtimes) {
      runtime.disposed = true;
      runtime.releaseOwnedFixedValueStorage();
    }
    this.releaseOwnedFixedValueStorage();
    for (const builder of this.shared.resultBuilders) {
      builder.storageLease.release();
    }
    this.shared.resultBuilders.clear();
    this.shared.runtimes.clear();
    this.shared.heap.dispose();
    if (this.shared.fixedValueStorage.usedLogicalBytes !== 0) {
      return fatal(
        `fixed-value storage leaked ${this.shared.fixedValueStorage.usedLogicalBytes} bytes at disposal`,
      );
    }
  }

  retireCompletedChild(): void {
    if (this.ownsShared) {
      return fatal('cannot retire the root runtime as a completed child');
    }
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.shared.runtimes.delete(this);
    this.releaseOwnedFixedValueStorage();
  }

  private releaseRingStorage(): void {
    this.releaseRingStorageSince(0);
  }

  private releaseRingStorageSince(checkpoint: number): void {
    for (const lease of this.ringStorageLeases.splice(checkpoint)) {
      lease.release();
    }
  }

  private releaseOwnedFixedValueStorage(): void {
    this.releaseRingStorage();
    const views = new Set<MergedView>();
    for (const view of this.requestViews) {
      if (view !== null) {
        views.add(view);
      }
    }
    for (const view of this.pairViews.values()) {
      if (view !== 'invalid') {
        views.add(view);
      }
    }
    for (const view of views) {
      view.releaseStorage();
    }
    this.rootFrame = null;
    this.requestViews.length = 0;
    this.requestRings.length = 0;
    this.pairViews.clear();
    this.varipSnapshot = null;
    this.activationSnapshot = null;
  }

  private wantsDenseOutputs(row: number): boolean {
    return (
      this.sink?.capabilities?.denseRows !== 'final' || row === this.rows - 1
    );
  }

  private wantsEffects(): boolean {
    return this.sink !== null && this.sink.capabilities?.effects !== 'none';
  }

  private snapshotPublication(includeOutputs: boolean): RowEmissionSnapshot {
    return {
      outputs: includeOutputs
        ? [...this.emitBuf].map(([outputId, channels]) => ({
            outputId,
            channels: Object.freeze([...channels]),
          }))
        : [],
      effects: this.wantsEffects()
        ? this.effectBuf.map(effect => ({...effect}))
        : [],
    };
  }

  private publishRow(
    row: number,
    provisional: boolean,
    publication: RowEmissionSnapshot,
  ): void {
    if (this.sink === null) {
      return;
    }
    if (
      this.sink.capabilities?.denseRows === 'final' &&
      row !== this.rows - 1 &&
      publication.effects.length === 0
    ) {
      return;
    }
    const rowPublication: RowPublication = {
      row,
      ...(this.context.axis === null
        ? {}
        : {time: this.context.axis.time(row)}),
      outputs: publication.outputs,
      effects: publication.effects,
      provisional,
    };
    try {
      this.sink.publish(rowPublication);
    } catch (cause) {
      this.terminalSinkFailure = {cause};
      throw cause;
    }
  }

  visitHeapCommitRoots(
    mode: RingCommitMode,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    this.visitFrameCommit(this.mustRoot(), mode, visit);
    for (const ring of this.requestRings) {
      ring?.visitCommitValues(
        mode === 'provisional-candidate' ? 'committed-only' : mode,
        value => this.visitValueStorage(ring.layout, value, visit),
      );
    }
    for (const view of this.requestViews) {
      view?.visitValues(value =>
        this.visitValueStorage(view.layout, value, visit),
      );
    }
    for (const view of this.pairViews.values()) {
      if (view !== 'invalid') {
        view.visitValues(value =>
          this.visitValueStorage(view.layout, value, visit),
        );
      }
    }
  }

  visitHeapTransactionSafetyRoots(
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    this.visitFrameTransactionSafety(this.mustRoot(), visit);
    for (const ring of this.requestRings) {
      ring?.visitTransactionSafetyValues(value =>
        this.visitValueStorage(ring.layout, value, visit),
      );
    }
    for (const [ring, snapshot] of this.varipSnapshot ?? []) {
      this.visitValueStorage(ring.layout, snapshot.value, visit);
    }
  }

  private heapCommitRoots(mode: RingCommitMode): StorageRef<unknown>[] {
    const roots: StorageRef<unknown>[] = [];
    for (const runtime of this.shared.runtimes) {
      runtime.visitHeapCommitRoots(
        runtime === this ? mode : 'committed-only',
        ref => roots.push(ref),
      );
    }
    for (const builder of this.shared.resultBuilders) {
      builder.runtime.visitResultBuilderCandidate(builder, ref =>
        roots.push(ref),
      );
      builder.values.forEach(value =>
        this.visitValueStorage(builder.layout, value, ref => roots.push(ref)),
      );
    }
    return roots;
  }

  private visitResultBuilderCandidate(
    builder: ResultBuilder,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    if (builder.runtime !== this || this.executedRow !== this.committedRows) {
      return;
    }
    const ring = this.mustRoot().rings[builder.resultSlot];
    if (ring === undefined) {
      return fatal(
        `result builder refers to unknown slot ${builder.resultSlot}`,
      );
    }
    this.visitValueStorage(builder.layout, ring.peek(), visit);
  }

  private collectShared(mode: RingCommitMode): void {
    const committedRoots = this.heapCommitRoots(mode);
    const roots = [...committedRoots];
    for (const runtime of this.shared.runtimes) {
      runtime.visitHeapTransactionSafetyRoots(ref => roots.push(ref));
    }
    this.shared.heap.collect(roots, committedRoots);
  }

  private visitFrameCommit(
    frame: FrameImpl,
    mode: RingCommitMode,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    frame.rings.forEach((ring, slot) => {
      const local = frame.layout.locals[slot];
      const ringMode =
        mode === 'provisional-candidate' && local.storage !== Storage.Varip
          ? 'committed-only'
          : mode;
      ring.visitCommitValues(ringMode, value =>
        this.visitValueStorage(ring.layout, value, visit),
      );
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.visitFrameCommit(sub, mode, visit);
      }
    }
  }

  private visitFrameTransactionSafety(
    frame: FrameImpl,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    for (const ring of frame.rings) {
      ring.visitTransactionSafetyValues(value =>
        this.visitValueStorage(ring.layout, value, visit),
      );
    }
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.visitFrameTransactionSafety(sub, visit);
      }
    }
  }

  private visitValueStorage(
    layout: LayoutId,
    value: Value,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    this.shared.aggregateLayouts.visitStorageRefs(layout, value, visit);
  }

  private discardTransactionScratch(frame: FrameImpl): void {
    frame.rings.forEach((ring, slot) => {
      ring.resetScratch(ring.emptyValue);
      frame.scratchInitialization[slot] = false;
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.discardTransactionScratch(sub);
      }
    }
  }

  private discardProvisionalScratch(frame: FrameImpl): void {
    frame.layout.locals.forEach((local, slot) => {
      if (local.storage !== Storage.Varip) {
        frame.rings[slot].resetScratch(frame.rings[slot].emptyValue);
        frame.scratchInitialization[slot] = false;
      }
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.discardProvisionalScratch(sub);
      }
    }
  }

  // ---- rt surface -----------------------------------------------------------

  series(sid: number, offset: number): number {
    if (!isHistoryOffset(offset)) {
      return NaN;
    }
    const index = this.cursor - offset;
    const data = this.seriesData[sid];
    if (data === null || index < 0 || index >= data.length) {
      return NaN;
    }
    const value = data.at(index);
    if (Number.isFinite(value) || Number.isNaN(value)) {
      return value;
    }
    return fatal(
      `provider series ${sid} returned a non-finite value at row ${index}`,
    );
  }

  builtin(bid: number, offset: number): Value {
    const spec = this.module.manifest.builtin[bid];
    if (spec === undefined) {
      return fatal(`builtin read from unknown input ${bid}`);
    }
    const source = spec.source;
    if (this.phase === 'binding') {
      if (
        offset === 0 &&
        (source.domain === 'syminfo' || source.domain === 'timeframe')
      ) {
        return this.mustBuiltinContextValue(bid);
      }
      return fatal(
        `builtin '${builtinSourceName(source)}' is not bind-visible`,
      );
    }
    const empty = this.shared.aggregateLayouts.empty(spec.layout);
    if (!isHistoryOffset(offset)) {
      return empty;
    }
    const row = this.cursor - offset;
    if (row < 0 || row >= this.rows) {
      return empty;
    }

    let value: Value;
    switch (source.domain) {
      case 'time':
        switch (source.field) {
          case 'time':
            value = this.context.axis?.time(row) ?? empty;
            break;
          case 'time_close':
            value = this.context.axis?.closeTime(row) ?? empty;
            break;
          case 'timenow':
            value = this.timeNow;
            break;
        }
        break;
      case 'bar':
        switch (source.field) {
          case 'bar_index':
            value = row;
            break;
          case 'last_bar_index':
            value = this.rows - 1;
            break;
        }
        break;
      case 'barstate':
        switch (source.field) {
          case 'isfirst':
            value = row === 0;
            break;
          case 'islast':
            value = row === this.rows - 1;
            break;
          case 'ishistory':
          case 'isconfirmed':
          case 'isnew':
            value = true;
            break;
          case 'isrealtime':
            value = false;
            break;
        }
        break;
      case 'syminfo':
      case 'timeframe':
        value = this.mustBuiltinContextValue(bid);
        break;
    }
    this.shared.aggregateLayouts.assertValue(
      spec.layout,
      value,
      `builtin '${builtinSourceName(source)}'`,
    );
    return value;
  }

  param(pid: number): Value {
    return this.paramValues[pid];
  }

  read(fr: Frame, slot: number, offset: number): Value {
    return (fr as FrameImpl).rings[slot].at(offset);
  }

  write(fr: Frame, slot: number, v: Value): void {
    const ring = (fr as FrameImpl).rings[slot];
    if (ring === undefined) {
      return fatal(`write to unknown frame slot ${slot}`);
    }
    this.shared.aggregateLayouts.assertValue(ring.layout, v, 'Ring write');
    ring.setScratch(v);
  }

  needsInit(fr: Frame, slot: number): boolean {
    const frame = fr as FrameImpl;
    const local = frame.layout.locals[slot];
    if (
      local === undefined ||
      (local.storage !== Storage.Var && local.storage !== Storage.Varip)
    ) {
      return fatal(
        `needsInit requires a persistent slot; frame ${frame.fid} slot ${slot}`,
      );
    }
    return !frame.scratchInitialization[slot];
  }

  initialize(fr: Frame, slot: number, v: Value): void {
    const frame = fr as FrameImpl;
    const local = frame.layout.locals[slot];
    const ring = frame.rings[slot];
    if (
      local === undefined ||
      ring === undefined ||
      (local.storage !== Storage.Var && local.storage !== Storage.Varip)
    ) {
      return fatal(
        `initialize requires a persistent slot; frame ${frame.fid} slot ${slot}`,
      );
    }
    if (frame.scratchInitialization[slot]) {
      return fatal(`frame ${frame.fid} slot ${slot} is already initialized`);
    }
    this.shared.aggregateLayouts.assertValue(
      ring.layout,
      v,
      'Persistent initialization',
    );
    ring.setScratch(v);
    frame.scratchInitialization[slot] = true;
  }

  newUser(layout: LayoutId, fields: readonly Value[]): UserTypeValue {
    return newUserValue(this.shared.aggregateLayouts, layout, fields);
  }

  userField(value: Value, ownerLayout: LayoutId, index: number): Value {
    return userField(this.shared.aggregateLayouts, value, ownerLayout, index);
  }

  rebuildUserPath(
    root: Value,
    rootLayout: LayoutId,
    fieldIndices: readonly number[],
    leaf: Value,
  ): Value {
    return rebuildUserPath(
      this.shared.aggregateLayouts,
      root,
      rootLayout,
      fieldIndices,
      leaf,
    );
  }

  callCollection(
    operation: CollectionOperation,
    resultLayout: LayoutId,
    args: readonly Value[],
  ): Value {
    return this.collections.call(
      this.mustHeapTransaction(),
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
      this.mustHeapTransaction(),
      operation,
      collectionLayout,
      receiver,
      args,
    );
  }

  collectionEntries(value: Value): CollectionEntries {
    return this.collections.entries(value);
  }

  request(rid: number, offset: number): Value {
    const view = this.requestViews[rid];
    if (view === undefined) {
      return fatal(`request ${rid} has no merged view`);
    }
    const spec = this.module.manifest.requests[rid];
    if (spec === undefined) {
      return fatal(`request ${rid} has no manifest entry`);
    }
    if (!isHistoryOffset(offset)) {
      return this.shared.aggregateLayouts.empty(spec.layout);
    }
    // Dynamic edge: reads go through the result ring — the parent-row
    // history of whatever the request returned, whichever pair served it.
    if (view === null) {
      const ring = this.requestRings[rid];
      if (ring === null || ring === undefined) {
        return fatal(`dynamic request ${rid} has no result ring`);
      }
      return ring.at(offset);
    }
    // Out-of-extent reads (including runtime-computed negative offsets) are
    // na, exactly like rt.series.
    const index = this.cursor - offset;
    if (index < 0 || index >= this.rows) {
      return this.shared.aggregateLayouts.empty(spec.layout);
    }
    return view.at(index);
  }

  requestFor(rid: number, symbol: Value, timeframe: Value): Value {
    const spec = this.module.manifest.requests[rid];
    const ring = this.requestRings[rid];
    if (spec === undefined || ring === null || ring === undefined) {
      return fatal(`requestFor on non-dynamic request ${rid}`);
    }
    const empty = this.shared.aggregateLayouts.empty(spec.layout);
    // na context args yield na for the row — there is no context to ask.
    if (symbol === null || timeframe === null) {
      ring.setScratch(empty);
      return empty;
    }
    if (typeof symbol !== 'string' || typeof timeframe !== 'string') {
      return fatal(`request ${rid} context args must be strings`);
    }
    const pair = this.inheritedRequestPair(symbol, timeframe);
    const view = this.pairViews.get(pairKey(rid, pair.symbol, pair.timeframe));
    if (view === undefined) {
      // Unresolved pair: record it, mark the row so its retry does a full
      // reset, and hand control to the host's await point.
      this.pendingPair = {rid, ...pair};
      this.suspendedRow = this.cursor;
      throw new ContextSuspension(pair.symbol, pair.timeframe);
    }
    const value = view === 'invalid' ? empty : view.at(this.cursor);
    ring.setScratch(value);
    return value;
  }

  root(): Frame {
    return this.mustRoot();
  }

  frame(fr: Frame, slot: number): Frame {
    const impl = fr as FrameImpl;
    const spec = impl.layout.subs[slot];
    if (spec === undefined) {
      return fatal(`frame ${impl.fid} has no call-site slot ${slot}`);
    }
    let child = impl.subs[slot];
    if (child === null) {
      child = this.newFrame(spec.fid);
      impl.subs[slot] = child;
    }
    if (!child.scratchActive) {
      child.scratchActive = true;
      this.resetFrameScratch(child, false);
    }
    return child;
  }

  emit(oid: number, channel: number, v: Value): void {
    if (
      isUserTypeValue(v) ||
      isArrayValue(v) ||
      isMatrixValue(v) ||
      isMapValue(v) ||
      isTupleValue(v)
    ) {
      return fatal('aggregate values cannot cross an output channel in V1');
    }
    let channels = this.emitBuf.get(oid);
    if (channels === undefined) {
      const spec = this.module.manifest.outputs[oid];
      channels = new Array<Value>(spec.channels.length).fill(NaN);
      this.emitBuf.set(oid, channels);
    }
    channels[channel] = v;
  }

  emitEffect(effectId: number, payload: Value): void {
    if (this.phase !== 'executing') {
      return fatal('emitEffect outside the module execution phase');
    }
    const spec = this.module.manifest.effects[effectId];
    if (spec === undefined) {
      return fatal(`effect emission references unknown effect ${effectId}`);
    }
    this.shared.aggregateLayouts.assertValue(
      spec.layout,
      payload,
      `effect ${effectId} payload`,
    );
    if (!this.wantsEffects()) {
      return;
    }
    this.effectBuf.push({
      effectId,
      payload: this.logicalEffectValue(spec.declaration.payload, payload),
    });
  }

  private logicalEffectValue(
    schema: EffectValueSchema,
    value: Value,
  ): EffectValue {
    if (schema.kind !== 'user-type' || value === null) {
      if (
        typeof value === 'number' ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        return value;
      }
      return fatal(`non-scalar value reached logical ${schema.kind} effect`);
    }
    if (!isUserTypeValue(value)) {
      return fatal(`non-user value reached logical ${schema.typeId} effect`);
    }
    return Object.freeze({
      kind: 'user-type' as const,
      fields: Object.freeze(
        schema.fields.map((field, index) =>
          this.logicalEffectValue(field.value, value.fields[index]),
        ),
      ),
    });
  }

  bindDepth(fid: number, slot: number, bars: number): void {
    this.assertBinding('bindDepth');
    this.boundLocalDepths.set(`${fid}:${slot}`, retentionForOffset(bars));
  }

  historyDepth(offset: number): number {
    this.assertBinding('historyDepth');
    return retentionForOffset(offset);
  }

  bindSeriesDepth(sid: number, bars: number): void {
    this.assertBinding('bindSeriesDepth');
    // A contract to the provider, not an allocation: recorded for hosts
    // that page history; the csv provider ignores it.
    void sid;
    void retentionForOffset(bars);
  }

  bindBuiltinDepth(bid: number, bars: number): void {
    this.assertBinding('bindBuiltinDepth');
    if (this.module.manifest.builtin[bid] === undefined) {
      return fatal(`bindBuiltinDepth on unknown builtin ${bid}`);
    }
    void retentionForOffset(bars);
  }

  bindOutput(oid: number, argName: string, v: Value): void {
    this.assertBinding('bindOutput');
    this.boundOutputArgs[oid].push({name: argName, value: v});
  }

  bindParamActive(pid: number, active: Value): void {
    this.assertBinding('bindParamActive');
    if (this.module.manifest.params[pid] === undefined) {
      return fatal(`bindParamActive on unknown parameter ${pid}`);
    }
    if (typeof active !== 'boolean') {
      return fatal(`parameter ${pid} active expression did not produce bool`);
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
    this.assertBinding('bindRequestOptions');
    if (this.module.manifest.requests[rid] === undefined) {
      return fatal(`bindRequestOptions on unknown request ${rid}`);
    }
    if (this.requestOptions.has(rid)) {
      return fatal(`request ${rid} bind options were reported twice`);
    }
    if (
      typeof gaps !== 'boolean' ||
      typeof lookahead !== 'boolean' ||
      typeof ignoreInvalidSymbol !== 'boolean'
    ) {
      throw new BindError(
        `request ${rid}: gaps, lookahead, and ignore_invalid_symbol must bind to bool values`,
      );
    }
    if (
      typeof calcBarsCount !== 'number' ||
      !Number.isSafeInteger(calcBarsCount) ||
      calcBarsCount < 0
    ) {
      throw new BindError(
        `request ${rid}: calc_bars_count must bind to a non-negative safe integer`,
      );
    }
    this.requestOptions.set(rid, {
      gaps,
      lookahead,
      ignoreInvalidSymbol,
      range:
        calcBarsCount === 0
          ? FULL_RANGE
          : {kind: 'trailing-bars', bars: calcBarsCount},
    });
  }

  bindRequest(rid: number, symbol: Value, timeframe: Value): void {
    this.assertBinding('bindRequest');
    const spec = this.module.manifest.requests[rid];
    if (spec === undefined) {
      return fatal(`bindRequest on unknown request ${rid}`);
    }
    if (spec.dynamic) {
      return fatal(`bindRequest on dynamic request ${rid}`);
    }
    if (this.requestPairs.has(rid)) {
      return fatal(`request ${rid} context was reported twice`);
    }
    if (typeof symbol !== 'string' || typeof timeframe !== 'string') {
      throw new BindError(
        `request ${rid}: symbol and timeframe must bind to strings`,
      );
    }
    this.requestPairs.set(rid, this.inheritedRequestPair(symbol, timeframe));
  }

  private inheritedRequestPair(
    symbol: string,
    timeframe: string,
  ): {symbol: string; timeframe: string} {
    return {
      symbol: symbol === '' ? this.contextSymbol : symbol,
      timeframe: timeframe === '' ? this.contextTimeframe : timeframe,
    };
  }

  private mustRequestOptions(rid: number): BoundRequestOptions {
    const options = this.requestOptions.get(rid);
    if (options === undefined) {
      return fatal(`request ${rid} has no bound options`);
    }
    return options;
  }

  private mustBuiltinContextValue(bid: number): Value {
    if (!this.builtinContextValues.has(bid)) {
      return fatal(`builtin ${bid} has no bound value`);
    }
    return this.builtinContextValues.get(bid) as Value;
  }

  private assertBinding(what: string): void {
    if (this.phase !== 'binding') {
      fatal(`${what} outside the module's binding phase`);
    }
  }

  private mustHeapTransaction(): HeapTransaction {
    if (this.heapTransaction === null) {
      return fatal('aggregate operation outside a runtime transaction');
    }
    return this.heapTransaction;
  }

  private assertLive(): void {
    if (this.disposed || this.shared.disposed) {
      fatal('runtime is disposed');
    }
    if (this.terminalSinkFailure !== null) {
      throw this.terminalSinkFailure.cause;
    }
  }
}
