// Purpose: Test helpers for the syntax package — scan a source string and collect tokens, raw errors, and the declared version.

import {newFileBase, type Pos} from '../base/pos';
import {Scanner} from './scanner';
import type {Token} from './tokens';

export interface ScanError {
  readonly pos: Pos;
  readonly msg: string;
}

export interface ScanResult {
  readonly tokens: Token[];
  readonly errors: ScanError[];
  readonly version: string | null;
}

// Collects raw reports (no suppression, unlike Errors) so tests observe the
// scanner exactly.
export function scanText(src: string, filename = 'test.tea'): ScanResult {
  const errors: ScanError[] = [];
  const scanner = new Scanner(newFileBase(filename), src, (pos, msg) => {
    errors.push({pos, msg});
  });
  const tokens: Token[] = [];
  do {
    scanner.next();
    tokens.push({
      tok: scanner.tok,
      lit: scanner.lit,
      kind: scanner.kind,
      op: scanner.op,
      pos: scanner.pos,
    });
  } while (scanner.tok !== 'eof');
  return {tokens, errors, version: scanner.version};
}

export function kinds(result: ScanResult): string[] {
  return result.tokens.map(t => t.tok);
}
