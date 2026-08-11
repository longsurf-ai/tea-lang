// Purpose: The runtime ABI contract — the complete surface generated code, providers, and sinks see; docs/runtime.md is the authority. JSRuntime implements it and codegen targets it.

import type {HistoryDepth, NameStorage} from '../ir/node';
import type {ExecutionSource} from '../ir/builtin';
import type {ParamDisplay} from '../ir/program';
import type {Heap, HeapLimits, StorageRef} from './heap';
import type {
  AggregateLayoutManifest,
  LayoutId,
  UserTypeLayoutId,
  ValueLayoutRegistry,
} from './value-layout';

export interface ResourceHandle {
  readonly kind: 'resource';
  readonly handle: string;
  readonly id: number;
}

export interface UserTypeValue {
  readonly kind: 'user-type';
  readonly layout: UserTypeLayoutId;
  readonly fields: readonly Value[];
}

export interface ArrayValue {
  readonly kind: 'array';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly length: number;
  readonly capacity: number;
}

export interface MatrixValue {
  readonly kind: 'matrix';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly rows: number;
  readonly columns: number;
}

export interface MapValue {
  readonly kind: 'map';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly size: number;
}

export type CollectionValue = ArrayValue | MatrixValue | MapValue;

// User values and collection headers are logically immutable values. Host
// object identity is not observable; backing identity exists only in Heap.
export type Value =
  | number
  | string
  | boolean
  | null
  | ResourceHandle
  | UserTypeValue
  | CollectionValue
  | readonly Value[];

// Only generated expression/function plumbing may carry undefined for Tea
// void. Value-owning surfaces (Rings, collections, fields, history) never do.
export type ExecutionResult = Value | undefined;

export function isTupleValue(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

function isTaggedValue(
  value: Value,
): value is ResourceHandle | UserTypeValue | CollectionValue {
  return typeof value === 'object' && value !== null && !isTupleValue(value);
}

export function isUserTypeValue(value: Value): value is UserTypeValue {
  return isTaggedValue(value) && value.kind === 'user-type';
}

export function isArrayValue(value: Value): value is ArrayValue {
  return isTaggedValue(value) && value.kind === 'array';
}

export function isMatrixValue(value: Value): value is MatrixValue {
  return isTaggedValue(value) && value.kind === 'matrix';
}

export function isMapValue(value: Value): value is MapValue {
  return isTaggedValue(value) && value.kind === 'map';
}

export function isResourceHandle(value: Value): value is ResourceHandle {
  return isTaggedValue(value) && value.kind === 'resource';
}

// JSON-safe projection used by the generated manifest. Runtime numeric na is
// NaN, but JSON has no NaN representation, so manifest na is explicitly null.
// Non-finite numbers other than na are forbidden before this boundary.
export type ManifestValue = number | string | boolean | null;

// Empty history is type-directed: numeric na is NaN, nullable na is null,
// and bool (non-nullable in Pine v6) starts false. A single ref bit cannot
// distinguish numeric and bool slots, so manifests carry this explicit class.
export const ValueClass = {
  Numeric: 'numeric',
  Nullable: 'nullable',
  Boolean: 'boolean',
} as const;

export type ValueClass = (typeof ValueClass)[keyof typeof ValueClass];

// ---- the generated module ---------------------------------------------------

// Depth in the manifest: 'bound' carries no static bars — the module's bind
// section reports it before final frame allocation.
export type DepthSpec =
  | {readonly kind: 'none'}
  | {readonly kind: 'const'; readonly bars: number}
  | {readonly kind: 'bound'}
  | {readonly kind: 'capped'; readonly bars: number};

export interface LocalSpec {
  readonly storage: NameStorage;
  readonly depth: DepthSpec;
  readonly layout: LayoutId;
}

export interface FrameLayout {
  // Slot-indexed locals and call-site-slot-indexed sub-frames.
  readonly locals: readonly LocalSpec[];
  readonly subs: readonly {readonly fid: number}[];
}

export interface SeriesSpec {
  // Host id ('close'); null for input.source slots, resolved at bind from
  // the param's value.
  readonly id: string | null;
  readonly depth: DepthSpec;
}

// Typed builtins supplied by the execution context. `source` is an exact
// builtin identity, never a request for a domain-shaped runtime object.
export interface ExecutionSpec {
  readonly source: ExecutionSource;
  readonly layout: LayoutId;
  readonly depth: DepthSpec;
}

export type ParamConstraintSpec =
  | {
      readonly kind: 'range';
      readonly minval: number | null;
      readonly maxval: number | null;
      readonly step: number | null;
    }
  | {
      readonly kind: 'options';
      readonly options: readonly ManifestValue[];
    };

export interface ParamSpec {
  readonly name: string;
  readonly title: string | null;
  // The VALUE type the runtime validates bound values against; `control`
  // carries the UI flavor ('price', 'session', 'time', 'auto', …).
  readonly type:
    | 'int'
    | 'float'
    | 'bool'
    | 'string'
    | 'color'
    | 'source'
    | 'enum';
  readonly control: string;
  // Const default value, or for source params the default host series id.
  readonly defaultValue: ManifestValue;
  readonly constraints: ParamConstraintSpec | null;
  // Nominal enum identity and UI titles. Runtime values are stable member
  // names; titles are presentation only.
  readonly enumType: {
    readonly name: string;
    readonly members: readonly {
      readonly name: string;
      readonly title: string;
    }[];
  } | null;
  // Settings-UI layout and interaction metadata.
  readonly group: string | null;
  readonly inline: string | null;
  readonly tooltip: string | null;
  readonly confirm: boolean;
  readonly display: ParamDisplay;
  // For source params: the manifest.series slot this param's choice binds.
  readonly seriesSid: number | null;
}

export interface OutputSpec {
  readonly effect: string;
  readonly staticArgs: readonly {
    readonly name: string;
    readonly value: ManifestValue;
  }[];
  readonly channels: readonly {readonly name: string; readonly type: string}[];
}

// The manifest half of a RequestEdge (JSON-safe; the child's code lives in
// ModuleCode.requests at the same rid). Merge semantics are runtime-owned
// and source-independent; docs/requests.md is the authority.
export interface RequestSpec {
  readonly merge: {
    readonly mode: 'sample'; // collect arrives with the collections slice
  };
  // History demanded on the merged result — for a static edge a contract
  // for the future mapping-based view; for a dynamic edge it sizes the
  // per-edge result ring history reads go through.
  readonly depth: DepthSpec;
  // The designated result: this slot of the CHILD's program frame.
  readonly resultSlot: number;
  readonly layout: LayoutId;
  // Dynamic edges carry series context args: bind declares no pair, row
  // code evaluates them at the offset-0 read (rt.requestFor), and the
  // runtime instantiates one child per distinct pair it encounters.
  readonly dynamic: boolean;
}

export interface ModuleManifest {
  readonly series: readonly SeriesSpec[]; // sid-indexed
  readonly execution: readonly ExecutionSpec[]; // eid-indexed
  readonly params: readonly ParamSpec[]; // pid-indexed
  readonly outputs: readonly OutputSpec[]; // oid-indexed
  readonly frames: readonly FrameLayout[]; // fid-indexed; 0 = program frame
  readonly requests: readonly RequestSpec[]; // rid-indexed
}

// Opaque to generated code: created and interpreted by the runtime only.
export interface Frame {
  readonly kind: 'frame';
}

// One compiled Program: code plus the manifest the runtime binds and
// allocates from. Request children are the same shape recursively —
// nested module objects at ModuleCode.requests, rid-aligned with
// manifest.requests (metadata is JSON in the manifest; code cannot be).
export interface ModuleCode {
  readonly manifest: ModuleManifest;
  readonly requests: readonly ModuleCode[]; // rid-indexed child modules
  // Reserved frame-free bind preparation. Frame-dependent depth reports run
  // in bind() against the provisional frame.
  init(rt: Runtime): void;
  // Bind-time evaluation with a scratch-only provisional program frame:
  // computes
  // input-qualified aliases/functions, input active states, output bind args,
  // and static request contexts.
  bind(rt: Runtime, fr: Frame): void;
  // var/varip first-execution thunks, keyed `${fid}:${slot}`.
  readonly inits: Readonly<Record<string, (rt: Runtime, fr: Frame) => Value>>;
  // One function per IrFunc stencil, keyed by fid.
  readonly funcs: Readonly<
    Record<
      number,
      (
        rt: Runtime,
        fr: Frame,
        ...args: Value[]
      ) => ExecutionResult | MutableMethodCallResult
    >
  >;
  // The per-row body; fr is the program frame.
  main(rt: Runtime, fr: Frame): void;
}

// Generated-code-only copy-in/copy-out envelope. It is not a Tea tuple and
// never enters a Ring, collection, parameter, result channel, or history.
export interface MutableMethodCallResult {
  readonly receiver: Value;
  readonly result: ExecutionResult;
}

// The complete runtime artifact (`tea build` output). The runtime never
// re-derives ids from the Program.
export interface TeaModule extends ModuleCode {
  readonly abi: 4;
  readonly aggregateLayouts: AggregateLayoutManifest;
}

export interface ContextBudget {
  used: number;
  readonly max: number;
}

export interface FixedValueStorageBudget {
  usedLogicalBytes: number;
  readonly maxLogicalBytes: number;
}

export interface SharedExecutionState {
  readonly aggregateLayouts: ValueLayoutRegistry;
  readonly heap: Heap;
  readonly contextBudget: ContextBudget;
  readonly fixedValueStorage: FixedValueStorageBudget;
}

// ---- the rt surface ---------------------------------------------------------

// Only Time-Machine-relevant operations cross this interface; arithmetic,
// comparisons, and math intrinsics expand inline in generated code.
export interface Runtime {
  // During bind, only offset-zero syminfo/timeframe sources are visible.
  // time/timenow/bar/barstate remain series-qualified and require a row cursor;
  // generated code calling them during bind is protocol misuse.
  series(sid: number, offset: number): number;
  execution(eid: number, offset: number): Value;
  param(pid: number): Value;
  read(fr: Frame, slot: number, offset: number): Value;
  write(fr: Frame, slot: number, v: Value): void;
  // Reads the edge's merged result at cursor - offset: the static view, or
  // the dynamic edge's result ring. History reads never carry context args
  // — the result is parent-row-indexed regardless of which pair served
  // each row.
  request(rid: number, offset: number): Value;
  // The offset-0 read of a DYNAMIC edge: evaluates against the pair's
  // merged view, records the row's value in the edge's result ring, and
  // returns it. An unresolved pair throws ContextSuspension — the host
  // awaits resolvePending() and re-executes the row from its exact
  // pre-attempt storage-class baseline.
  requestFor(rid: number, symbol: Value, timeframe: Value): Value;
  frame(fr: Frame, slot: number): Frame;
  // The program frame — how function bodies reach program-frame names
  // (functions read but never write globals, so this is the one legal
  // cross-frame access).
  root(): Frame;
  emit(oid: number, channel: number, v: Value): void;
  // Binding phase only. Frame-aware bind reports these against a provisional
  // scratch-only frame before final allocation.
  historyDepth(offset: number): number;
  bindDepth(fid: number, slot: number, bars: number): void;
  bindSeriesDepth(sid: number, bars: number): void;
  bindExecutionDepth(eid: number, bars: number): void;
  bindOutput(oid: number, argName: string, v: Value): void;
  bindParamActive(pid: number, active: Value): void;
  // Every request edge reports its bind-evaluated options exactly once.
  // A zero bar count selects the full available child extent.
  bindRequestOptions(
    rid: number,
    gaps: Value,
    lookahead: Value,
    ignoreInvalidSymbol: Value,
    calcBarsCount: Value,
  ): void;
  // Declares a static edge's context: bind resolves the pair, runs the
  // child over its history, and prepares the merged view before row 0.
  bindRequest(rid: number, symbol: Value, timeframe: Value): void;
  newUser(layout: LayoutId, fields: readonly Value[]): UserTypeValue;
  userField(value: Value, ownerLayout: LayoutId, index: number): Value;
  // Empty fieldIndices replaces the rooted value itself. Non-empty paths
  // rebuild immutable user values from the leaf back to the root.
  rebuildUserPath(
    root: Value,
    rootLayout: LayoutId,
    fieldIndices: readonly number[],
    leaf: Value,
  ): Value;
  callCollection(
    operation: CollectionOperation,
    resultLayout: LayoutId,
    args: readonly Value[],
  ): Value;
  mutateCollection(
    operation: CollectionMutationOperation,
    collectionLayout: LayoutId,
    receiver: Value,
    args: readonly Value[],
  ): CollectionMutation;
  collectionEntries(value: Value): CollectionEntries;
}

export type CollectionOperation =
  | 'array.new'
  | 'array.from'
  | 'array.size'
  | 'array.is_empty'
  | 'array.get'
  | 'array.first'
  | 'array.last'
  | 'array.copy'
  | 'matrix.new'
  | 'matrix.rows'
  | 'matrix.columns'
  | 'matrix.elements_count'
  | 'matrix.get'
  | 'matrix.row'
  | 'matrix.column'
  | 'matrix.copy'
  | 'map.new'
  | 'map.size'
  | 'map.is_empty'
  | 'map.contains'
  | 'map.get'
  | 'map.keys'
  | 'map.values'
  | 'map.copy';

export type CollectionMutationOperation =
  | 'array.set'
  | 'array.push'
  | 'array.pop'
  | 'array.clear'
  | 'matrix.set'
  | 'matrix.fill'
  | 'map.put'
  | 'map.remove'
  | 'map.clear';

export interface CollectionMutation {
  readonly replacement: CollectionValue;
  readonly result: ExecutionResult;
}

export type CollectionEntries =
  | readonly Value[]
  | readonly (readonly [Value, Value])[];

// ---- the external seams -----------------------------------------------------

// Committed rows, absolute-indexed; the runtime owns cursor anchoring and
// the provisional head. Depth demands are a contract on how far back at()
// must answer, not an allocation the provider performs.
export interface SeriesData {
  readonly length: number;
  at(index: number): number;
}

// A context's time axis — the merge join key. Optional as a whole: an
// axis-less context (a csv without a time column) still executes, but
// cannot participate in a merge (BindError at the edge).
export interface TimeAxis {
  time(row: number): number; // bar OPEN time, epoch ms UTC
  closeTime(row: number): number; // bar CLOSE time, epoch ms UTC
}

// One resolved context: a fixed extent of committed rows, answered
// synchronously. Fixed-extent is semantic, not convenience — last_bar_index
// and lookahead merges are statements about the end of history. All
// asynchrony (pagination, rate limits, caching) lives inside
// resolveContext.
export interface ProviderContext {
  readonly rows: number;
  readonly axis: TimeAxis | null;
  // null = this context cannot supply the id; a demanded series is a bind
  // error. All series of one context share one row space (rows-aligned).
  series(id: string): SeriesData | null;
  // The provider-owned metadata plane. `undefined` means this context cannot
  // supply the exact demanded builtin; null/NaN/false remain ordinary typed
  // empty values and are validated against the manifest layout by Runtime.
  builtinValue(
    source: Extract<
      ExecutionSource,
      {readonly domain: 'syminfo' | 'timeframe'}
    >,
  ): Value | undefined;
}

// Typed context-resolution failures — never thrown strings. The runtime
// maps them to BindError, a runtime error, or na per ignoreInvalidSymbol.
export interface ContextError {
  readonly error:
    | 'unknownSource'
    | 'unknownSymbol'
    | 'unsupportedTimeframe'
    | 'fetchFailed';
  readonly detail: string;
}

export function isContextError(
  x: ProviderContext | ContextError,
): x is ContextError {
  return 'error' in x;
}

// What bind demands of a context, so paging drivers know when to stop. The
// runtime defensively enforces the exact trailing extent even when a provider
// elects to over-return.
export type RangeDemand =
  | {readonly kind: 'full'}
  | {readonly kind: 'trailing-bars'; readonly bars: number};

// The one data seam. The primary context resolves through the same call as
// every request context ('' = the host's default symbol/timeframe — a csv
// file has exactly one context); registry providers route by symbol prefix.
export interface DataProvider {
  resolveContext(
    symbol: string,
    timeframe: string,
    range: RangeDemand,
  ): Promise<ProviderContext | ContextError>;
}

export interface OutputSink {
  // Everything known before the first row: static args plus bind-time args.
  declare(
    outputs: readonly {
      readonly spec: OutputSpec;
      readonly boundArgs: readonly {
        readonly name: string;
        readonly value: Value;
      }[];
    }[],
  ): void;
  emit(
    row: number,
    oid: number,
    channels: readonly Value[],
    provisional: boolean,
  ): void;
}

// ---- binding ----------------------------------------------------------------

export interface BindInputs {
  // Keyed by ParamSpec.name; source params take a host series id string.
  readonly params: Readonly<Record<string, unknown>>;
  readonly provider: DataProvider;
  readonly sink: OutputSink;
  // One deterministic historical execution clock. Hosts validate their own
  // source of time; the runtime accepts only an exact finite epoch-ms integer.
  readonly timeNow: number;
  // The primary context's name; omitted = '' = the provider's default
  // (a csv file's only context, the chart's active symbol).
  readonly symbol?: string;
  readonly timeframe?: string;
  // Ceiling on unique request contexts per binding (static edges plus
  // distinct dynamic pairs); omitted = 40, Pine parity. Exceeding it is a
  // RequestError.
  readonly maxRequestContexts?: number;
  readonly maxCollectionElements?: number;
  readonly maxHeapStorageCells?: number;
  readonly maxHeapLogicalBytes?: number;
  readonly maxHeapTransientStorageCells?: number;
  readonly maxHeapTransientLogicalBytes?: number;
  // Shared ceiling for fixed-width runtime values retained by Ring scratch,
  // Ring history, and materialized request-result columns. Collection backing
  // has the separate Heap budgets above.
  readonly maxFixedValueLogicalBytes?: number;
}

export interface BoundInput {
  readonly spec: ParamSpec;
  readonly value: Value;
  readonly active: boolean;
}

export interface BoundProgram {
  readonly rows: number;
  readonly inputs: readonly BoundInput[];
  // Throws ContextSuspension when a dynamic request meets an unresolved
  // pair: await resolvePending(), then re-execute the SAME row — the
  // aborted execution's writes vanish entirely. Retry restores the exact
  // pre-attempt varip candidate (which may be from a prior completed tick),
  // while ordinary scratch re-seeds from committed state. A first-row varip
  // with no prior candidate reruns its initializer.
  executeRow(row: number, provisional: boolean): void;
  resolvePending(): Promise<void>;
  commitRow(row: number): void;
  // Root-owned deterministic teardown. A pending execution attempt aborts;
  // committed host outputs are not reversed. Idempotent.
  dispose(): void;
  // Historical convenience: execute + commit every row in order, resolving
  // suspensions as they arise.
  runAll(): Promise<void>;
}

// Host-facing binding failures (bad param, missing series) — user-actionable,
// unlike InternalError.
export class BindError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BindError';
  }
}

// A dynamic request met a pair with no resolved context. Control flow, not
// a failure: the host awaits resolvePending() and re-executes the row.
export class ContextSuspension extends Error {
  constructor(
    readonly symbol: string,
    readonly timeframe: string,
  ) {
    super(`unresolved request context '${symbol}','${timeframe}'`);
    this.name = 'ContextSuspension';
  }
}

// A dynamic request failed mid-run (unresolvable pair without
// ignore_invalid_symbol, fetch failure, context cap exceeded) —
// user-actionable, the runtime's counterpart of BindError.
export class RequestError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RequestError';
  }
}

export type ExecutionErrorCode =
  | 'NA_COLLECTION'
  | 'INDEX_OUT_OF_BOUNDS'
  | 'EMPTY_COLLECTION'
  | 'INVALID_SHAPE'
  | 'INVALID_MAP_KEY'
  | 'COLLECTION_LIMIT_EXCEEDED'
  | 'HEAP_LIMIT_EXCEEDED'
  | 'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED'
  | 'NA_USER_VALUE_WRITE'
  | 'VALUE_LAYOUT_MISMATCH';

export class ExecutionError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    msg: string,
  ) {
    super(`${code}: ${msg}`);
    this.name = 'ExecutionError';
  }
}

export type {
  AggregateLayoutManifest,
  ExecutionSource,
  HeapLimits,
  HistoryDepth,
  LayoutId,
};
