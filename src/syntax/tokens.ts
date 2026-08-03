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
  Method: 'method',
  Type: 'type',
  Enum: 'enum',
  Break: 'break',
  Continue: 'continue',
} as const;

export type TokenKind = (typeof Tok)[keyof typeof Tok];

export const KEYWORDS = [
  Tok.Var,
  Tok.Varip,
  Tok.Const,
  Tok.If,
  Tok.Else,
  Tok.For,
  Tok.To,
  Tok.By,
  Tok.In,
  Tok.While,
  Tok.Switch,
  Tok.Import,
  Tok.As,
  Tok.Export,
  Tok.Method,
  Tok.Type,
  Tok.Enum,
  Tok.Break,
  Tok.Continue,
] as const;
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
