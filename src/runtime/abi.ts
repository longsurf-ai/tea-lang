// Purpose: The runtime ABI types — the complete surface generated code, providers, and sinks see; docs/runtime.md is the authority. Types only: the kernel implements, codegen targets.

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
  readonly type: 'int' | 'float' | 'bool' | 'string' | 'color' | 'source';
  // Const default value, or for source params the default host series id.
  readonly defaultValue: Value;
  readonly constraints: {
    readonly minval: number | null;
    readonly maxval: number | null;
    readonly options: readonly Value[] | null;
  } | null;
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

export interface ModuleManifest {
  readonly series: readonly SeriesSpec[]; // sid-indexed
  readonly params: readonly ParamSpec[]; // pid-indexed
  readonly outputs: readonly OutputSpec[]; // oid-indexed
  readonly frames: readonly FrameLayout[]; // fid-indexed; 0 = program frame
}

// Opaque to generated code: created and interpreted by the kernel only.
export interface Frame {
  readonly kind: 'frame';
}

// The complete runtime artifact: code plus the manifest the kernel binds
// and allocates from. The kernel never re-derives ids from the Program.
export interface TeaModule {
  readonly abi: 1;
  readonly manifest: ModuleManifest;
  // Bind time: evaluates bound depths and output bind-args.
  init(rt: Rt): void;
  // var/varip first-execution thunks, keyed `${fid}:${slot}`.
  readonly inits: Readonly<Record<string, (rt: Rt, fr: Frame) => Value>>;
  // One function per IrFunc stencil, keyed by fid.
  readonly funcs: Readonly<
    Record<number, (rt: Rt, fr: Frame, ...args: Value[]) => Value>
  >;
  // The per-row body; fr is the program frame.
  main(rt: Rt, fr: Frame): void;
}

// ---- the rt surface ---------------------------------------------------------

// Only Time-Machine-relevant operations cross this interface; arithmetic,
// comparisons, and math intrinsics expand inline in generated code.
export interface Rt {
  series(sid: number, offset: number): number;
  param(pid: number): Value;
  read(fr: Frame, slot: number, offset: number): Value;
  write(fr: Frame, slot: number, v: Value): void;
  request(rid: number, offset: number): Value; // reserved: request slice
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
}

// ---- the external seams -----------------------------------------------------

// Committed rows, absolute-indexed; the kernel owns cursor anchoring and
// the provisional head. Depth demands are a contract on how far back at()
// must answer, not an allocation the provider performs.
export interface SeriesData {
  readonly length: number;
  at(index: number): number;
}

export interface DataProvider {
  // null = this host cannot supply the id; a demanded series is a bind error.
  series(id: string): SeriesData | null;
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
}

export interface BoundProgram {
  readonly rows: number;
  executeRow(row: number, provisional: boolean): void;
  commitRow(row: number): void;
  // Historical convenience: execute + commit every row in order.
  runAll(): void;
}

// Host-facing binding failures (bad param, missing series) — user-actionable,
// unlike InternalError.
export class BindError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BindError';
  }
}

export type {HistoryDepth};
