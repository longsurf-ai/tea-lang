// Purpose: Incremental scanner — a stateful cursor advanced one token at a time by next(); owns all lexical decisions including indent/dedent synthesis.

import type {Pos, PosBase} from '../base/pos';
import type {ErrorHandler} from '../base/print';
import {unimplemented} from '../base/unimplemented';
import {Source} from './source';
import type {LitKind, Op, TokenKind} from './tokens';

// @agent invariant: the scanner never allocates Token objects. next() mutates
// the public token fields in place; they are valid only until the following
// next() call. The parser reads them directly.
export class Scanner {
  // Current token, valid after next():
  tok: TokenKind = 'eof';
  // Token start position.
  pos: Pos;
  // Valid if tok is 'name' or 'literal'.
  lit = '';
  // Valid if tok is 'literal'.
  kind: LitKind | null = null;
  // Valid if tok is 'operator'.
  op: Op | null = null;
  prec = 0;

  private readonly source: Source;

  // Indentation stack: at each line start the scanner compares leading
  // whitespace against the top of this stack and synthesizes
  // 'indent'/'dedent' tokens; a run of closes is drained one token per next()
  // via pendingDedents. Line-structure rules are Pine's — Tea is a syntax
  // superset of Pine Script.
  private readonly indents: number[] = [0];
  private pendingDedents = 0;

  constructor(
    base: PosBase,
    src: string,
    private readonly errh: ErrorHandler,
  ) {
    this.source = new Source(base, src);
    this.pos = this.source.pos();
  }

  // Advance the scanner by one token, mutating the fields above. Lexical
  // errors are reported through errh and scanning continues.
  next(): void {
    unimplemented(
      'syntax/scanner: next',
      this.source,
      this.indents,
      this.pendingDedents,
      this.errh,
    );
  }
}
