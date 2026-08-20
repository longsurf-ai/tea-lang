// Purpose: Checker/IR boundary tests lock dependency direction and the single exhaustive call-resolution fact.

import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import ts from 'typescript';
import {NodeKind, type CallExpr} from '../syntax/nodes';
import {CallKind, type CallResolution} from './info';
import {checkText} from './testing';

function productionSources(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSources(path));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

function importsOf(path: string): readonly string[] {
  return ts
    .preProcessFile(readFileSync(path, 'utf8'), true, true)
    .importedFiles.map(file => file.fileName);
}

function modulePath(source: string, specifier: string): string {
  return resolve(dirname(source), specifier).replace(/\.[cm]?[jt]s$/, '');
}

function callsOf(root: unknown): CallExpr[] {
  const calls: CallExpr[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
      return;
    }
    seen.add(value);
    if ('kind' in value && value.kind === NodeKind.CallExpr) {
      calls.push(value as CallExpr);
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(root);
  return calls;
}

function resolutionKind(resolution: CallResolution): string {
  switch (resolution.kind) {
    case CallKind.Native:
      return CallKind.Native;
    case CallKind.Function:
      return CallKind.Function;
    case CallKind.Constructor:
      return CallKind.Constructor;
    case CallKind.Request:
      return CallKind.Request;
  }
  const exhaustive: never = resolution;
  return exhaustive;
}

describe('checker and IR boundaries', () => {
  test('checker may use shared type/builtin contracts, never backend nodes', () => {
    const checker = fileURLToPath(new URL('.', import.meta.url));
    const ir = resolve(checker, '../ir');
    const forbiddenCheckerTargets = new Set([
      resolve(ir, 'node'),
      resolve(ir, 'program'),
    ]);
    const checkerViolations = productionSources(checker).flatMap(source =>
      importsOf(source)
        .filter(specifier => specifier.startsWith('.'))
        .map(specifier => modulePath(source, specifier))
        .filter(target => forbiddenCheckerTargets.has(target))
        .map(
          target =>
            `${relative(checker, source)} -> ${relative(checker, target)}`,
        ),
    );
    expect(checkerViolations).toEqual([]);

    const irViolations = productionSources(ir).flatMap(source =>
      importsOf(source)
        .filter(specifier => specifier.startsWith('.'))
        .map(specifier => modulePath(source, specifier))
        .filter(target => {
          const path = relative(checker, target);
          return path !== '' && !path.startsWith('..');
        })
        .map(target => `${relative(ir, source)} -> ${relative(ir, target)}`),
    );
    expect(irViolations).toEqual([]);
  });

  test('every call occurrence owns one exhaustive CallResolution', () => {
    const result = checkText(
      [
        'type Box',
        '    int value',
        'identity(int value) => value',
        'box = Box.new(1)',
        'values = array.from(box.value)',
        'value = identity(values.get(0))',
        'requested = request.security("X", "D", close)',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);

    const calls = callsOf(result.file);
    expect(calls).toHaveLength(5);
    expect(result.info.calls.size).toBe(calls.length);
    const kinds = calls.map(call => {
      const resolution = result.info.calls.get(call);
      if (resolution === undefined) {
        throw new Error('checked call occurrence has no CallResolution');
      }
      return resolutionKind(resolution);
    });
    expect(kinds.sort()).toEqual([
      CallKind.Constructor,
      CallKind.Function,
      CallKind.Native,
      CallKind.Native,
      CallKind.Request,
    ]);
  });
});
