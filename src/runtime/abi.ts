// Purpose: The runtime ABI types — the complete surface generated code, providers, and sinks see; docs/runtime.md is the authority. Types only: JSRuntime implements, codegen targets.

import type {HistoryDepth, NameStorage} from '../ir/node';

// In-flight values: numerics carry na as NaN, references use null, bool is
// never na (a checker guarantee). Tuples travel as arrays (ephemeral:
// written to a synthetic slot, destructured immediately). Heap objects
// (UDT, collections) arrive with their slice.
export type Value = number | string | boolean | null | readonly Value[];

// ---- the generated module ---------------------------------------------------

// Depth in the manifest: 'bound' carries no static bars — the module's init
// section reports the bind-time value through rt.bindDepth/bindSeriesDepth.
export type DepthSpec =
  | {readonly kind: 'none'}
  | {readonly kind: 'const'; readonly bars: number}
  | {readonly kind: 'bound'}
  | {readonly kind: 'capped'; readonly bars: number};

export interface LocalSpec {
  readonly storage: NameStorage;
  readonly depth: DepthSpec;
  // Reference-typed slots (string/color/UDT/collections) use null as na;
  // numeric slots use NaN.
  readonly ref: boolean;
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

export interface ParamSpec {
  readonly name: string;
  readonly title: string | null;
  // The VALUE type the runtime validates bound values against; `control`
  // carries the UI flavor ('price', 'session', 'time', 'auto', …).
  readonly type: 'int' | 'float' | 'bool' | 'string' | 'color' | 'source';
  readonly control: string;
  // Const default value, or for source params the default host series id.
  readonly defaultValue: Value;
  readonly constraints: {
    readonly minval: number | null;
    readonly maxval: number | null;
    readonly options: readonly Value[] | null;
  } | null;
  // Settings-UI layout and interaction metadata.
  readonly group: string | null;
  readonly inline: string | null;
  readonly tooltip: string | null;
  readonly confirm: boolean;
  // For source params: the manifest.series slot this param's choice binds.
  readonly seriesSid: number | null;
}

export interface OutputSpec {
  readonly effect: string;
  readonly staticArgs: readonly {
    readonly name: string;
    readonly value: Value;
  }[];
  readonly channels: readonly {readonly name: string; readonly type: string}[];
}

// The manifest half of a RequestEdge (JSON-safe; the child's code lives in
// ModuleCode.requests at the same rid). Merge semantics are runtime-owned
// and source-independent; docs/requests.md is the authority.
export interface RequestSpec {
  readonly merge: {
    readonly mode: 'sample'; // collect arrives with the collections slice
    readonly gaps: boolean;
    readonly lookahead: boolean;
    readonly ignoreInvalidSymbol: boolean;
  };
  // History demanded on the merged result — for a static edge a contract
  // for the future mapping-based view; for a dynamic edge it sizes the
  // per-edge result ring history reads go through.
  readonly depth: DepthSpec;
  // The designated result: this slot of the CHILD's program frame.
  readonly resultSlot: number;
  // Reference-typed results use null as na; numeric results use NaN.
  readonly ref: boolean;
  // Dynamic edges carry series context args: init declares no pair, row
  // code evaluates them at the offset-0 read (rt.requestFor), and the
  // runtime instantiates one child per distinct pair it encounters.
  readonly dynamic: boolean;
}

export interface ModuleManifest {
  readonly series: readonly SeriesSpec[]; // sid-indexed
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
  // Bind time: evaluates bound depths, output bind-args, and static
  // request contexts (rt.bindRequest).
  init(rt: Runtime): void;
  // var/varip first-execution thunks, keyed `${fid}:${slot}`.
  readonly inits: Readonly<Record<string, (rt: Runtime, fr: Frame) => Value>>;
  // One function per IrFunc stencil, keyed by fid.
  readonly funcs: Readonly<
    Record<number, (rt: Runtime, fr: Frame, ...args: Value[]) => Value>
  >;
  // The per-row body; fr is the program frame.
  main(rt: Runtime, fr: Frame): void;
}

// The complete runtime artifact (`tea build` output). The runtime never
// re-derives ids from the Program.
export interface TeaModule extends ModuleCode {
  readonly abi: 1;
}

// ---- the rt surface ---------------------------------------------------------

// Only Time-Machine-relevant operations cross this interface; arithmetic,
// comparisons, and math intrinsics expand inline in generated code.
export interface Runtime {
  series(sid: number, offset: number): number;
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
  // awaits resolvePending() and re-executes the row from committed state.
  requestFor(rid: number, symbol: Value, timeframe: Value): Value;
  frame(fr: Frame, slot: number): Frame;
  // The program frame — how function bodies reach program-frame names
  // (functions read but never write globals, so this is the one legal
  // cross-frame access).
  root(): Frame;
  emit(oid: number, channel: number, v: Value): void;
  // init section only
  bindDepth(fid: number, slot: number, bars: number): void;
  bindSeriesDepth(sid: number, bars: number): void;
  bindOutput(oid: number, argName: string, v: Value): void;
  // Declares a static edge's context: bind resolves the pair, runs the
  // child over its history, and prepares the merged view before row 0.
  bindRequest(rid: number, symbol: Value, timeframe: Value): void;
}

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

// What bind demands of a context, so paging drivers know when to stop.
// null members mean the source's full extent / latest available.
export interface RangeDemand {
  readonly from: number | null; // epoch ms
  readonly to: number | null; // epoch ms
  readonly bars: number | null; // alternative: trailing bar count
}

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
  readonly params: Readonly<Record<string, Value>>;
  readonly provider: DataProvider;
  readonly sink: OutputSink;
  // The primary context's name; omitted = '' = the provider's default
  // (a csv file's only context, the chart's active symbol).
  readonly symbol?: string;
  readonly timeframe?: string;
  // Ceiling on unique request contexts per binding (static edges plus
  // distinct dynamic pairs); omitted = 40, Pine parity. Exceeding it is a
  // RequestError.
  readonly maxRequestContexts?: number;
}

export interface BoundProgram {
  readonly rows: number;
  // Throws ContextSuspension when a dynamic request meets an unresolved
  // pair: await resolvePending(), then re-execute the SAME row — the
  // aborted execution vanishes entirely (all scratch, varip included,
  // re-seeds from committed state), so results are byte-identical to
  // having had the data upfront.
  executeRow(row: number, provisional: boolean): void;
  resolvePending(): Promise<void>;
  commitRow(row: number): void;
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

export type {HistoryDepth};
