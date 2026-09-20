// Purpose: Debug printers for tokens and AST — human-readable dumps behind `tea parse`; formatting only, no semantic logic.

import type {Pos} from '../base/pos';
import type {File, Node} from './nodes';
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

// One node per line: `Kind @line:col scalar=value ...`, children indented two
// spaces under a `field:` (or `field[i]:`) label. Null fields are omitted —
// their absence is grammar-implied. Field order is construction order, which
// the parser keeps stable. Stored end positions are omitted: the dump is a
// start-position view, and range queries read them through endPos().
const END_POSITION_FIELDS: ReadonlySet<string> = new Set(['dedent', 'rparen']);

function isPos(value: unknown): value is Pos {
  return (
    typeof value === 'object' &&
    value !== null &&
    'base' in value &&
    'line' in value &&
    'col' in value
  );
}

function isNode(value: unknown): value is Node & {readonly kind: string} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as {kind: unknown}).kind === 'string' &&
    'pos' in value
  );
}

function dumpNode(
  node: Node & {readonly kind: string},
  label: string,
  indent: string,
  out: string[],
): void {
  let head = `${indent}${label}${node.kind} @${node.pos.line}:${node.pos.col}`;
  const children: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'kind' ||
      key === 'pos' ||
      value === null ||
      END_POSITION_FIELDS.has(key)
    ) {
      continue;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      head += ` ${key}=${JSON.stringify(value)}`;
    } else if (isNode(value) || Array.isArray(value)) {
      children.push([key, value]);
    } else if (isPos(value)) {
      head += ` ${key}=@${value.line}:${value.col}`;
    }
  }
  out.push(head);
  for (const [key, value] of children) {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (isNode(item)) {
          dumpNode(item, `${key}[${i}]: `, `${indent}  `, out);
        }
      });
    } else if (isNode(value)) {
      dumpNode(value, `${key}: `, `${indent}  `, out);
    }
  }
}

export function dumpFile(file: File): string {
  const out: string[] = [];
  dumpNode(file, '', '', out);
  return out.join('\n');
}
