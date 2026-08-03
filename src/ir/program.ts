// Purpose: Tea Program contract — the compiler's complete static description of a script; the runtime implements the Time Machine (buffers, copy-on-write, rollback) from this description.

import type {
  CallStateId,
  FuncId,
  IrExpr,
  IrStmt,
  OutputId,
  ParamId,
  RequestId,
  SeriesInputId,
  SlotId,
} from './node';
import type {ConstValue, Qualifier, Type} from './type';

// Persistence, orthogonal to qualifiers: perBar re-initializes each
// iteration, var carries the previous iteration's value forward (rolled back
// on provisional re-execution), varip persists across ticks without rollback.
export type SlotStorage = 'perBar' | 'var' | 'varip';

// How deep a place's history must reach, resolvable no later than bind time:
// 'none' = never read historically (no buffer materializes); 'const' = known
// at compile time; 'bound' = an input/simple-qualified expression evaluated
// at bind; 'capped' = dynamic (series) offsets bounded by an explicit
// max_bars_back-style cap — itself bind-resolvable, sourced by the noder from
// max_bars_back(x, n), the indicator declaration, or the engine default.
export type HistoryDepth =
  | {readonly kind: 'none'}
  | {readonly kind: 'const'; readonly bars: number}
  | {readonly kind: 'bound'; readonly expr: IrExpr}
  | {readonly kind: 'capped'; readonly bars: IrExpr};

export interface Slot {
  readonly id: SlotId;
  readonly name: string; // debug/diagnostic name; identity is the id
  readonly storage: SlotStorage;
  readonly type: Type;
  readonly qualifier: Qualifier;
  readonly depth: HistoryDepth;
  // First-bar initializer for var/varip storage, evaluated once by the
  // runtime; null for perBar slots, which the body writes every iteration.
  readonly init: IrExpr | null;
}

// A user-tunable input (input.*): compile time extracts the declaration; the
// VALUE arrives from the runtime at bind time.
// input.source defaults are references to a series input (close), not
// constants — the param records the default CHOICE; the bound value is the
// runtime's series selection.
export type ParamDefault =
  | {readonly kind: 'const'; readonly value: ConstValue}
  | {readonly kind: 'series'; readonly id: SeriesInputId};

export interface ParamInput {
  readonly id: ParamId;
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

// A per-bar data source provided by the runtime for this Program's context
// (close, volume, time, bar_index, syminfo bindings, …).
export interface SeriesInput {
  readonly id: SeriesInputId;
  readonly name: string;
  readonly type: Type;
  // series for per-bar streams (close); simple for bind-time context
  // bindings the host provides once (syminfo.tickerid, timeframe.period).
  readonly qualifier: Qualifier;
  // History demanded on this input by the body (close[500]); the runtime
  // sizes the buffer from this, exactly as for slots.
  readonly depth: HistoryDepth;
}

// A statically-declared effect channel (plot, hline, alertcondition, …):
// hoisted at compile time so the host knows every output before the first
// bar. Per-bar values arrive via EmitStmt writes.
export interface OutputDecl {
  readonly id: OutputId;
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
// child Program with its own context, axis, slots, and rollback. Context
// arguments are bind-time evaluable (input/simple qualified) by construction.
export interface RequestEdge {
  readonly id: RequestId;
  // input/simple for static contexts; series-qualified exprs are the dynamic
  // request form — the child stays one static template, and the runtime
  // instantiates it per distinct (symbol, timeframe) pair it encounters.
  readonly symbol: IrExpr;
  readonly timeframe: IrExpr;
  readonly merge: MergePolicy;
  // The designated result: a slot OF THE CHILD written each child bar; the
  // runtime merges its committed values onto the parent axis. resultType
  // must equal that slot's type (tuples for multi-value requests).
  readonly resultSlot: SlotId;
  readonly resultType: Type;
  // History demanded on the merged result by the parent body.
  readonly depth: HistoryDepth;
  readonly child: Program;
}

// One instantiation of a user (or prelude) function for a concrete argument
// signature. Call sites reference the instantiation by id plus their own
// CallStateId, so the runtime allocates per-call-site copies of the
// instantiation's local slots.
export interface IrFunc {
  readonly id: FuncId;
  readonly name: string;
  readonly params: readonly {
    readonly name: string;
    readonly type: Type;
    readonly qualifier: Qualifier;
  }[];
  readonly resultType: Type;
  readonly resultQualifier: Qualifier;
  readonly slots: readonly Slot[];
  readonly body: IrExpr;
}

// @agent invariant: one Program instance runs against exactly one context
// (one symbol × timeframe axis) and owns its slots, bindings, and rollback;
// recursion — not multi-context Programs — is how requests compose. The
// Program is a pure static description: it never encodes buffer layouts, COW
// strategy, or any other Time Machine mechanics, which are runtime-owned.
export interface Program {
  readonly teaVersion: string;
  readonly params: readonly ParamInput[];
  readonly seriesInputs: readonly SeriesInput[];
  readonly outputs: readonly OutputDecl[];
  readonly requests: readonly RequestEdge[];
  readonly slots: readonly Slot[];
  readonly funcs: readonly IrFunc[];
  // Hoisted const/input/simple work, run once when bindings are known.
  readonly init: readonly IrStmt[];
  // The per-bar body — the inner loop of the bar-per-bar execution model.
  readonly body: readonly IrStmt[];
  // Count of distinct call-site ids. State identity at runtime is the
  // dynamic CHAIN of CallStateIds (the call path), so nested stateful calls
  // multiply out: two outer f() sites calling one inner ta.sma site yield
  // two sma states, keyed [outerId, innerId].
  readonly callStateCount: CallStateId;
}
