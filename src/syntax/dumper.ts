// Purpose: Debug printers for tokens and AST — human-readable dumps behind `tea parse`; formatting only, no semantic logic.

import {formatPos} from '../base/pos';
import type {SyntaxFile} from './nodes';
import type {Token} from './tokens';

export function dumpTokens(tokens: readonly Token[]): string {
  return tokens
    .map(
      t => `${formatPos(t.span.start)}\t${t.kind}\t${JSON.stringify(t.lexeme)}`,
    )
    .join('\n');
}

export function dumpSyntaxFile(file: SyntaxFile): string {
  // Placeholder printer until the node vocabulary deserves a structured one.
  return JSON.stringify(file.statements, null, 2);
}
