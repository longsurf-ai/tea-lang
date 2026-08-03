// Purpose: Token vocabulary produced by the scanner; kinds are placeholders until the scanner settles the real set.

import type {Span} from '../base/pos';

// Tea is indentation-sensitive (Pine-style if/else blocks), hence indent/dedent.
export const TOKEN_KINDS = [
  'eof',
  'newline',
  'indent',
  'dedent',
  'ident',
  'number',
  'string',
  'color',
  'keyword',
  'operator',
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface Token {
  readonly kind: TokenKind;
  readonly lexeme: string;
  readonly span: Span;
}
