// Purpose: Tea IR nodes — the noder's typed, resolved body vocabulary; every expression carries its type and qualifier, and every use references its declaration object directly.

import type {Pos} from '../base/pos';
import type {ConstValue, Qualifier, Type, UdtType} from './type';
import type {
  IrFunc,
  OutputDecl,
  ParamInput,
  RequestEdge,
  SeriesInput,
} from './program';

// Data series are bound by host name ('close', 'syminfo.tickerid'), unlike
// compiler-internal objects which are identified by reference.
export type DataSeriesId = string;

// Minted per stateful call site: the slot selects that call site's
// sub-frame within the caller's frame. Frames nest along the static call
// graph, so the runtime pre-allocates the whole frame tree at bind time.
export type SlotId = number;

// Persistence, orthogonal to qualifiers: perBar re-initializes each
// iteration, var carries the previous iteration's value forward (rolled back
// on provisional re-execution), varip persists across ticks without rollback.
export type NameStorage = 'perBar' | 'var' | 'varip';

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

// A declared variable. One object per declaration; every use references it —
// identity is the object, there is no id and no table. The binder creates
// it, the checker and depth pass annotate the mutable analysis fields, the
// noder threads it into trees: one object set from binding to codegen.
// Variable enumerations (allocation plans, serialized indices) are
// projections derived by walking, produced at the boundary that needs them.
export interface Name {
  readonly name: string;
  readonly storage: NameStorage;
  // Annotated during checking and depth resolution — working fields, mutable
  // by the owning pass (the scanner-field precedent), read-only after.
  type: Type;
  qualifier: Qualifier;
  depth: HistoryDepth;
  // First-bar initializer for var/varip storage, evaluated once by the
  // runtime; null for perBar names, which the body writes every iteration.
  init: IrExpr | null;
}

export const IrKind = {
  Const: 'Const',
  HistRead: 'HistRead',
  Binary: 'Binary',
  Unary: 'Unary',
  Cond: 'Cond',
  CallFunc: 'CallFunc',
  CallNative: 'CallNative',
  NewUdt: 'NewUdt',
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
  WriteField: 'WriteField',
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

// A readable location, referencing its declaration object directly. Names
// are script/function variables; params are bind-time inputs; series are
// runtime-provided per-bar sources; requests are merged child-Program
// results. Only names are writable.
export type Place =
  | {readonly kind: 'name'; readonly name: Name}
  | {readonly kind: 'param'; readonly param: ParamInput}
  | {readonly kind: 'series'; readonly series: SeriesInput}
  | {readonly kind: 'request'; readonly request: RequestEdge};

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
  | HistReadExpr
  | BinaryExpr
  | UnaryExpr
  | CondExpr
  | CallFuncExpr
  | CallNativeExpr
  | NewUdtExpr
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
  readonly func: IrFunc;
  readonly slot: SlotId;
  readonly args: readonly IrExpr[];
}

// A native primitive call (data-source-, effect-, or intrinsic-classed per
// the catalog). Stateful natives also carry a call-site slot.
export interface CallNativeExpr extends IrExprBase {
  readonly kind: typeof IrKind.CallNative;
  readonly native: string;
  readonly slot: SlotId | null;
  readonly args: readonly IrExpr[];
}

export interface NewUdtExpr extends IrExprBase {
  readonly kind: typeof IrKind.NewUdt;
  readonly udt: UdtType;
  readonly args: readonly IrExpr[];
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
  readonly field: string;
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
  | WriteFieldStmt
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

export interface WriteFieldStmt extends IrNode {
  readonly kind: typeof IrKind.WriteField;
  readonly x: IrExpr;
  readonly field: string;
  readonly value: IrExpr;
}

// A per-bar write into a declarative output channel (plot value, plot color,
// …). The output's static declaration lives in Program.outputs.
export interface EmitStmt extends IrNode {
  readonly kind: typeof IrKind.Emit;
  readonly output: OutputDecl;
  readonly args: readonly IrExpr[];
}

export interface BreakStmt extends IrNode {
  readonly kind: typeof IrKind.Break;
}

export interface ContinueStmt extends IrNode {
  readonly kind: typeof IrKind.Continue;
}
