// Purpose: Tea IR nodes — the noder's typed, resolved body vocabulary; every expression carries its type and qualifier, every name is a place reference.

import type {Pos} from '../base/pos';
import type {ConstValue, Qualifier, Type, UdtType} from './type';

// Identities minted by the noder. Plain aliases for now; the noder's
// constructors are the only mint, and branding can harden them later.
export type SlotId = number;
export type ParamId = number;
export type SeriesInputId = number;
export type RequestId = number;
export type FuncId = number;
export type OutputId = number;
// Distinguishes call sites of the same function instantiation so the runtime
// allocates separate state (per-call-site history and var slots).
export type CallStateId = number;

export const IrKind = {
  Const: 'Const',
  Read: 'Read',
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
  WriteSlot: 'WriteSlot',
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

// A readable location. Slots are script/function variables; params are
// bind-time inputs; series are lt only from checked, error-free syntax —
// there are no Bad nodes here; reruntime-provided per-bar sources; requests are
// merged child-Program results. Only slots are writable.
export type Place =
  | {readonly kind: 'slot'; readonly id: SlotId}
  | {readonly kind: 'param'; readonly id: ParamId}
  | {readonly kind: 'series'; readonly id: SeriesInputId}
  | {readonly kind: 'request'; readonly id: RequestId};

// @agent invariant: the IR is buicovery ends at the checker's phase barrier.
// Every expression carries (type, qualifier); the compiler DESCRIBES history
// (depths on slots, offsets on reads) and the runtime IMPLEMENTS it.
export interface IrNode {
  readonly pos: Pos;
}

export interface IrExprBase extends IrNode {
  readonly type: Type;
  readonly qualifier: Qualifier;
}

export type IrExpr =
  | ConstExpr
  | ReadExpr
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

// Current value when offset is null; history read (`x[k]`) otherwise. The
// checker guarantees offset qualifiers obey the bind-time depth rule.
export interface ReadExpr extends IrExprBase {
  readonly kind: typeof IrKind.Read;
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
  readonly func: FuncId;
  readonly state: CallStateId;
  readonly args: readonly IrExpr[];
}

// A native primitive call (data-source-, effect-, or intrinsic-classed per
// the catalog). Stateful natives also carry a call-site state id.
export interface CallNativeExpr extends IrExprBase {
  readonly kind: typeof IrKind.CallNative;
  readonly native: string;
  readonly state: CallStateId | null;
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
  readonly indexSlot: SlotId;
  readonly from: IrExpr;
  readonly to: IrExpr;
  readonly step: IrExpr | null;
  readonly body: BlockExpr;
}

export interface ForInExpr extends IrExprBase {
  readonly kind: typeof IrKind.ForInExpr;
  readonly targetSlots: readonly SlotId[];
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
  | WriteSlotStmt
  | WriteFieldStmt
  | EmitStmt
  | BreakStmt
  | ContinueStmt;

export interface ExprStmt extends IrNode {
  readonly kind: typeof IrKind.ExprStmt;
  readonly x: IrExpr;
}

// Declarations, reassignments, and compound assignments all become slot
// writes; the compound operator is desugared by the noder.
export interface WriteSlotStmt extends IrNode {
  readonly kind: typeof IrKind.WriteSlot;
  readonly slot: SlotId;
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
  readonly output: OutputId;
  readonly args: readonly IrExpr[];
}

export interface BreakStmt extends IrNode {
  readonly kind: typeof IrKind.Break;
}

export interface ContinueStmt extends IrNode {
  readonly kind: typeof IrKind.Continue;
}
