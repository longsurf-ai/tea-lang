// Purpose: Tea Program contract — the compiler's complete static description of a script; the runtime implements the Time Machine (buffers, copy-on-write, rollback) from this description.

import type {
  CallStateId,
  DataSeriesId,
  HistoryDepth,
  IrExpr,
  IrStmt,
  Name,
} from './node';
import type {ConstValue, Qualifier, Type} from './type';

// A user-tunable input (input.*): compile time extracts the declaration; the
// VALUE arrives from the runtime at bind time. input.source defaults are
// references to a series input (close), not constants — the param records
// the default CHOICE; the bound value is the runtime's series selection.
export type ParamDefault =
  | {readonly kind: 'const'; readonly value: ConstValue}
  | {readonly kind: 'series'; readonly series: SeriesInput};

export interface ParamInput {
  readonly name: string;
  readonly type: Type;
  readonly defaultValue: ParamDefault | null;
  readonly constraints: ParamConstraints | null;
}

export interface ParamConstraints {
  readonly minval: ConstValue | null;
  readonly maxval: ConstValue | null;
  readonly step: ConstValue | null;
  readonly options: readonly ConstValue[] | null;
}

// A data source the runtime provides for this Program's context, bound by
// host name: series-qualified per-bar streams (close, volume) or
// simple-qualified context bindings provided once (syminfo.tickerid,
// timeframe.period).
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
export interface MergePolicy {
  readonly mode: 'sample' | 'collect'; // collect = lower-timeframe array-per-bar
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

// One instantiation of a user (or prelude) function for a concrete argument
// signature. Params are ordinary Names (per-call values); locals are
// discovered by walking the body. Call sites reference the instantiation
// object directly plus their own CallStateId; runtime state identity is the
// dynamic chain of CallStateIds, so nested stateful calls multiply out.
export interface IrFunc {
  readonly name: string;
  readonly params: readonly Name[];
  readonly resultType: Type;
  readonly resultQualifier: Qualifier;
  readonly body: IrExpr;
}

// @agent invariant: one Program instance runs against exactly one context
// (one symbol × timeframe axis) and owns its names, bindings, and rollback;
// recursion — not multi-context Programs — is how requests compose. The
// Program is a pure static description: it never encodes buffer layouts, COW
// strategy, or any other Time Machine mechanics, which are runtime-owned.
// There is no variable table: Names are shared declaration objects reachable
// from the trees, and any enumeration (allocation plans, serialized indices)
// is a projection derived by walking at the boundary that needs it.
export interface Program {
  readonly teaVersion: string;
  readonly params: readonly ParamInput[];
  readonly seriesInputs: readonly SeriesInput[];
  readonly outputs: readonly OutputDecl[];
  readonly requests: readonly RequestEdge[];
  readonly funcs: readonly IrFunc[];
  // Hoisted const/input/simple work, run once when bindings are known.
  readonly init: readonly IrStmt[];
  // The per-bar body — the inner loop of the bar-per-bar execution model.
  readonly body: readonly IrStmt[];
  // Count of distinct call-site ids minted for this Program.
  readonly callStateCount: CallStateId;
}
