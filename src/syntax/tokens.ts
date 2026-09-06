// Purpose: Token vocabulary — named token constants over a string-literal base, with op/prec and literal-kind refinements; keywords via table.

import type {Pos} from '../base/pos';

// Named constants for every token kind (go/token's token.LPAREN, tsc's
// SyntaxKind): use sites say Tok.Lparen and stay renamable/navigable, while
// the underlying value stays a stable, self-describing string for dumps and
// goldens. All binary operators collapse into Tok.Operator refined by
// Scanner.op/Scanner.prec; Newline/Indent/Dedent are synthesized by the
// scanner's indent stack and consumed like ';' and braces.
export const Tok = {
  Eof: 'eof',
  Newline: 'newline',
  Indent: 'indent',
  Dedent: 'dedent',
  Name: 'name',
  Literal: 'literal',
  Operator: 'operator', // refined by op/prec, includes 'and'/'or'/'not'
  Assign: 'assign', // =
  Define: 'define', // :=
  AssignOp: 'assignop', // += -= *= /= %=, refined by op
  Arrow: 'arrow', // =>
  Question: 'question', // ?
  Colon: 'colon', // :
  Lparen: 'lparen',
  Rparen: 'rparen',
  Lbrack: 'lbrack',
  Rbrack: 'rbrack',
  Lbrace: 'lbrace',
  Rbrace: 'rbrace',
  Comma: 'comma',
  Dot: 'dot',
  // Keywords each get their own token kind; `and`/`or`/`not` are scanned as
  // Operator, and `true`/`false`/`na` are plain names resolved semantically.
  Var: 'var',
  Varip: 'varip',
  Const: 'const',
  If: 'if',
  Else: 'else',
  For: 'for',
  To: 'to',
  By: 'by',
  In: 'in',
  While: 'while',
  Switch: 'switch',
  Import: 'import',
  As: 'as',
  Export: 'export',
  Struct: 'struct',
  Type: 'type',
  Interface: 'interface',
  Enum: 'enum',
  This: 'this',
  Break: 'break',
  Continue: 'continue',
  Return: 'return',
  Emit: 'emit',
} as const;

export type TokenKind = (typeof Tok)[keyof typeof Tok];

// Reserved keywords are never valid names. Contextual keywords are scanned as
// named tokens but the parser admits them as names outside their governing
// productions. Editor projections consume this split so they do not paint
// valid names such as `export = 1` as keywords.
export const RESERVED_KEYWORDS = [
  Tok.Var,
  Tok.Varip,
  Tok.Const,
  Tok.If,
  Tok.Else,
  Tok.For,
  Tok.While,
  Tok.Switch,
  Tok.Break,
  Tok.Continue,
  Tok.Return,
  Tok.Emit,
  Tok.This,
] as const;

export const CONTEXTUAL_KEYWORDS = [
  Tok.To,
  Tok.By,
  Tok.In,
  Tok.Import,
  Tok.As,
  Tok.Export,
  Tok.Struct,
  Tok.Type,
  Tok.Interface,
  Tok.Enum,
] as const;

export const KEYWORDS = [...RESERVED_KEYWORDS, ...CONTEXTUAL_KEYWORDS] as const;
export type KeywordKind = (typeof KEYWORDS)[number];

// Valid when tok === Tok.Literal. Path is produced only by the
// parser-directed import-path rescan (`import owner/name/version`), never by
// ordinary scanning. Named constants over lexeme-valued strings, like Tok.
export const LitKind = {
  Int: 'int',
  Float: 'float',
  String: 'string',
  Color: 'color',
  Path: 'path',
} as const;

export type LitKind = (typeof LitKind)[keyof typeof LitKind];

// Valid when tok === Tok.Operator (binary/unary operators) or Tok.AssignOp
// (the base arithmetic op of a compound assignment). This is the SURFACE
// vocabulary — constants are named by glyph, values are the lexemes; the
// semantic operation vocabulary is ir's IrOp (the noder maps between them).
export const Op = {
  Or: 'or',
  And: 'and',
  Not: 'not',
  EqEq: '==',
  NotEq: '!=',
  Lt: '<',
  Le: '<=',
  Gt: '>',
  Ge: '>=',
  Plus: '+',
  Minus: '-',
  Star: '*',
  Slash: '/',
  Percent: '%',
} as const;

export type Op = (typeof Op)[keyof typeof Op];

// The parser accepts these operators in prefix position. Binary roles remain
// separate because `not` is unary-only while `+` and `-` have both roles.
export const UNARY_OPERATORS = [Op.Plus, Op.Minus, Op.Not] as const;
export type UnaryOperator = (typeof UNARY_OPERATORS)[number];
const UNARY_OPERATOR_SET: ReadonlySet<Op> = new Set(UNARY_OPERATORS);

export function isUnaryOperator(op: Op): op is UnaryOperator {
  return UNARY_OPERATOR_SET.has(op);
}

export const BINARY_OPERATORS = [
  Op.Or,
  Op.And,
  Op.EqEq,
  Op.NotEq,
  Op.Lt,
  Op.Le,
  Op.Gt,
  Op.Ge,
  Op.Plus,
  Op.Minus,
  Op.Star,
  Op.Slash,
  Op.Percent,
] as const;
export type BinaryOperator = (typeof BINARY_OPERATORS)[number];

// Binding powers for precedence climbing, tightest last. 0 marks unary-only
// operators that never bind as binary.
export const PRECEDENCE: Record<Op, number> = {
  [Op.Not]: 0,
  [Op.Or]: 1,
  [Op.And]: 2,
  [Op.EqEq]: 3,
  [Op.NotEq]: 3,
  [Op.Lt]: 4,
  [Op.Le]: 4,
  [Op.Gt]: 4,
  [Op.Ge]: 4,
  [Op.Plus]: 5,
  [Op.Minus]: 5,
  [Op.Star]: 6,
  [Op.Slash]: 6,
  [Op.Percent]: 6,
};

// Materialized token snapshot. Debug/test surface ONLY (tokenize(), dumper);
// the scanner never allocates these — it exposes mutable fields instead.
export interface Token {
  readonly tok: TokenKind;
  readonly lit: string;
  readonly kind: LitKind | null;
  readonly op: Op | null;
  readonly pos: Pos;
}
