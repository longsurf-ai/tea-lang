// Purpose: The JS runtime — implements the Runtime ABI and owns the main loop: binding, frame trees, ring allocation, request-child scheduling, the provisional/commit protocol, and emission flushing. docs/runtime.md and docs/requests.md are the authorities.

import {log} from '../base/log';
import {fatal} from '../base/print';
import {Storage} from '../ir/node';
import {
  BindError,
  ContextSuspension,
  isArrayValue,
  isContextError,
  isMapValue,
  isMatrixValue,
  isTupleValue,
  isUserTypeValue,
  RequestError,
  type BindInputs,
  type BoundInput,
  type BoundProgram,
  type CollectionEntries,
  type CollectionMutation,
  type CollectionMutationOperation,
  type CollectionOperation,
  type ContextBudget,
  type ContextError,
  type DataProvider,
  type DepthSpec,
  ExecutionError,
  type FixedValueStorageBudget,
  type Frame,
  type FrameLayout,
  type ModuleCode,
  type ModuleManifest,
  type OutputSink,
  type ProviderContext,
  type RangeDemand,
  type RequestSpec,
  type Runtime,
  type SeriesData,
  type TeaModule,
  type UserTypeValue,
  type Value,
} from './abi';
import {CollectionRuntime} from './collections';
import {
  HeapArena,
  type HeapAttempt,
  type PreparedHeapPublication,
  type StorageRef,
} from './heap';
import {assertMergeAxis, sampleMergeMap} from './merge';
import {isHistoryOffset, Ring, type RingPublicationMode} from './ring';
import {rebuildUserPath, newUserValue, userField} from './user-value';
import {type LayoutId, ValueLayoutRegistry} from './value-layout';

// Slice scope: static requests resolve their full extent at bind; range
// narrowing (depth demands, calc_bars_count) is a later refinement.
const FULL_RANGE: RangeDemand = {from: null, to: null, bars: null};
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
  if (abi !== 3) {
    throw new BindError(`unsupported module ABI ${String(abi)}`);
  }
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
  const params = resolveParams(module.manifest, inputs.params);
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

function pairKey(rid: number, symbol: string, timeframe: string): string {
  return `${rid}\u0000${symbol}\u0000${timeframe}`;
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

// Param resolution is a pure function of the manifest and the host's raw
// values; request children skip it — bind-time params are compilation-global
// and children inherit the parent's resolved values.
function resolveParams(
  manifest: ModuleManifest,
  raw: Readonly<Record<string, unknown>>,
): Value[] {
  const specs = manifest.params;
  const known = new Set(specs.map(spec => spec.name));
  for (const name of Object.keys(raw)) {
    if (!known.has(name)) {
      throw new BindError(`unknown parameter '${name}'`);
    }
  }
  const values: Value[] = [];
  for (const spec of specs) {
    const provided = raw[spec.name];
    const candidate = provided !== undefined ? provided : spec.defaultValue;
    let value: Value;
    if (spec.type === 'int' || spec.type === 'float') {
      if (typeof candidate !== 'number') {
        throw new BindError(`parameter '${spec.name}' expects a number`);
      }
      if (!Number.isFinite(candidate)) {
        throw new BindError(`parameter '${spec.name}' expects a finite number`);
      }
      if (spec.type === 'int' && !Number.isSafeInteger(candidate)) {
        throw new BindError(`parameter '${spec.name}' expects a safe integer`);
      }
      value = candidate;
    } else if (spec.type === 'bool') {
      if (typeof candidate !== 'boolean') {
        throw new BindError(`parameter '${spec.name}' expects a boolean`);
      }
      value = candidate;
    } else if (spec.type === 'color') {
      if (typeof candidate !== 'string') {
        throw new BindError(`parameter '${spec.name}' expects a color`);
      }
      const color = canonicalInputColor(candidate);
      if (color === null) {
        throw new BindError(
          `parameter '${spec.name}' expects #RRGGBB or #RRGGBBAA`,
        );
      }
      value = color;
    } else if (spec.type === 'enum') {
      if (typeof candidate !== 'string') {
        throw new BindError(`parameter '${spec.name}' expects an enum member`);
      }
      const enumType = spec.enumType;
      if (enumType === null) {
        return fatal(`enum parameter '${spec.name}' has no enum metadata`);
      }
      if (!enumType.members.some(member => member.name === candidate)) {
        throw new BindError(
          `parameter '${spec.name}' is not a member of enum '${enumType.name}'`,
        );
      }
      value = candidate;
    } else {
      if (typeof candidate !== 'string') {
        throw new BindError(`parameter '${spec.name}' expects a string`);
      }
      value = candidate;
    }
    const c = spec.constraints;
    if (c?.kind === 'range') {
      if (typeof value !== 'number') {
        return fatal(
          `non-numeric parameter '${spec.name}' has range constraints`,
        );
      }
      if (c.minval !== null && value < c.minval) {
        throw new BindError(
          `parameter '${spec.name}' below minval ${c.minval}`,
        );
      }
      if (c.maxval !== null && value > c.maxval) {
        throw new BindError(
          `parameter '${spec.name}' above maxval ${c.maxval}`,
        );
      }
    } else if (
      c?.kind === 'options' &&
      !c.options.some(option => option === value)
    ) {
      throw new BindError(
        `parameter '${spec.name}' must be one of ${c.options.map(String).join(', ')}`,
      );
    }
    values.push(value);
  }
  return values;
}

function canonicalInputColor(value: string): string | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (match === null) {
    return null;
  }
  const base = `#${match[1].toUpperCase()}`;
  const alpha = match[2]?.toUpperCase();
  return alpha === undefined || alpha === 'FF' ? base : `${base}${alpha}`;
}

interface FrameImpl extends Frame {
  readonly fid: number;
  readonly layout: FrameLayout;
  readonly rings: Ring[];
  readonly subs: (FrameImpl | null)[];
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
  readonly heap: PreparedHeapPublication;
  readonly emissions: ReadonlyMap<number, readonly Value[]>;
}

type Phase = 'binding' | 'executing';

class JSRuntime implements Runtime, BoundProgram {
  readonly rows: number;
  readonly inputs: readonly BoundInput[];

  private phase: Phase = 'binding';
  private readonly paramValues: readonly Value[];
  private readonly paramActive: boolean[];
  private readonly seriesData: (SeriesData | null)[] = [];
  // Runtime-owned virtual series: the axis ordinal itself.
  private readonly barIndexSids = new Set<number>();
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
  // the snapshot taken at the aborted attempt's start (var/perBar re-seed
  // from committed anyway), so results are byte-identical to having had
  // the data upfront — including varip accumulated by prior COMPLETED
  // provisional ticks of the same row.
  private suspendedRow = -1;
  private varipSnapshot: Map<Ring, Value> | null = null;
  private rootFrame: FrameImpl | null = null;
  // module.bind needs real frame identity for input aliases/UDFs before bound
  // capacities are known. Its frames therefore use scratch-only rings and are
  // discarded; the final tree is rebuilt immediately after all depth reports.
  private provisionalBindFrames = false;
  private readonly collections: CollectionRuntime;
  private readonly ringStorageLeases: FixedValueStorageLease[] = [];
  private heapAttempt: HeapAttempt | null = null;
  private pendingFinalCommit: PendingFinalCommit | null = null;
  private disposed = false;

  // Main-loop state.
  private cursor = -1;
  private committedRows = 0;
  private executedRow = -1;
  private emitBuf = new Map<number, Value[]>();

  // The runtime instance for one module against one resolved context —
  // request children recurse through the same class with a null sink, the
  // parent's resolved params, and the shared context budget.
  constructor(
    private readonly module: ModuleCode,
    private readonly provider: DataProvider,
    private readonly sink: OutputSink | null,
    private readonly context: ProviderContext,
    params: readonly Value[],
    private readonly shared: SharedRuntimeState,
    private readonly maxCollectionElements: number,
    private readonly ownsShared: boolean,
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
    this.paramActive = module.manifest.params.map(() => true);
    this.boundOutputArgs = module.manifest.outputs.map(() => []);
    this.collections = new CollectionRuntime(
      shared.heap,
      shared.aggregateLayouts,
      maxCollectionElements,
    );

    try {
      const attempt = shared.heap.beginAttempt(`bind:${shared.runtimes.size}`);
      this.heapAttempt = attempt;
      try {
        // Reserved frame-free preparation runs before any frame exists.
        this.module.init(this);

        this.bindSeries();

        // One context, one axis: the context owns the row space, and every
        // series it serves must fill it — the runtime refuses misaligned data
        // instead of silently truncating.
        this.rows = context.rows;
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
        this.rootFrame = this.newFrame(0);
        this.module.bind(this, this.rootFrame);
        this.provisionalBindFrames = false;
        this.rootFrame = null;
        this.releaseRingStorage();
        this.rootFrame = this.newFrame(0);
        this.inputs = module.manifest.params.map((spec, pid) => ({
          spec,
          value: this.paramValues[pid],
          active: this.paramActive[pid],
        }));
      } finally {
        attempt.abort();
        this.heapAttempt = null;
        this.provisionalBindFrames = false;
      }
      shared.runtimes.add(this);
    } catch (error) {
      this.releaseOwnedFixedValueStorage();
      throw error;
    }
  }

  // ---- binding --------------------------------------------------------------

  // Resolve every static request edge before row 0: fetch the child
  // context, bind and run the child over its full history, and build the
  // merged view. Dynamic edges only allocate their result rings here —
  // their pairs are runtime values, resolved via requestFor/resolvePending.
  async bindRequests(): Promise<void> {
    const specs = this.module.manifest.requests;
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
    const resolveDone = requestLog.startTimer('context resolved');
    const resolved = await this.provider.resolveContext(
      symbol,
      timeframe,
      FULL_RANGE,
    );
    if (isContextError(resolved)) {
      const invalidSymbol =
        resolved.error === 'unknownSymbol' ||
        resolved.error === 'unknownSource';
      if (spec.merge.ignoreInvalidSymbol && invalidSymbol) {
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
    resolveDone({symbol, timeframe, rows: resolved.rows});

    const parentAxis = this.context.axis;
    const childAxis = resolved.axis;
    if (parentAxis === null || childAxis === null) {
      throw makeError(
        `${what}: merge requires a time axis on both contexts` +
          " (a csv context needs a 'time' column)",
      );
    }
    assertMergeAxis(childAxis, resolved.rows, `${what} child context`);

    const child = new JSRuntime(
      this.module.requests[rid],
      this.provider,
      null,
      resolved,
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
        spec.merge,
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
      this.sink.declare(
        this.module.manifest.outputs.map((spec, oid) => ({
          spec,
          boundArgs: this.boundOutputArgs[oid],
        })),
      );
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
      // bar_index is the runtime's own axis ordinal, never provider data.
      if (id === 'bar_index') {
        this.barIndexSids.add(sid);
        this.seriesData.push(null);
        return;
      }
      const data = this.context.series(id);
      if (data === null) {
        throw new BindError(`series '${id}' is not provided by this context`);
      }
      this.seriesData.push(data);
    });
  }

  // ---- frames ---------------------------------------------------------------

  private newFrame(fid: number): FrameImpl {
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
        rings: layout.locals.map((local, slot) =>
          this.newRing(fid, slot, local.layout, local.storage, local.depth),
        ),
        subs: layout.subs.map(() => null),
      };
      // A frame created mid-execution seeds its scratch immediately (its
      // first execution is the current one).
      if (this.phase === 'executing' && this.cursor >= 0) {
        this.resetFrameScratch(frame, false);
      }
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
    return this.allocateRing(keep, layout, `frame ${fid}:${slot}`);
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
  // var/varip seed from the last committed value — and until anything is
  // committed, their init thunks re-run each execution (a provisional first
  // row rolls back to its initializer). varip alone keeps its scratch
  // across same-row re-executions.
  private resetFrameScratch(frame: FrameImpl, sameRow: boolean): void {
    frame.layout.locals.forEach((local, slot) => {
      const ring = frame.rings[slot];
      if (local.storage === Storage.Varip && sameRow) {
        return;
      }
      if (local.storage === Storage.Var || local.storage === Storage.Varip) {
        if (ring.hasCommitted()) {
          ring.resetScratch(ring.lastCommitted());
          return;
        }
        ring.resetScratch(ring.emptyValue);
        const thunk = this.module.inits[`${frame.fid}:${slot}`];
        if (thunk !== undefined) {
          ring.setScratch(thunk(this, frame));
        }
        return;
      }
      ring.resetScratch(ring.emptyValue);
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.resetFrameScratch(sub, sameRow);
      }
    }
  }

  private commitFrame(frame: FrameImpl): void {
    for (const ring of frame.rings) {
      ring.commit();
    }
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.commitFrame(sub);
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
    // at the aborted attempt's start, so accumulation from prior COMPLETED
    // provisional ticks is preserved while the abort's writes are not.
    const sameRow = this.executedRow === row;
    this.suspendedRow = -1;
    this.cursor = row;
    this.executedRow = row;
    const attempt = this.shared.heap.beginAttempt(`row:${row}`);
    this.heapAttempt = attempt;
    const retryAfterAbort = sameRow && this.varipSnapshot !== null;
    if (!retryAfterAbort) {
      // Capture the state that existed before this attempt. On a new row,
      // committed values are the pre-state; a missing entry means the ring
      // has never committed and its initializer must run again after abort.
      this.varipSnapshot = this.captureVarip(
        this.mustRoot(),
        new Map(),
        sameRow,
      );
    }
    let provisionalEmissions: ReadonlyMap<number, readonly Value[]> | null =
      null;
    try {
      this.resetFrameScratch(this.mustRoot(), sameRow);
      if (retryAfterAbort) {
        this.restoreVarip(this.mustRoot());
      }
      for (const ring of this.requestRings) {
        ring?.resetScratch(ring.emptyValue);
      }
      this.emitBuf = new Map();
      this.module.main(this, this.mustRoot());
      const publication = attempt.preparePublication(
        this.publicationRoots(
          provisional ? 'provisional-candidate' : 'final-candidate',
        ),
      );
      const emissions = this.snapshotEmissions();
      if (provisional) {
        publication.publish();
        this.heapAttempt = null;
        this.varipSnapshot = null;
        provisionalEmissions = emissions;
      } else {
        this.pendingFinalCommit = {heap: publication, emissions};
      }
    } catch (error) {
      if (this.heapAttempt !== null) {
        this.heapAttempt.abort();
        this.heapAttempt = null;
      }
      this.discardAttemptScratch(this.mustRoot());
      for (const ring of this.requestRings) {
        ring?.resetScratch(ring.emptyValue);
      }
      this.pendingFinalCommit = null;
      this.emitBuf = new Map();
      throw error;
    }
    if (provisionalEmissions === null) {
      return;
    }
    try {
      this.flushEmissions(row, true, provisionalEmissions);
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
    out: Map<Ring, Value>,
    sameRow: boolean,
  ): Map<Ring, Value> {
    frame.layout.locals.forEach((local, slot) => {
      if (local.storage === Storage.Varip) {
        const ring = frame.rings[slot];
        if (sameRow) {
          out.set(ring, ring.peek());
        } else if (ring.hasCommitted()) {
          out.set(ring, ring.lastCommitted());
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
    frame.layout.locals.forEach((local, slot) => {
      if (local.storage !== Storage.Varip) {
        return;
      }
      const ring = frame.rings[slot];
      const snapshot = this.varipSnapshot?.get(ring);
      if (snapshot !== undefined) {
        ring.setScratch(snapshot);
        return;
      }
      // The ring was born during the aborted attempt: re-seed exactly as a
      // fresh execution would.
      if (ring.hasCommitted()) {
        ring.resetScratch(ring.lastCommitted());
        return;
      }
      ring.resetScratch(ring.emptyValue);
      const thunk = this.module.inits[`${frame.fid}:${slot}`];
      if (thunk !== undefined) {
        ring.setScratch(thunk(this, frame));
      }
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
    // Committing an aborted attempt would seal partial scratch into
    // history — protocol misuse.
    if (this.suspendedRow === row) {
      return fatal(
        `commitRow(${row}) after a suspended execution: await resolvePending() and re-execute the row first`,
      );
    }
    const pending = this.pendingFinalCommit;
    if (pending === null || this.heapAttempt === null) {
      return fatal(`commitRow(${row}) has no prepared final transition`);
    }
    pending.heap.publish();
    this.commitFrame(this.mustRoot());
    for (const ring of this.requestRings) {
      ring?.commit();
    }
    this.heapAttempt = null;
    this.pendingFinalCommit = null;
    this.varipSnapshot = null;
    this.committedRows = row + 1;
    try {
      this.flushEmissions(row, false, pending.emissions);
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
    if (this.heapAttempt !== null) {
      this.heapAttempt.abort();
      this.heapAttempt = null;
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
  }

  private snapshotEmissions(): ReadonlyMap<number, readonly Value[]> {
    return new Map(
      [...this.emitBuf].map(([oid, channels]) => [
        oid,
        Object.freeze([...channels]),
      ]),
    );
  }

  private flushEmissions(
    row: number,
    provisional: boolean,
    emissions: ReadonlyMap<number, readonly Value[]>,
  ): void {
    if (this.sink === null) {
      return;
    }
    for (const [oid, channels] of emissions) {
      this.sink.emit(row, oid, channels, provisional);
    }
  }

  visitPublicationHeapRoots(
    mode: RingPublicationMode,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    this.visitFramePublication(this.mustRoot(), mode, visit);
    for (const ring of this.requestRings) {
      ring?.visitPublicationValues(
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

  visitAttemptSafetyHeapRoots(visit: (ref: StorageRef<unknown>) => void): void {
    this.visitFrameSafety(this.mustRoot(), visit);
    for (const ring of this.requestRings) {
      ring?.visitAttemptSafetyValues(value =>
        this.visitValueStorage(ring.layout, value, visit),
      );
    }
    for (const [ring, value] of this.varipSnapshot ?? []) {
      this.visitValueStorage(ring.layout, value, visit);
    }
  }

  private publicationRoots(mode: RingPublicationMode): StorageRef<unknown>[] {
    const roots: StorageRef<unknown>[] = [];
    for (const runtime of this.shared.runtimes) {
      runtime.visitPublicationHeapRoots(
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

  private collectShared(mode: RingPublicationMode): void {
    const publication = this.publicationRoots(mode);
    const roots = [...publication];
    for (const runtime of this.shared.runtimes) {
      runtime.visitAttemptSafetyHeapRoots(ref => roots.push(ref));
    }
    this.shared.heap.collect(roots, publication);
  }

  private visitFramePublication(
    frame: FrameImpl,
    mode: RingPublicationMode,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    frame.rings.forEach((ring, slot) => {
      const local = frame.layout.locals[slot];
      const ringMode =
        mode === 'provisional-candidate' && local.storage !== Storage.Varip
          ? 'committed-only'
          : mode;
      ring.visitPublicationValues(ringMode, value =>
        this.visitValueStorage(ring.layout, value, visit),
      );
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.visitFramePublication(sub, mode, visit);
      }
    }
  }

  private visitFrameSafety(
    frame: FrameImpl,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    for (const ring of frame.rings) {
      ring.visitAttemptSafetyValues(value =>
        this.visitValueStorage(ring.layout, value, visit),
      );
    }
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.visitFrameSafety(sub, visit);
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

  private discardAttemptScratch(frame: FrameImpl): void {
    for (const ring of frame.rings) {
      ring.resetScratch(ring.emptyValue);
    }
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.discardAttemptScratch(sub);
      }
    }
  }

  private discardProvisionalScratch(frame: FrameImpl): void {
    frame.layout.locals.forEach((local, slot) => {
      if (local.storage !== Storage.Varip) {
        frame.rings[slot].resetScratch(frame.rings[slot].emptyValue);
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
    if (this.barIndexSids.has(sid)) {
      return index < 0 ? NaN : index;
    }
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
      this.mustHeapAttempt(),
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
      this.mustHeapAttempt(),
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
    const view = this.pairViews.get(pairKey(rid, symbol, timeframe));
    if (view === undefined) {
      // Unresolved pair: record it, mark the row so its retry does a full
      // reset, and hand control to the host's await point.
      this.pendingPair = {rid, symbol, timeframe};
      this.suspendedRow = this.cursor;
      throw new ContextSuspension(symbol, timeframe);
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
    const existing = impl.subs[slot];
    if (existing !== null) {
      return existing;
    }
    const spec = impl.layout.subs[slot];
    if (spec === undefined) {
      return fatal(`frame ${impl.fid} has no call-site slot ${slot}`);
    }
    const created = this.newFrame(spec.fid);
    impl.subs[slot] = created;
    return created;
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

  bindRequest(rid: number, symbol: Value, timeframe: Value): void {
    this.assertBinding('bindRequest');
    if (typeof symbol !== 'string' || typeof timeframe !== 'string') {
      throw new BindError(
        `request ${rid}: symbol and timeframe must bind to strings`,
      );
    }
    this.requestPairs.set(rid, {symbol, timeframe});
  }

  private assertBinding(what: string): void {
    if (this.phase !== 'binding') {
      fatal(`${what} outside the module's binding phase`);
    }
  }

  private mustHeapAttempt(): HeapAttempt {
    if (this.heapAttempt === null) {
      return fatal('aggregate operation outside a runtime attempt');
    }
    return this.heapAttempt;
  }

  private assertLive(): void {
    if (this.disposed || this.shared.disposed) {
      fatal('runtime is disposed');
    }
  }
}
