// Purpose: Tea AST node definitions — plain immutable data discriminated on `kind`; every node carries the position of its leftmost defining token.

import type {Pos} from '../base/pos';
import {Op, type LitKind} from './tokens';

// Named constants for every node kind (the Tok pattern applied to the
// AST): use sites say NodeKind.DeclStmt at construction and comparison
// alike; the underlying value stays the node's own name, so dumps and
// goldens remain self-describing.
export const NodeKind = {
  File: 'File',
  ExprStmt: 'ExprStmt',
  DeclStmt: 'DeclStmt',
  AssignStmt: 'AssignStmt',
  FuncDecl: 'FuncDecl',
  Param: 'Param',
  TypeDecl: 'TypeDecl',
  FieldDecl: 'FieldDecl',
  EnumDecl: 'EnumDecl',
  EnumMember: 'EnumMember',
  ImportStmt: 'ImportStmt',
  BreakStmt: 'BreakStmt',
  ContinueStmt: 'ContinueStmt',
  BadStmt: 'BadStmt',
  TypeAnnotation: 'TypeAnnotation',
  GenericType: 'GenericType',
  ArrayType: 'ArrayType',
  Name: 'Name',
  BasicLit: 'BasicLit',
  UnaryExpr: 'UnaryExpr',
  BinaryExpr: 'BinaryExpr',
  CondExpr: 'CondExpr',
  Arg: 'Arg',
  CallExpr: 'CallExpr',
  SelectorExpr: 'SelectorExpr',
  HistoryExpr: 'HistoryExpr',
  TupleExpr: 'TupleExpr',
  ParenExpr: 'ParenExpr',
  TuplePattern: 'TuplePattern',
  Block: 'Block',
  IfExpr: 'IfExpr',
  ForExpr: 'ForExpr',
  ForInExpr: 'ForInExpr',
  WhileExpr: 'WhileExpr',
  SwitchExpr: 'SwitchExpr',
  SwitchArm: 'SwitchArm',
  BadExpr: 'BadExpr',
} as const;

export type NodeKindName = (typeof NodeKind)[keyof typeof NodeKind];

// @agent invariant: nodes record what was written, never what was inferred —
// qualifiers, types, and effect calls are plain syntax here; classification
// happens in typecheck/lowering. Closed unions; BadExpr/BadStmt keep the tree
// total during error recovery, so no field is null because parsing failed.
export interface Node {
  readonly pos: Pos;
}

// ---- file -------------------------------------------------------------------

export interface File extends Node {
  readonly kind: typeof NodeKind.File;
  // Declared Tea language version from //@version=, null if absent.
  readonly version: string | null;
  readonly stmtList: readonly Stmt[];
  readonly eof: Pos;
}

// ---- statements -------------------------------------------------------------

export type Stmt =
  | ExprStmt
  | DeclStmt
  | AssignStmt
  | FuncDecl
  | TypeDecl
  | EnumDecl
  | ImportStmt
  | BreakStmt
  | ContinueStmt
  | BadStmt;

// Any expression at statement position: plot(...) calls, an if/switch used
// for its effects, etc.
export interface ExprStmt extends Node {
  readonly kind: typeof NodeKind.ExprStmt;
  readonly x: Expr;
}

// Persistence axis, orthogonal to qualifiers: plain re-evaluates its
// initializer each bar, var carries the previous iteration's value forward,
// varip carries it across ticks without rollback. Const is a Tea extension.
export const Mode = {
  None: 'none',
  Var: 'var',
  Varip: 'varip',
  Const: 'const',
} as const;

export type DeclMode = (typeof Mode)[keyof typeof Mode];

// `=` declares: `var float b = 1.4`, `[macd, signal] = ta.macd(...)`.
export interface DeclStmt extends Node {
  readonly kind: typeof NodeKind.DeclStmt;
  readonly mode: DeclMode;
  readonly declType: TypeAnnotation | null;
  readonly target: Name | TuplePattern;
  readonly init: Expr;
}

export const AssignOp = {
  Define: ':=',
  Plus: '+=',
  Minus: '-=',
  Star: '*=',
  Slash: '/=',
  Percent: '%=',
} as const;

export type AssignOp = (typeof AssignOp)[keyof typeof AssignOp];

// The two directions of the compound-assignment correspondence, owned here
// next to the vocabulary: the parser folds `x <op>= v` from the scanned base
// op, and the checker/noder desugar back to the base op.
export const COMPOUND_ASSIGN: Readonly<Partial<Record<Op, AssignOp>>> = {
  [Op.Plus]: AssignOp.Plus,
  [Op.Minus]: AssignOp.Minus,
  [Op.Star]: AssignOp.Star,
  [Op.Slash]: AssignOp.Slash,
  [Op.Percent]: AssignOp.Percent,
};

export const ASSIGN_BASE_OP: Readonly<Partial<Record<AssignOp, Op>>> = {
  [AssignOp.Plus]: Op.Plus,
  [AssignOp.Minus]: Op.Minus,
  [AssignOp.Star]: Op.Star,
  [AssignOp.Slash]: Op.Slash,
  [AssignOp.Percent]: Op.Percent,
};

// `:=` and compound forms reassign an already-declared target (a Name or a
// SelectorExpr like obj.field; validated semantically, not syntactically).
export interface AssignStmt extends Node {
  readonly kind: typeof NodeKind.AssignStmt;
  readonly op: AssignOp;
  readonly target: Expr;
  readonly value: Expr;
}

// `ma(float source, int length, simple string maType) => ...`; body is the
// inline expression or an indented block.
export interface FuncDecl extends Node {
  readonly kind: typeof NodeKind.FuncDecl;
  readonly exported: boolean;
  readonly method: boolean;
  readonly name: Name;
  readonly params: readonly Param[];
  readonly body: Expr | Block;
}

export interface Param extends Node {
  readonly kind: typeof NodeKind.Param;
  readonly paramType: TypeAnnotation | null;
  readonly name: Name;
  readonly defaultValue: Expr | null;
}

// `type Foo` with indented field lines.
export interface TypeDecl extends Node {
  readonly kind: typeof NodeKind.TypeDecl;
  readonly exported: boolean;
  readonly name: Name;
  readonly fields: readonly FieldDecl[];
}

export interface FieldDecl extends Node {
  readonly kind: typeof NodeKind.FieldDecl;
  readonly fieldType: TypeAnnotation;
  readonly name: Name;
  readonly defaultValue: Expr | null;
}

export interface EnumDecl extends Node {
  readonly kind: typeof NodeKind.EnumDecl;
  readonly exported: boolean;
  readonly name: Name;
  readonly members: readonly EnumMember[];
}

export interface EnumMember extends Node {
  readonly kind: typeof NodeKind.EnumMember;
  readonly name: Name;
  readonly title: Expr | null;
}

// `import owner/name/version [as alias]`. The path is one atomic literal
// (litKind 'path') produced by a parser-directed rescan; splitting and
// validating its owner/name/version segments is the import resolver's
// concern, never the parser's.
export interface ImportStmt extends Node {
  readonly kind: typeof NodeKind.ImportStmt;
  readonly path: BasicLit;
  readonly alias: Name | null;
}

export interface BreakStmt extends Node {
  readonly kind: typeof NodeKind.BreakStmt;
}

export interface ContinueStmt extends Node {
  readonly kind: typeof NodeKind.ContinueStmt;
}

export interface BadStmt extends Node {
  readonly kind: typeof NodeKind.BadStmt;
}

// ---- type annotations -------------------------------------------------------

// `simple string maType` — qualifier and type name recorded as written; the
// qualifier is a plain Name validated by typecheck, never by the parser.
export interface TypeAnnotation extends Node {
  readonly kind: typeof NodeKind.TypeAnnotation;
  readonly qualifier: Name | null;
  readonly name: TypeName;
}

export type TypeName = Name | SelectorExpr | GenericType | ArrayType;

// `array<float>`, `map<string, float>`, `array<HeatBin>`.
export interface GenericType extends Node {
  readonly kind: typeof NodeKind.GenericType;
  readonly name: Name | SelectorExpr;
  readonly args: readonly TypeName[];
}

// Legacy shorthand `float[]`.
export interface ArrayType extends Node {
  readonly kind: typeof NodeKind.ArrayType;
  readonly elem: TypeName;
}

// ---- expressions ------------------------------------------------------------

export type Expr =
  | Name
  | BasicLit
  | UnaryExpr
  | BinaryExpr
  | CondExpr
  | CallExpr
  | SelectorExpr
  | HistoryExpr
  | TupleExpr
  | ParenExpr
  | IfExpr
  | ForExpr
  | ForInExpr
  | WhileExpr
  | SwitchExpr
  | BadExpr;

export interface Name extends Node {
  readonly kind: typeof NodeKind.Name;
  readonly value: string;
}

// bad mirrors the scanner's malformed-literal reporting so later stages never
// re-report or re-parse a literal the frontend already flagged.
export interface BasicLit extends Node {
  readonly kind: typeof NodeKind.BasicLit;
  readonly litKind: LitKind;
  readonly value: string;
  readonly bad: boolean;
}

export interface UnaryExpr extends Node {
  readonly kind: typeof NodeKind.UnaryExpr;
  readonly op: Op;
  readonly x: Expr;
}

export interface BinaryExpr extends Node {
  readonly kind: typeof NodeKind.BinaryExpr;
  readonly op: Op;
  readonly x: Expr;
  readonly y: Expr;
}

// `cond ? then : else`.
export interface CondExpr extends Node {
  readonly kind: typeof NodeKind.CondExpr;
  readonly cond: Expr;
  readonly then: Expr;
  readonly else: Expr;
}

export interface Arg extends Node {
  readonly kind: typeof NodeKind.Arg;
  readonly name: Name | null;
  readonly value: Expr;
}

// `plot(hist, "Histogram", hColor, style = plot.style_columns)`,
// `array.new<float>(0)`.
export interface CallExpr extends Node {
  readonly kind: typeof NodeKind.CallExpr;
  readonly fun: Expr;
  readonly typeArgs: readonly TypeName[] | null;
  readonly args: readonly Arg[];
}

export interface SelectorExpr extends Node {
  readonly kind: typeof NodeKind.SelectorExpr;
  readonly x: Expr;
  readonly sel: Name;
}

// `close[1]` — series history referencing, never collection indexing.
export interface HistoryExpr extends Node {
  readonly kind: typeof NodeKind.HistoryExpr;
  readonly x: Expr;
  readonly offset: Expr;
}

// `[macd, signal, hist]` in value position (multi-value returns).
export interface TupleExpr extends Node {
  readonly kind: typeof NodeKind.TupleExpr;
  readonly elems: readonly Expr[];
}

export interface ParenExpr extends Node {
  readonly kind: typeof NodeKind.ParenExpr;
  readonly x: Expr;
}

// `[a, b]` in binding position (tuple declarations, for-in targets).
export interface TuplePattern extends Node {
  readonly kind: typeof NodeKind.TuplePattern;
  readonly elems: readonly Name[];
}

// An indented statement list; where a value is required, it is the last
// statement's expression — enforced by typecheck, not encoded here.
export interface Block extends Node {
  readonly kind: typeof NodeKind.Block;
  readonly stmtList: readonly Stmt[];
}

// Control structures are expressions: `ma = if long ... else ...` is legal,
// and at statement position they ride in an ExprStmt.
export interface IfExpr extends Node {
  readonly kind: typeof NodeKind.IfExpr;
  readonly cond: Expr;
  readonly then: Block;
  readonly else: IfExpr | Block | null;
}

// `for i = 0 to 9 by 2`.
export interface ForExpr extends Node {
  readonly kind: typeof NodeKind.ForExpr;
  readonly index: Name;
  readonly from: Expr;
  readonly to: Expr;
  readonly step: Expr | null;
  readonly body: Block;
}

// `for x in arr`, `for [i, v] in arr`.
export interface ForInExpr extends Node {
  readonly kind: typeof NodeKind.ForInExpr;
  readonly target: Name | TuplePattern;
  readonly x: Expr;
  readonly body: Block;
}

export interface WhileExpr extends Node {
  readonly kind: typeof NodeKind.WhileExpr;
  readonly cond: Expr;
  readonly body: Block;
}

// `switch [subject]` with `pattern => body` arms; a null pattern is the
// default arm.
export interface SwitchExpr extends Node {
  readonly kind: typeof NodeKind.SwitchExpr;
  readonly subject: Expr | null;
  readonly arms: readonly SwitchArm[];
}

export interface SwitchArm extends Node {
  readonly kind: typeof NodeKind.SwitchArm;
  readonly pattern: Expr | null;
  readonly body: Expr | Block;
}

export interface BadExpr extends Node {
  readonly kind: typeof NodeKind.BadExpr;
}
