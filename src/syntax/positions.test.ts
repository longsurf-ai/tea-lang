// Purpose: endPos() tests — exact ends for leaves, calls, and blocks, plus totality and containment over the parse corpus.

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import type {Pos} from '../base/pos';
import {NodeKind, type AnyNode, type Block, type CallExpr} from './nodes';
import {endPos} from './syntax';
import {parseText} from './testing';

const FIXTURES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures',
);

function isNode(value: unknown): value is AnyNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'pos' in value
  );
}

function childrenOf(node: AnyNode): AnyNode[] {
  return Object.values(node)
    .flatMap((value: unknown) => (Array.isArray(value) ? value : [value]))
    .filter(isNode);
}

function nodesOf(root: AnyNode): AnyNode[] {
  return [root, ...childrenOf(root).flatMap(nodesOf)];
}

function at(pos: Pos): string {
  return `${pos.line}:${pos.col}`;
}

// `kind@line:col` of the node's start -> its end, for every node of `kind`.
function endsOf(src: string, kind: AnyNode['kind']): string[] {
  return nodesOf(parseText(src).file)
    .filter(node => node.kind === kind)
    .map(node => `${at(node.pos)}-${at(endPos(node))}`);
}

function before(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

describe('leaves end after their lexeme', () => {
  test('names and literals', () => {
    const src = 'total = "a b" + 1.25 + #ff0000\n';
    expect(endsOf(src, NodeKind.Name)).toEqual(['1:1-1:6']);
    expect(endsOf(src, NodeKind.BasicLit)).toEqual([
      '1:9-1:14',
      '1:17-1:21',
      '1:24-1:31',
    ]);
  });

  test('keyword-only statements and an import path', () => {
    const src = [
      'import owner/lib/1 as lib',
      'f(x) =>',
      '    while x',
      '        break',
      '    return',
      '',
    ].join('\n');
    expect(endsOf(src, NodeKind.ImportStmt)).toEqual(['1:1-1:26']);
    expect(endsOf(src, NodeKind.BasicLit)).toEqual(['1:8-1:19']);
    expect(endsOf(src, NodeKind.BreakStmt)).toEqual(['4:9-4:14']);
    expect(endsOf(src, NodeKind.ReturnStmt)).toEqual(['5:5-5:11']);
  });
});

describe('calls end after their closing paren', () => {
  test('on one line, nested', () => {
    expect(
      endsOf('plot(ta.ema(close, 9), "ema")\n', NodeKind.CallExpr),
    ).toEqual(['1:1-1:30', '1:6-1:22']);
  });

  test('spanning lines', () => {
    const src = ['x = ta.ema(', '    close,', '    9', ')', 'y = 1', ''].join(
      '\n',
    );
    expect(endsOf(src, NodeKind.CallExpr)).toEqual(['1:5-4:2']);
    expect(endsOf(src, NodeKind.DeclStmt)).toEqual(['1:1-4:2', '5:1-5:6']);
  });

  test('a missing paren is recorded where the parser expected it', () => {
    // Line breaks are insignificant inside the open group, so the parser
    // reaches end of input still expecting the ')'.
    const {file, errors} = parseText('plot(close\n');
    expect(errors.length).toBeGreaterThan(0);
    const call = nodesOf(file).find(
      (node): node is CallExpr => node.kind === NodeKind.CallExpr,
    );
    expect(call && at(call.rparen)).toBe(at(file.eof));
  });
});

describe('blocks end at their dedent', () => {
  const nested = [
    'f(x) =>', // 1
    '    if x > 0', // 2
    '        y = 1', // 3
    '        y', // 4
    '', // 5
    '    x', // 6
    '', // 7
    '// trailing comment', // 8
    'z = f(close)', // 9
    '',
  ].join('\n');

  test('nested blocks cover the blank lines after their last statement', () => {
    expect(endsOf(nested, NodeKind.Block)).toEqual(['2:5-9:1', '3:9-6:1']);
    expect(endsOf(nested, NodeKind.IfExpr)).toEqual(['2:5-6:1']);
    expect(endsOf(nested, NodeKind.FuncDecl)).toEqual(['1:1-9:1']);
  });

  test('blocks that close together share one end', () => {
    const src = ['if a', '    if b', '        c', 'd', ''].join('\n');
    expect(endsOf(src, NodeKind.Block)).toEqual(['2:5-4:1', '3:9-4:1']);
  });

  test('a block at end of file ends at eof', () => {
    expect(endsOf('if a\n    b\n\n', NodeKind.Block)).toEqual(['2:5-4:1']);
    expect(endsOf('if a\n    b\n\n', NodeKind.File)).toEqual(['1:1-4:1']);
  });

  test('without a final newline the block still covers its last statement', () => {
    const {file} = parseText('if a\n    bb');
    const block = nodesOf(file).find(
      (node): node is Block => node.kind === NodeKind.Block,
    );
    // The scanner puts this Dedent at column 1 of the last line.
    expect(block && at(block.dedent)).toBe('2:1');
    expect(block && at(endPos(block))).toBe('2:7');
  });
});

describe('endPos is total', () => {
  test('bad nodes end at their own position', () => {
    const {file, errors} = parseText('x = \n1 = 2\n');
    expect(errors.length).toBeGreaterThan(0);
    const bad = nodesOf(file).filter(
      node => node.kind === NodeKind.BadExpr || node.kind === NodeKind.BadStmt,
    );
    expect(bad.map(node => node.kind).sort()).toEqual([
      NodeKind.BadExpr,
      NodeKind.BadStmt,
    ]);
    for (const node of bad) {
      expect(endPos(node)).toEqual(node.pos);
    }
  });

  test('malformed source: every node ends at or after its start', () => {
    const src = readFileSync(join(FIXTURES, 'errors.tea'), 'utf8');
    const {file, errors} = parseText(src);
    expect(errors.length).toBeGreaterThan(0);
    for (const node of nodesOf(file)) {
      expect(
        before(endPos(node), node.pos),
        `${node.kind}@${at(node.pos)}`,
      ).toBe(false);
    }
  });

  test('corpus: every node contains its children', () => {
    const corpus = join(FIXTURES, 'corpus');
    const seen = new Set<string>();
    for (const name of readdirSync(corpus).filter(n => n.endsWith('.tea'))) {
      const {file} = parseText(readFileSync(join(corpus, name), 'utf8'), name);
      for (const node of nodesOf(file)) {
        seen.add(node.kind);
        const end = endPos(node);
        const where = `${name} ${node.kind}@${at(node.pos)}`;
        expect(before(end, node.pos), where).toBe(false);
        for (const child of childrenOf(node)) {
          expect(before(end, endPos(child)), where).toBe(false);
        }
      }
    }
    // The corpus exercises nearly the whole grammar; keep that true.
    expect(seen.size).toBeGreaterThan(30);
  });
});
