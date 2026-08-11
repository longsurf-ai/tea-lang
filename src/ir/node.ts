// Purpose: Tea IR nodes — the noder's typed, resolved body vocabulary; every expression carries its type and qualifier, and every use references its declaration object directly.

import type {Pos} from '../base/pos';
import type {ConstValue, NameStorage, Qualifier, Type, UserType} from './type';
import type {
  ConstMethodIrFunc,
  FreeIrFunc,
  MutableMethodIrFunc,
  OutputDecl,
  ParamInput,
  RequestEdge,
  ExecutionInput,
  SeriesInput,
} from './program';
export {Storage} from './type';
export type {DataSeriesId} from './builtin';
export type {NameStorage} from './type';

// Minted per stateful call site: the slot selects that call site's
// sub-frame within the caller's frame. Frames nest along the static call
// graph, so the runtime pre-allocates the whole frame tree at bind time.
export type SlotId = number;

// How deep a place's history must reach, resolvable no later than bind time:
// None = never read historically (no buffer materializes); Const = known
// at compile time; Bound = an input/simple-qualified expression evaluated
// at bind; Capped = dynamic (series) offsets bounded by an explicit
// max_bars_back-style cap — itself bind-resolvable, sourced by the noder from
// max_bars_back(x, n), the indicator declaration, or the engine default.
export const DepthKind = {
  None: 'none',
  Const: 'const',
  Bound: 'bound',
  Capped: 'capped',
} as const;

export type HistoryDepth =
  | {readonly kind: typeof DepthKind.None}
  | {readonly kind: typeof DepthKind.Const; readonly bars: number}
  | {readonly kind: typeof DepthKind.Bound; readonly expr: IrExpr}
  | {readonly kind: typeof DepthKind.Capped; readonly bars: IrExpr};

// A Program-local variable projection. The noder creates one object per
// semantic VariableObject in each Program context; every IR use references
// it directly, with no id or table. Variable enumerations (allocation plans,
// serialized indices) are projections derived by walking at the boundary
// that needs them.
export interface Name {
  readonly name: string;
  readonly storage: NameStorage;
  // Type/qualifier copy from semantic facts; depth is annotated by the
  // noder's depth pass. These working fields are read-only afterward.
  type: Type;
  qualifier: Qualifier;
  depth: HistoryDepth;
  // First-bar initializer for var/varip storage, evaluated once by the
  // runtime; null for perBar names, which the body writes every iteration.
  init: IrExpr | null;
}

export const IrKind = {
  Const: 'Const',
  OutputRef: 'OutputRef',
  HistRead: 'HistRead',
  Binary: 'Binary',
  Unary: 'Unary',
  Cond: 'Cond',
  CallFunc: 'CallFunc',
  CallConstMethod: 'CallConstMethod',
  CallMutableMethod: 'CallMutableMethod',
  CallNative: 'CallNative',
  MutateCollection: 'MutateCollection',
  NewUserValue: 'NewUserValue',
  MakeTuple: 'MakeTuple',
  TupleGet: 'TupleGet',
  FieldGet: 'FieldGet',
  IfExpr: 'IfExpr',
  SwitchExpr: 'SwitchExpr',
  ForExpr: 'ForExpr',
  ForInExpr: 'ForInExpr',
  WhileExpr: 'WhileExpr',
  BlockExpr: 'BlockExpr',
  ExprStmt: 'ExprStmt',
  WriteName: 'WriteName',
  UpdateValuePath: 'UpdateValuePath',
  Emit: 'Emit',
  Break: 'Break',
  Continue: 'Continue',
} as const;

export type IrKindName = (typeof IrKind)[keyof typeof IrKind];

// The IR's operation vocabulary: semantic operations, never surface lexemes.
// The noder maps tokens to ops — '-' becomes Sub or Neg by arity, and unary
// '+' is folded away entirely. And/Or are short-circuit (Pine v6 lazy
// evaluation); codegen may emit && / ||.
export const IrOp = {
  Add: 'Add',
  Sub: 'Sub',
  Mul: 'Mul',
  Div: 'Div',
  Mod: 'Mod',
  Eq: 'Eq',
  Ne: 'Ne',
  Lt: 'Lt',
  Le: 'Le',
  Gt: 'Gt',
  Ge: 'Ge',
  And: 'And',
  Or: 'Or',
  Neg: 'Neg',
  Not: 'Not',
} as const;

export const BINARY_OPS = [
  IrOp.Add,
  IrOp.Sub,
  IrOp.Mul,
  IrOp.Div,
  IrOp.Mod,
  IrOp.Eq,
  IrOp.Ne,
  IrOp.Lt,
  IrOp.Le,
  IrOp.Gt,
  IrOp.Ge,
  IrOp.And,
  IrOp.Or,
] as const;
export type IrBinaryOp = (typeof BINARY_OPS)[number];

export const UNARY_OPS = [IrOp.Neg, IrOp.Not] as const;
export type IrUnaryOp = (typeof UNARY_OPS)[number];

// A readable location, referencing its declaration object directly. Names are
// script/function variables; params are bind-time inputs; series are numeric
// data; execution places are typed builtins; requests are merged child-Program
// results. Only names are writable.
export const PlaceKind = {
  Name: 'name',
  Param: 'param',
  Series: 'series',
  Execution: 'execution',
  Request: 'request',
} as const;

export type Place =
  | {readonly kind: typeof PlaceKind.Name; readonly name: Name}
  | {readonly kind: typeof PlaceKind.Param; readonly param: ParamInput}
  | {readonly kind: typeof PlaceKind.Series; readonly series: SeriesInput}
  | {
      readonly kind: typeof PlaceKind.Execution;
      readonly execution: ExecutionInput;
    }
  | {readonly kind: typeof PlaceKind.Request; readonly request: RequestEdge};

// A current writable root plus canonical user-type field indices. It carries
// no checker objects and grants no mutation rights to history or temporaries.
export interface IrValuePath {
  readonly root: Name;
  readonly fieldIndices: readonly number[];
}

// @agent invariant: the IR is built only from checked, error-free syntax —
// there are no Bad nodes here; recovery ends at the checker's phase barrier.
// Every expression carries (type, qualifier); the compiler DESCRIBES history
// (depths on names, offsets on reads) and the runtime IMPLEMENTS it.
export interface IrNode {
  readonly pos: Pos;
}

export interface IrExprBase extends IrNode {
  readonly type: Type;
  readonly qualifier: Qualifier;
}

export type IrExpr =
  | ConstExpr
  | OutputRefExpr
  | HistReadExpr
  | BinaryExpr
  | UnaryExpr
  | CondExpr
  | CallFuncExpr
  | CallConstMethodExpr
  | CallMutableMethodExpr
  | CallNativeExpr
  | MutateCollectionExpr
  | NewUserValueExpr
  | MakeTupleExpr
  | TupleGetExpr
  | FieldGetExpr
  | IfExpr
  | SwitchExpr
  | ForExpr
  | ForInExpr
  | WhileExpr
  | BlockExpr;

export interface ConstExpr extends IrExprBase {
  readonly kind: typeof IrKind.Const;
  readonly value: ConstValue;
}

// A compile-time reference to a declarative output channel (type Plot or
// Hline, always const-qualified): `x = plot(...)` binds x to this, and
// fill(x, y) consumes it in bindArgs. Never a runtime heap handle.
export interface OutputRefExpr extends IrExprBase {
  readonly kind: typeof IrKind.OutputRef;
  readonly output: OutputDecl;
}

// A read through the time machine: offset null means the current bar
// (offset 0), a non-null offset is `x[k]`. The use site keeps its own pos —
// unlike shared-node designs, per-use positions survive for diagnostics.
// The checker guarantees offset qualifiers obey the bind-time depth rule.
export interface HistReadExpr extends IrExprBase {
  readonly kind: typeof IrKind.HistRead;
  readonly place: Place;
  readonly offset: IrExpr | null;
}

export interface BinaryExpr extends IrExprBase {
  readonly kind: typeof IrKind.Binary;
  readonly op: IrBinaryOp;
  readonly x: IrExpr;
  readonly y: IrExpr;
}

export interface UnaryExpr extends IrExprBase {
  readonly kind: typeof IrKind.Unary;
  readonly op: IrUnaryOp;
  readonly x: IrExpr;
}

export interface CondExpr extends IrExprBase {
  readonly kind: typeof IrKind.Cond;
  readonly cond: IrExpr;
  readonly then: IrExpr;
  readonly else: IrExpr;
}

export interface CallFuncExpr extends IrExprBase {
  readonly kind: typeof IrKind.CallFunc;
  readonly func: FreeIrFunc;
  readonly slot: SlotId;
  readonly args: readonly IrExpr[];
  readonly argumentEvaluationOrder: readonly number[];
}

// A read-only method call. `receiver` is evaluated exactly once before the
// source-visible explicit arguments and becomes the callee's hidden receiver.
export interface CallConstMethodExpr extends IrExprBase {
  readonly kind: typeof IrKind.CallConstMethod;
  readonly func: ConstMethodIrFunc;
  readonly receiver: IrExpr;
  readonly slot: SlotId;
  readonly args: readonly IrExpr[];
  readonly argumentEvaluationOrder: readonly number[];
}

// Copy-in/copy-out mutable method call. `receiver` is evaluated once before
// `args`; `args` contains only source-visible explicit parameters. On normal
// return lowering writes the returned replacement through `path` once and
// yields the Tea result. A throw or suspension performs no copy-out.
export interface CallMutableMethodExpr extends IrExprBase {
  readonly kind: typeof IrKind.CallMutableMethod;
  readonly func: MutableMethodIrFunc;
  readonly path: IrValuePath;
  readonly receiver: IrExpr;
  readonly slot: SlotId;
  readonly args: readonly IrExpr[];
  readonly argumentEvaluationOrder: readonly number[];
}

// A native primitive call (data-source-, effect-, or intrinsic-classed per
// the catalog). Stateful natives also carry a call-site slot.
export interface CallNativeExpr extends IrExprBase {
  readonly kind: typeof IrKind.CallNative;
  readonly native: string;
  readonly slot: SlotId | null;
  readonly args: readonly IrExpr[];
  readonly argumentEvaluationOrder: readonly number[];
}

// A mutating collection primitive. The receiver is captured before the
// remaining arguments. The operation computes `{replacement, result}` and
// lowering performs one path writeback before yielding `result`.
export interface MutateCollectionExpr extends IrExprBase {
  readonly kind: typeof IrKind.MutateCollection;
  readonly path: IrValuePath;
  readonly receiver: IrExpr;
  readonly operation: string;
  readonly args: readonly IrExpr[];
  readonly argumentEvaluationOrder: readonly number[];
}

export interface NewUserValueExpr extends IrExprBase {
  readonly kind: typeof IrKind.NewUserValue;
  readonly userType: UserType;
  readonly args: readonly IrExpr[];
  readonly argumentEvaluationOrder: readonly number[];
}

export interface MakeTupleExpr extends IrExprBase {
  readonly kind: typeof IrKind.MakeTuple;
  readonly elems: readonly IrExpr[];
}

export interface TupleGetExpr extends IrExprBase {
  readonly kind: typeof IrKind.TupleGet;
  readonly x: IrExpr;
  readonly index: number;
}

export interface FieldGetExpr extends IrExprBase {
  readonly kind: typeof IrKind.FieldGet;
  readonly x: IrExpr;
  readonly fieldIndex: number;
}

// Control structures stay expressions in the IR (mirroring the language);
// flattening into plain statements is a later optimization pass, not a
// representation constraint.
export interface IfExpr extends IrExprBase {
  readonly kind: typeof IrKind.IfExpr;
  readonly cond: IrExpr;
  readonly then: BlockExpr;
  readonly else: BlockExpr | null;
}

export interface SwitchArm {
  readonly pattern: IrExpr | null; // null = default arm
  readonly body: BlockExpr;
}

export interface SwitchExpr extends IrExprBase {
  readonly kind: typeof IrKind.SwitchExpr;
  readonly subject: IrExpr | null;
  readonly arms: readonly SwitchArm[];
}

export interface ForExpr extends IrExprBase {
  readonly kind: typeof IrKind.ForExpr;
  readonly index: Name;
  readonly from: IrExpr;
  readonly to: IrExpr;
  readonly step: IrExpr | null;
  readonly body: BlockExpr;
}

export interface ForInExpr extends IrExprBase {
  readonly kind: typeof IrKind.ForInExpr;
  readonly targets: readonly Name[];
  readonly x: IrExpr;
  readonly body: BlockExpr;
}

export interface WhileExpr extends IrExprBase {
  readonly kind: typeof IrKind.WhileExpr;
  readonly cond: IrExpr;
  readonly body: BlockExpr;
}

// Statements plus an optional trailing value — the IR form of an indented
// block whose last expression is its value.
export interface BlockExpr extends IrExprBase {
  readonly kind: typeof IrKind.BlockExpr;
  readonly stmts: readonly IrStmt[];
  readonly value: IrExpr | null;
}

// ---- statements -------------------------------------------------------------

export type IrStmt =
  | ExprStmt
  | WriteNameStmt
  | UpdateValuePathStmt
  | EmitStmt
  | BreakStmt
  | ContinueStmt;

export interface ExprStmt extends IrNode {
  readonly kind: typeof IrKind.ExprStmt;
  readonly x: IrExpr;
}

// Declarations, reassignments, and compound assignments all become name
// writes; the compound operator is desugared by the noder.
export interface WriteNameStmt extends IrNode {
  readonly kind: typeof IrKind.WriteName;
  readonly name: Name;
  readonly value: IrExpr;
}

// Atomic rooted replacement. Lowering captures and validates the path before
// evaluating `value`, then rebuilds it against the then-current root so
// sibling writes from the RHS survive while this leaf replacement wins.
export interface UpdateValuePathStmt extends IrNode {
  readonly kind: typeof IrKind.UpdateValuePath;
  readonly path: IrValuePath;
  readonly value: IrExpr;
}

// A per-bar write into a declarative output channel (plot value, plot color,
// …). The output's static declaration lives in Program.outputs.
export interface EmitStmt extends IrNode {
  readonly kind: typeof IrKind.Emit;
  readonly output: OutputDecl;
  readonly args: readonly IrExpr[];
  // Canonical channel indices in source evaluation order. Output metadata and
  // the ABI remain canonical; only evaluation follows the source call.
  readonly argumentEvaluationOrder: readonly number[];
}

export interface BreakStmt extends IrNode {
  readonly kind: typeof IrKind.Break;
}

export interface ContinueStmt extends IrNode {
  readonly kind: typeof IrKind.Continue;
}
