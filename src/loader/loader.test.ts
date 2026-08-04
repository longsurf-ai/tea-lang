// Purpose: Loader tests — import resolution through injected registries: library chains, cycle detection, and staging errors, observed end-to-end through the checker.

import {describe, expect, test} from 'bun:test';
import {checkText} from '../checker/testing';
import {resolveImports, type LibrarySource, type Registry} from './loader';
import {parseText} from '../syntax/testing';

// A registry over in-memory sources; '/' paths are external, like the
// default registry.
function fakeRegistry(sources: Record<string, string>): Registry {
  return (path: string): LibrarySource | 'external' | null => {
    if (path.includes('/')) {
      return 'external';
    }
    const source = sources[path];
    return source === undefined ? null : {filename: `fake/${path}.tea`, source};
  };
}

// checkText with an importer built over a fake registry and no implicit
// libraries.
function checkWith(sources: Record<string, string>, src: string) {
  const {file} = parseText(src);
  const importer = resolveImports([file], fakeRegistry(sources), []);
  return checkText(src, 'test.tea', importer);
}

const LIB_B = `library("b")
export fb(x) =>
\tx * 2
`;

const LIB_A = `library("a")
import b

export fa(x) =>
\tb.fb(x) + 1
`;

describe('import resolution', () => {
  test('a library imports a library through the chain', () => {
    const r = checkWith(
      {a: LIB_A, b: LIB_B},
      'import a\ny = a.fa(close)\nplot(y)',
    );
    expect(r.errors).toEqual([]);
  });

  test('library aliases rebind inside the importing library', () => {
    const lib = `library("c")
import b as base

export fc(x) =>
\tbase.fb(x)
`;
    const r = checkWith(
      {c: lib, b: LIB_B},
      'import c\ny = c.fc(close)\nplot(y)',
    );
    expect(r.errors).toEqual([]);
  });

  test('an import cycle reports the chain', () => {
    const first = `library("a")
import b
export fa(x) =>
\tx
`;
    const second = `library("b")
import a
export fb(x) =>
\tx
`;
    const r = checkWith({a: first, b: second}, 'import a\nplot(close)');
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].msg).toContain('import cycle: a -> b -> a');
  });

  test('unknown and external paths stay staged errors', () => {
    const r = checkWith({}, 'import zzz\nplot(close)');
    expect(r.errors[0].msg).toBe("unknown library 'zzz'");
    const r2 = checkWith({}, 'import someone/lib/1\nplot(close)');
    expect(r2.errors[0].msg).toBe(
      "external libraries are not supported yet ('someone/lib/1')",
    );
  });

  test('a non-implicit library binds under its declared name', () => {
    const r = checkWith(
      {a: LIB_A, b: LIB_B},
      'import a\nimport b\ny = a.fa(close) + b.fb(close)\nplot(y)',
    );
    expect(r.errors).toEqual([]);
  });

  test('using an unimported library is an ordinary unknown function', () => {
    const r = checkWith({a: LIB_A, b: LIB_B}, 'y = a.fa(close)\nplot(y)');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].msg).toBe("unknown function 'a.fa'");
  });
});
