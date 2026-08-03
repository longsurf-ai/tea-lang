// Purpose: Debug printers for tokens and AST — human-readable dumps behind `tea parse`; formatting only, no semantic logic.

import {formatPos} from '../base/pos';
import type {File} from './nodes';
import type {Token} from './tokens';

export function dumpTokens(tokens: readonly Token[]): string {
  return tokens
    .map(t => `${formatPos(t.pos)}\t${t.tok}\t${JSON.stringify(t.lit)}`)
    .join('\n');
}

export function dumpFile(file: File): string {
  // Placeholder printer until the node vocabulary deserves a structured one.
  return JSON.stringify(file.stmtList, null, 2);
}
