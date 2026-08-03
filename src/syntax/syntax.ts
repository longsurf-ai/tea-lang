// Purpose: Public frontend entry — parse() is the only way other modules obtain a File; Scanner and Parser are syntax-internal.

import type {PosBase} from '../base/pos';
import type {ErrorHandler} from '../base/print';
import type {File} from './nodes';
import {Parser} from './parser';
import {Scanner} from './scanner';
import type {Token} from './tokens';

// Parse one source file. Errors flow through errh; the returned File may be
// partial.
export function parse(base: PosBase, src: string, errh: ErrorHandler): File {
  return new Parser(base, src, errh).parseFile();
}

// Debug/test surface only (`tea parse --tokens`): drives a scanner to EOF and
// materializes Token snapshots. The compile pipeline never calls this — the
// parser consumes the scanner incrementally.
export function tokenize(
  base: PosBase,
  src: string,
  errh: ErrorHandler,
): Token[] {
  const scanner = new Scanner(base, src, errh);
  const tokens: Token[] = [];
  do {
    scanner.next();
    tokens.push({tok: scanner.tok, lit: scanner.lit, pos: scanner.pos});
  } while (scanner.tok !== 'eof');
  return tokens;
}
