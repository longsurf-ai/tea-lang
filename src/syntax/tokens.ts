// Purpose: Token vocabulary — small structural kind set with op/prec and literal-kind refinements; keywords via table.

import type {Pos} from '../base/pos';

// Keywords each get their own token kind. `and`/`or`/`not` are scanned as
// 'operator' (they participate in precedence climbing); `true`/`false`/`na`
// are plain names resolved semantically. Builtins (plot, input) are names.
export const KEYWORDS = [
  'var',
  'varip',
  'const',
  'if',
  'else',
  'for',
  'to',
  'by',
  'in',
  'while',
  'switch',
  'import',
  'as',
  'export',
  'method',
  'type',
  'enum',
  'break',
  'continue',
] as const;
export type KeywordKind = (typeof KEYWORDS)[number];

// Structural kinds. All binary operators collapse into 'operator' and are
// refined by Scanner.op/Scanner.prec — the expression parser runs on
// precedence climbing, not on per-operator token kinds.
// 'newline' | 'indent' | 'dedent' are synthesized by the scanner's indent
// stack; the parser consumes them like ';' and braces.
export const TOKEN_KINDS = [
  'eof',
  'newline',
  'indent',
  'dedent',
  'name',
  'literal',
  'operator', // refined by op/prec, includes 'and'/'or'/'not'
  'assign', // =
  'define', // :=
  'assignop', // += -= *= /= %=, refined by op
  'arrow', // =>
  'question', // ?
  'colon', // :
  'lparen',
  'rparen',
  'lbrack',
  'rbrack',
  'comma',
  'dot',
  ...KEYWORDS,
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

// Valid when tok === 'literal'.
export type LitKind = 'int' | 'float' | 'string' | 'color';

// Valid when tok === 'operator' (binary/unary operators) or tok ===
// 'assignop' (the base arithmetic op of a compound assignment).
export type Op =
  | 'or'
  | 'and'
  | 'not'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

// Binding powers for precedence climbing, tightest last. 0 marks unary-only
// operators that never bind as binary.
export const PRECEDENCE: Record<Op, number> = {
  not: 0,
  or: 1,
  and: 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
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
