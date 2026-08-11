// Purpose: Loader tests — source-package parsing, recursive import prewarming, cache identity, cycle detection, and staged resolution errors.

import {describe, expect, test} from 'bun:test';
import {
  isImportError,
  type ImportOutcome,
  type SourcePackage,
} from '../checker/importer';
import {parseText} from '../syntax/testing';
import {resolveImports, type PackageSource, type Registry} from './loader';

// A registry over in-memory sources; '/' paths are external, like the
// default registry.
function fakeRegistry(
  sources: Record<string, string>,
  loaded: string[] = [],
): Registry {
  return (path: string): PackageSource | 'external' | null => {
    loaded.push(path);
    if (path.includes('/')) {
      return 'external';
    }
    const source = sources[path];
    return source === undefined ? null : {filename: `fake/${path}.tea`, source};
  };
}

function sourcePackage(outcome: ImportOutcome): SourcePackage {
  if (isImportError(outcome)) {
    throw new Error(outcome.error);
  }
  return outcome;
}

function importError(outcome: ImportOutcome): string {
  if (!isImportError(outcome)) {
    throw new Error(`expected import error for '${outcome.path}'`);
  }
  return outcome.error;
}

const PACKAGE_B = `library("b")
export fb(x) => x * 2
`;

const PACKAGE_A = `library("a")
import b
export fa(x) => b.fb(x) + 1
`;

describe('import resolution', () => {
  test('prewarms raw transitive imports and memoizes source packages', () => {
    const loaded: string[] = [];
    const {file} = parseText('import a');
    const importer = resolveImports(
      [file],
      fakeRegistry({a: PACKAGE_A, b: PACKAGE_B}, loaded),
      [],
    );

    expect(loaded).toEqual(['a', 'b']);
    const a = sourcePackage(importer.import('a'));
    const b = sourcePackage(importer.import('b'));
    expect(importer.import('a')).toBe(a);
    expect(importer.import('b')).toBe(b);
    expect(loaded).toEqual(['a', 'b']);
    expect(a.path).toBe('a');
    expect(a.files[0].pos.base.filename).toBe('fake/a.tea');
    expect(Object.keys(a).sort()).toEqual(['files', 'path']);
  });

  test('scans aliased import syntax without interpreting the alias', () => {
    const loaded: string[] = [];
    const source = `anything = close
import b as base
result = base.fb(anything)
`;
    const {file} = parseText('import a');
    const importer = resolveImports(
      [file],
      fakeRegistry({a: source, b: PACKAGE_B}, loaded),
      [],
    );

    expect(sourcePackage(importer.import('a')).path).toBe('a');
    expect(sourcePackage(importer.import('b')).path).toBe('b');
    expect(loaded).toEqual(['a', 'b']);
  });

  test('an import cycle reports the chain', () => {
    const {file} = parseText('import a');
    const importer = resolveImports(
      [file],
      fakeRegistry({a: 'import b', b: 'import a'}),
      [],
    );

    expect(importError(importer.import('a'))).toContain(
      'import cycle: a -> b -> a',
    );
  });

  test('unknown and external paths stay staged errors', () => {
    const unknown = resolveImports(
      [parseText('import zzz').file],
      fakeRegistry({}),
      [],
    );
    expect(importError(unknown.import('zzz'))).toBe("unknown library 'zzz'");

    const external = resolveImports(
      [parseText('import someone/lib/1').file],
      fakeRegistry({}),
      [],
    );
    expect(importError(external.import('someone/lib/1'))).toBe(
      "external libraries are not supported yet ('someone/lib/1')",
    );
  });

  test('leaves headers and top-level forms for semantic validation', () => {
    const semanticInvalid = `value = close
duplicate(x) => x
duplicate(x) => x + 1
`;
    const {file} = parseText('import raw');
    const importer = resolveImports(
      [file],
      fakeRegistry({raw: semanticInvalid}),
      [],
    );

    const raw = sourcePackage(importer.import('raw'));
    expect(raw.path).toBe('raw');
    expect(raw.files[0].stmtList).toHaveLength(3);
  });

  test('reports syntax failures without publishing a source package', () => {
    const {file} = parseText('import broken');
    const importer = resolveImports(
      [file],
      fakeRegistry({broken: 'export broken('}),
      [],
    );

    expect(importError(importer.import('broken'))).toContain(
      "library 'broken' failed to parse",
    );
  });
});
