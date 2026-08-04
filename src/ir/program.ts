// Purpose: Tea Program contract — the compiler's complete static description of a script; the runtime implements the Time Machine (buffers, copy-on-write, rollback) from this description.

import type {DataSeriesId, HistoryDepth, IrExpr, IrStmt, Name} from './node';
import type {ConstValue, Qualifier, Type} from './type';

// A user-tunable input (input.*): compile time extracts the declaration; the
// VALUE arrives from the runtime at bind time. input.source defaults are
// references to a series input (close), not constants — the param records
// the default CHOICE; the bound value is the runtime's series selection.
export const ParamDefaultKind = {
  Const: 'const',
  Series: 'series',
} as const;

export type ParamDefault =
  | {readonly kind: typeof ParamDefaultKind.Const; readonly value: ConstValue}
  | {
      readonly kind: typeof ParamDefaultKind.Series;
      readonly series: SeriesInput;
    };

export interface ParamInput {
  // Identity: the binding name when the input call initializes a
  // declaration (`len = input.int(...)`), else `input@line:col`.
  readonly name: string;
  // Settings-UI label; null renders the name.
  readonly title: string | null;
  readonly type: Type;
  readonly defaultValue: ParamDefault | null;
  readonly constraints: ParamConstraints | null;
  // History demanded on the bound value by the body (src[1] on an
  // input.source param reaches the runtime's chosen series). Annotated by
  // the depth pass; meaningful only for series-resulting params.
  depth: HistoryDepth;
}

export interface ParamConstraints {
  readonly minval: ConstValue | null;
  readonly maxval: ConstValue | null;
  readonly step: ConstValue | null;
  readonly options: readonly ConstValue[] | null;
}

// An ambient built-in series of the Program's context, provided by the
// runtime unconditionally and bound by host name: series-qualified per-bar
// streams (close, volume) or simple-qualified context bindings provided
// once (syminfo.tickerid, timeframe.period). Availability is never declared
// and usage is never mandatory; the depth-annotated usage set is projected
// by seriesInputsOf for buffer sizing.
export interface SeriesInput {
  readonly id: DataSeriesId;
  readonly type: Type;
  readonly qualifier: Qualifier;
  // History demanded on this input by the body (close[500]); the runtime
  // sizes the buffer from this, exactly as for names. Annotated by the depth
  // pass.
  depth: HistoryDepth;
}

// A statically-declared effect channel (plot, hline, alertcondition, …):
// hoisted at compile time so the host knows every output before the first
// bar. Per-bar values arrive via EmitStmt writes.
export interface OutputDecl {
  readonly effect: string; // catalog primitive, e.g. 'plot', 'hline'
  readonly staticArgs: readonly {
    readonly name: string;
    readonly value: ConstValue;
  }[];
  // input/simple-qualified declarative args (hline price, plot linewidth,
  // plotshape offset) plus output references (fill's plot/hline operands as
  // const OutputRef exprs): evaluated once at init, delivered to the host
  // before the first bar.
  readonly bindArgs: readonly {
    readonly name: string;
    readonly expr: IrExpr;
  }[];
  readonly channels: readonly {readonly name: string; readonly type: Type}[];
}

// How a child Program's bars project onto the parent axis.
export const MergeMode = {
  Sample: 'sample',
  Collect: 'collect', // lower-timeframe array-per-bar
} as const;

export type MergeModeName = (typeof MergeMode)[keyof typeof MergeMode];

export interface MergePolicy {
  readonly mode: MergeModeName;
  readonly gaps: boolean;
  readonly lookahead: boolean;
  // Invalid symbols yield na instead of a runtime error.
  readonly ignoreInvalidSymbol: boolean;
  // Currency conversion applied to the merged result, null for none.
  readonly currency: string | null;
  // Bind-resolvable bar-count limit for the child, null for host default.
  readonly calcBarsCount: IrExpr | null;
}

// A request.* call site: the expression's dependency closure compiled as a
// child Program with its own context, axis, and rollback.
export interface RequestEdge {
  // input/simple for static contexts; series-qualified exprs are the dynamic
  // request form — the child stays one static template, and the runtime
  // instantiates it per distinct (symbol, timeframe) pair it encounters.
  readonly symbol: IrExpr;
  readonly timeframe: IrExpr;
  readonly merge: MergePolicy;
  // The designated result: a Name OF THE CHILD written each child bar; the
  // runtime merges its committed values onto the parent axis. resultType
  // must equal that name's type (tuples for multi-value requests).
  readonly resultName: Name;
  readonly resultType: Type;
  // History demanded on the merged result by the parent body. Annotated by
  // the depth pass.
  depth: HistoryDepth;
  readonly child: Program;
}

// One instantiation of a user (or prelude) function per concrete argument
// signature — Go-style stenciling, and instantiations are REAL functions:
// calls dispatch at runtime (inlining is at most a codegen optimization).
// Params and locals are ordinary Names and BOTH explicit: ownership is by
// declaration site, never by reachability — a program-frame `var` read only
// inside a function must still live in the program frame, so walking cannot
// discover ownership. An IrFunc's frame layout is its params + locals plus
// one sub-frame per stateful call site in its body; each call site's slot
// selects its sub-frame, so two ma(close, 10) call sites own two frames
// (and two ema sub-frames within).
export interface IrFunc {
  readonly name: string;
  readonly params: readonly Name[];
  // Names DECLARED in this instantiation's body (the binder's defs minus
  // params), in source order.
  readonly locals: readonly Name[];
  readonly resultType: Type;
  readonly resultQualifier: Qualifier;
  readonly body: IrExpr;
}

// @agent invariant: one Program instance runs against exactly one context
// (one symbol × timeframe axis) and owns its names, bindings, and rollback;
// recursion — not multi-context Programs — is how requests compose. The
// Program is a pure static description: it never encodes buffer layouts, COW
// strategy, or any other Time Machine mechanics, which are runtime-owned.
// Field criterion: a Program declares its EXTERNAL NEEDS — params
// (bind-time values) and requests (child-Program contexts the runtime must
// resolve) — and its emissions (outputs), explicitly, even where derivable:
// binder, checker, and runtime read what the program needs from the world
// here, never by walking trees. Ambient context builtins (close, volume,
// syminfo.*) are NOT declared — they are simply available, and their
// depth-annotated usage set is projected by seriesInputsOf for buffer
// sizing. Composition internals (names, funcs, call-site slots) are
// visit.ts projections; the noder fills requests from the same reach walk.
export interface Program {
  // Declared Tea language version.
  readonly version: number;
  readonly params: readonly ParamInput[];
  readonly requests: readonly RequestEdge[];
  readonly outputs: readonly OutputDecl[];
  // Hoisted const/input/simple work, run once when bindings are known.
  readonly init: readonly IrStmt[];
  // The per-bar body — the inner loop of the bar-per-bar execution model.
  readonly body: readonly IrStmt[];
}
