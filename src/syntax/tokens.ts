// Purpose: Token vocabulary — small structural kind set with op/prec and literal-kind refinements; keywords via table.

import type {Pos} from '../base/pos';

// Keywords each get their own token kind. The list grows with the parser;
// builtins (plot, input) are names, not keywords.
export const KEYWORDS = ['var', 'const', 'if', 'else'] as const;
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
  'operator',
  'assign',
  'lparen',
  'rparen',
  'lbrack',
  'rbrack',
  'comma',
  'dot',
  ...KEYWORDS,
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

// Valid when tok === 'literal'. Vocabulary is unsettled; color literals
// (#ff0000) are first-class in Tea.
export type LitKind = 'int' | 'float' | 'string' | 'color';

// Valid when tok === 'operator'. Placeholder set; grows with the scanner.
export type Op =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>=';

// Binding powers for precedence climbing. Placeholder values; settled when
// the expression grammar lands.
export const PRECEDENCE: Record<Op, number> = {
  '==': 3,
  '!=': 3,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
};

// Materialized token snapshot. Debug/test surface ONLY (tokenize(), dumper);
// the scanner never allocates these — it exposes mutable fields instead.
export interface Token {
  readonly tok: TokenKind;
  readonly lit: string;
  readonly pos: Pos;
}
