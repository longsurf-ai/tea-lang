// Purpose: Tea IR nodes — the noder's typed, resolved body vocabulary; every expression carries its type and qualifier, and every use references its declaration object directly.

import type {Pos} from '../base/pos';
import type {ConstValue, Storage, Qualifier, StructType, Type} from './type';
import type {
  IrFunc,
  OutputDecl,
  ParamInput,
  RequestEdge,
  BuiltinInput,
  SeriesInput,
} from './program';
export {Storage} from './type';

// How deep a place's history must reach, resolvable no later than bind time:
// None = never read historically (no buffer materializes); Const = known
// at compile time; Bound = an input/simple-qualified expression evaluated
// at bind; Capped = dynamic (series) offsets bounded by an explicit
// cap — itself bind-resolvable and supplied by the engine default.
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
  readonly storage: Storage;
  // Type/qualifier copy from semantic facts; depth is annotated by the
  // noder's depth pass. These working fields are read-only afterward.
  type: Type;
  qualifier: Qualifier;
  depth: HistoryDepth;
}

export const IrKind = {
  Const: 'Const', // Literal or folded constant, e.g. `42` or folded `1 + 2`.
  Read: 'Read', // Current binding value, e.g. `close` or `total`.
  HistRead: 'HistRead', // Historical binding value, e.g. `close[1]`.
  Binary: 'Binary', // Binary operation, e.g. `x + y`.
  Unary: 'Unary', // Unary operation, e.g. `-x` or `not ready`.
  CallFunc: 'CallFunc', // Tea function or method call, e.g. `average(x, y)` or `counter.add(1)`.
  CallNative: 'CallNative', // Resolved primitive call, e.g. `math.abs(x)` or `xs.push(x)`.
  NewStruct: 'NewStruct', // New struct value, e.g. `Point.new(x, y)`.
  MakeTuple: 'MakeTuple', // Tuple value, e.g. `[x, y]`.
  TupleGet: 'TupleGet', // Tuple element from destructuring, e.g. `x` in `[x, y] = pair()`.
  Selector: 'Selector', // Field selection for reading or assignment, e.g. `point.x`.
  IfExpr: 'IfExpr', // Block-form conditional, e.g. `if ready ... else ...`.
  SwitchExpr: 'SwitchExpr', // Value-producing switch, e.g. `switch side`.
  ForExpr: 'ForExpr', // Counted range loop, e.g. `for i = 0 to 9`.
  ForInExpr: 'ForInExpr', // Collection iteration, e.g. `for x in xs`.
  WhileExpr: 'WhileExpr', // Condition-controlled loop, e.g. `while ready`.
  BlockExpr: 'BlockExpr', // Indented block with an optional trailing value, e.g. an `if` body.
  InitName: 'InitName', // Persistent name initialization, e.g. `var x = 0`.
  Assign: 'Assign', // Assignment to a binding or field, e.g. `x += 1` or `point.x := 1`.
  Emit: 'Emit', // Write a named output column, e.g. `emit "price" close` or `emit.append "fills" fill`.
  Return: 'Return', // Return from the enclosing function, e.g. `return total`.
  Break: 'Break', // Exit from the nearest loop, e.g. `break`.
  Continue: 'Continue', // Jump to the next loop iteration, e.g. `continue`.
} as const;

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
// data; builtin places are typed values; requests are merged child-Program
// results. Only names are writable.
export const PlaceKind = {
  Name: 'name',
  Param: 'param',
  Series: 'series',
  Builtin: 'builtin',
  Request: 'request',
} as const;

export type Place =
  | {readonly kind: typeof PlaceKind.Name; readonly name: Name}
  | {readonly kind: typeof PlaceKind.Param; readonly param: ParamInput}
  | {readonly kind: typeof PlaceKind.Series; readonly series: SeriesInput}
  | {
      readonly kind: typeof PlaceKind.Builtin;
      readonly builtin: BuiltinInput;
    }
  | {readonly kind: typeof PlaceKind.Request; readonly request: RequestEdge};

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
  | ReadExpr
  | HistReadExpr
  | BinaryExpr
  | UnaryExpr
  | CallFuncExpr
  | CallNativeExpr
  | NewStructExpr
  | MakeTupleExpr
  | TupleGetExpr
  | SelectorExpr
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

/** A current value read. Each occurrence retains its own source position. */
export interface ReadExpr extends IrExprBase {
  readonly kind: typeof IrKind.Read;
  readonly place: Place;
}

// Explicit history retains its offset even at zero; only a direct readable
// binding can supply the place, and noding has already checked that rule.
export interface HistReadExpr extends IrExprBase {
  readonly kind: typeof IrKind.HistRead;
  readonly place: Place;
  readonly offset: IrExpr;
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

/** A user call captures its optional receiver before explicit arguments.
 * The callee's mode owns receiver validation; slots preserve written-call state.
 */
export interface CallFuncExpr extends IrExprBase {
  readonly kind: typeof IrKind.CallFunc;
  readonly func: IrFunc;
  readonly receiver: IrExpr | null;
  readonly slot: number;
  readonly args: readonly IrExpr[];
  readonly argumentEvaluationOrder: readonly number[];
}

/** Concrete primitive signature projected from checking. Effect controls
 * bind-time legality; argument types follow the call's explicit operand list.
 */
export interface Intrinsic {
  readonly name: string;
  readonly argTypes: readonly Type[];
  readonly resultType: Type;
  readonly effect: 'pure' | 'read' | 'write' | 'allocate';
}

/** A resolved primitive. A writable receiver is captured and read before
 * arguments; its replacement is assigned before the call yields its result.
 */
export interface CallNativeExpr extends IrExprBase {
  readonly kind: typeof IrKind.CallNative;
  readonly native: Intrinsic;
  readonly receiver: WritableExpr | null;
  readonly args: readonly IrExpr[];
  readonly argumentEvaluationOrder: readonly number[];
}

export interface NewStructExpr extends IrExprBase {
  readonly kind: typeof IrKind.NewStruct;
  readonly structType: StructType;
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

export interface SelectorExpr extends IrExprBase {
  readonly kind: typeof IrKind.Selector;
  readonly x: IrExpr;
  readonly fieldIndex: number;
}

/** An assignable expression. Field targets capture and validate their receiver
 * before the RHS; historical reads and external inputs are never writable.
 */
export type WritableExpr =
  | (ReadExpr & {readonly place: Extract<Place, {kind: typeof PlaceKind.Name}>})
  | SelectorExpr;

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

// Expressions can appear directly in statement lists; their values are discarded.
export type IrStmt =
  | IrExpr
  | InitNameStmt
  | AssignStmt
  | EmitStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt;

/** Expressions carry a value type, including when used as statements. */
export function isExpr(stmt: IrStmt): stmt is IrExpr {
  return 'type' in stmt;
}

// A persistent declaration at its lexical execution site. `value` is
// evaluated only when the target slot is still semantically uninitialized;
// the runtime makes that state transactional with the row attempt.
export interface InitNameStmt extends IrNode {
  readonly kind: typeof IrKind.InitName;
  readonly name: Name;
  readonly value: IrExpr;
}

/** Assignment evaluates the destination once before the RHS. A non-null op
 * also captures its old value before RHS effects, as in `point.x += f()`.
 */
export interface AssignStmt extends IrNode {
  readonly kind: typeof IrKind.Assign;
  readonly target: WritableExpr;
  readonly value: IrExpr;
  readonly op: IrBinaryOp | null;
}

/** Capture a value into its named column. The declaration selects set or append;
 * the runtime publishes buffered values only after the row succeeds.
 */
export interface EmitStmt extends IrNode {
  readonly kind: typeof IrKind.Emit;
  readonly output: OutputDecl;
  readonly value: IrExpr;
}

/** Exit the enclosing Tea function; its caller still owns the row transaction. */
export interface ReturnStmt extends IrNode {
  readonly kind: typeof IrKind.Return;
  readonly value: IrExpr | null;
}

export interface BreakStmt extends IrNode {
  readonly kind: typeof IrKind.Break;
}

export interface ContinueStmt extends IrNode {
  readonly kind: typeof IrKind.Continue;
}
