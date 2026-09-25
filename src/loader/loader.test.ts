// Purpose: Loader tests — source-package parsing, recursive import prewarming, cache identity, cycle detection, and staged resolution errors.

import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
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
  test('separates compiler-shipped libraries from the implicit prelude', () => {
    const plain = resolveImports([parseText('value = 1').file]);
    expect(plain.implicit().map(pkg => pkg.path)).toEqual(['ta']);
    expect(plain.prelude().map(pkg => pkg.path)).toEqual(['visual', 'pine']);

    const explicit = resolveImports([
      parseText(
        [
          'strategy("components")',
          'import broker',
          'import portfolio',
          'import trade',
        ].join('\n'),
      ).file,
    ]);
    expect(explicit.implicit().map(pkg => pkg.path)).toEqual(['ta']);
    expect(explicit.prelude().map(pkg => pkg.path)).toEqual(['visual', 'pine']);
    expect(sourcePackage(explicit.import('broker', 'entry.tea')).path).toBe(
      'broker',
    );
    expect(sourcePackage(explicit.import('portfolio', 'entry.tea')).path).toBe(
      'portfolio',
    );
    expect(sourcePackage(explicit.import('trade', 'entry.tea')).path).toBe(
      'trade',
    );
  });

  test('prewarms raw transitive imports and memoizes source packages', () => {
    const loaded: string[] = [];
    const {file} = parseText('import a');
    const importer = resolveImports(
      [file],
      fakeRegistry({a: PACKAGE_A, b: PACKAGE_B}, loaded),
      [],
    );

    expect(loaded).toEqual(['a', 'b']);
    const a = sourcePackage(importer.import('a', 'entry.tea'));
    const b = sourcePackage(importer.import('b', 'entry.tea'));
    expect(importer.import('a', 'entry.tea')).toBe(a);
    expect(importer.import('b', 'entry.tea')).toBe(b);
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

    expect(sourcePackage(importer.import('a', 'entry.tea')).path).toBe('a');
    expect(sourcePackage(importer.import('b', 'entry.tea')).path).toBe('b');
    expect(loaded).toEqual(['a', 'b']);
  });

  test('an import cycle reports the chain', () => {
    const {file} = parseText('import a');
    const importer = resolveImports(
      [file],
      fakeRegistry({a: 'import b', b: 'import a'}),
      [],
    );

    expect(importError(importer.import('a', 'entry.tea'))).toContain(
      'import cycle: a -> b -> a',
    );
  });

  test('unknown and external paths stay staged errors', () => {
    const unknown = resolveImports(
      [parseText('import zzz').file],
      fakeRegistry({}),
      [],
    );
    expect(importError(unknown.import('zzz', 'entry.tea'))).toBe(
      "unknown library 'zzz'",
    );

    const external = resolveImports(
      [parseText('import someone/lib/1').file],
      fakeRegistry({}),
      [],
    );
    expect(importError(external.import('someone/lib/1', 'entry.tea'))).toBe(
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

    const raw = sourcePackage(importer.import('raw', 'entry.tea'));
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

    expect(importError(importer.import('broken', 'entry.tea'))).toContain(
      "library 'broken' failed to parse",
    );
  });
});

describe('relative imports', () => {
  const IMPORTS = join(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../tests/fixtures/imports',
  );
  const entry = join(IMPORTS, 'strategies/entry.tea');
  const bands = join(IMPORTS, 'strategies/lib/bands.tea');
  const risk = join(IMPORTS, 'shared/risk.tea');
  const importer = () => resolveImports([parseText('value = 1').file]);

  test('resolve against the importing file, and the canonical path is the identity', () => {
    const resolver = importer();
    expect(sourcePackage(resolver.import('./lib/bands', entry)).path).toBe(
      bands,
    );
    // The entry script and bands.tea spell the same file differently.
    const fromEntry = sourcePackage(resolver.import('../shared/risk', entry));
    const fromBands = sourcePackage(
      resolver.import('../../shared/risk', bands),
    );
    expect(fromEntry.path).toBe(risk);
    expect(fromBands).toBe(fromEntry);
    expect(fromEntry.files[0].pos.base.filename).toBe(risk);
  });

  test('a cycle across files names the chain by canonical path', () => {
    const a = join(IMPORTS, 'cycle/a.tea');
    const b = join(IMPORTS, 'cycle/b.tea');
    expect(
      importError(importer().import('./a', join(IMPORTS, 'cycle/entry.tea'))),
    ).toBe(
      `in library '${a}': in library '${b}': import cycle: ${a} -> ${b} -> ${a}`,
    );
  });

  test('a missing file and a malformed path are ordinary import errors', () => {
    const from = join(IMPORTS, 'missing/entry.tea');
    expect(importError(importer().import('./nope', from))).toBe(
      `cannot find './nope' (no file ${join(IMPORTS, 'missing/nope.tea')})`,
    );
    for (const path of [
      './',
      './lib/',
      './a//b',
      './a.b',
      '../..',
      './a/../b',
    ]) {
      expect(importError(importer().import(path, from))).toBe(
        `malformed import path '${path}'`,
      );
    }
  });

  test('never consult the registry, so a user file cannot shadow a library', () => {
    const asked: string[] = [];
    const resolver = resolveImports(
      [parseText('value = 1').file],
      fakeRegistry({}, asked),
      [],
    );
    sourcePackage(resolver.import('./lib/bands', entry));
    expect(asked.filter(path => path.includes('bands'))).toEqual([]);
  });
});
