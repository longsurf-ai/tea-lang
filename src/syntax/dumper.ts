// Purpose: Debug printers for tokens and AST — human-readable dumps behind `tea parse`; formatting only, no semantic logic.

import type {File} from './nodes';
import type {Token} from './tokens';

// Token dumps show only the basename — the reader already knows which file
// they asked about; full paths stay on error messages.
function baseName(filename: string): string {
  const cut = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  return cut === -1 ? filename : filename.slice(cut + 1);
}

export function dumpTokens(tokens: readonly Token[]): string {
  return tokens
    .map(t => {
      let detail = t.lit;
      if (t.tok === 'operator' || t.tok === 'assignop') {
        detail = t.op ?? '';
      } else if (t.tok === 'literal') {
        detail = `${t.kind ?? '?'}:${t.lit}`;
      }
      const where = `${baseName(t.pos.base.filename)}:${t.pos.line}:${t.pos.col}`;
      return `${where}\t${t.tok}\t${JSON.stringify(detail)}`;
    })
    .join('\n');
}

export function dumpFile(file: File): string {
  // Placeholder printer until the node vocabulary deserves a structured one.
  return JSON.stringify(file.stmtList, null, 2);
}
