// Purpose: Package-runtime-global checker contract: V1 admits only private, explicitly typed library vars and enforces package-owned mutation.

import {describe, expect, test} from 'vitest';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {parseText} from '../syntax/testing';
import {checkText, type CheckResult} from './testing';

function memoryRegistry(sources: Readonly<Record<string, string>>): Registry {
  return (path: string): PackageSource | null => {
    const source = sources[path];
    return source === undefined
      ? null
      : {filename: `memory/${path}.tea`, source};
  };
}

function checkWith(
  sources: Readonly<Record<string, string>>,
  source: string,
): CheckResult {
  const parsed = parseText(source, 'main.tea');
  expect(parsed.errors).toEqual([]);
  return checkText(
    source,
    'main.tea',
    resolveImports([parsed.file], memoryRegistry(sources), []),
  );
}

function messages(result: CheckResult): string[] {
  return result.errors.map(error => error.msg);
}

describe('library package runtime globals', () => {
  test('admits a private explicitly typed var and lets owning functions read and write it', () => {
    const result = checkWith(
      {
        counter: [
          'library("counter")',
          'var int value = 1',
          'export next() =>',
          '    value := value + 1',
          '    value',
          'export current() => value',
        ].join('\n'),
      },
      ['import counter', 'a = counter.next()', 'b = counter.current()'].join(
        '\n',
      ),
    );
    expect(result.errors).toEqual([]);
    const counter = result.checked.pkg.imports[0];
    expect(counter.scope.lookup('value')).not.toBeNull();
    expect(counter.exports.has('value')).toBe(false);
    expect(result.checked.packageContexts.get(counter)?.initOrder).toHaveLength(
      1,
    );
  });

  test('rejects every other mutable library-root declaration shape', () => {
    const fixtures = [
      ['plain', 'int value = 1'],
      ['varip', 'varip int value = 1'],
      ['untyped', 'var value = 1'],
      ['tuple', '[a, b] = [1, 2]'],
    ] as const;
    for (const [name, declaration] of fixtures) {
      const result = checkWith(
        {bad: ['library("bad")', declaration, 'export read() => 1'].join('\n')},
        'import bad\nvalue = bad.read()',
      );
      expect(messages(result), name).toContain(
        'library package runtime globals must be private single-name explicitly typed var declarations',
      );
    }
  });

  test('keeps mutable globals out of the public package namespace', () => {
    const result = checkWith(
      {
        counter:
          'library("counter")\nvar int value = 1\nexport read() => value',
      },
      ['import counter', 'value = counter.value'].join('\n'),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('rejects entry-package writes to imported package state', () => {
    const result = checkWith(
      {
        state: [
          'library("state")',
          'export type Box',
          '    int value',
          'var Box box = Box.new(1)',
          'export read() => box.value',
        ].join('\n'),
      },
      ['import state', 'state.box.value := 2'].join('\n'),
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(
      messages(result).some(message => message.includes('state.box')),
    ).toBe(true);
    expect(result.checked.pkg.imports[0].exports.has('box')).toBe(false);
  });

  test('rejects a foreign write reached through a function argument', () => {
    const result = checkWith(
      {
        owner: [
          'library("owner")',
          'var int value = 1',
          'export read() => value',
        ].join('\n'),
        foreign: [
          'library("foreign")',
          'import owner',
          'export change() =>',
          '    owner.value := 2',
          '    owner.read()',
        ].join('\n'),
      },
      'import foreign\nvalue = foreign.change()',
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('canonicalizes one global identity through aliases and a diamond import', () => {
    const result = checkWith(
      {
        core: [
          'library("core")',
          'var int value = 0',
          'export next() =>',
          '    value += 1',
          '    value',
        ].join('\n'),
        left: 'library("left")\nimport core\nexport next() => core.next()',
        right:
          'library("right")\nimport core as shared\nexport next() => shared.next()',
      },
      [
        'import core as first',
        'import core as second',
        'import left',
        'import right',
        'a = first.next()',
        'b = second.next()',
        'c = left.next()',
        'd = right.next()',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    const first = result.checked.pkg.imports.find(pkg => pkg.path === 'core');
    const left = result.checked.pkg.imports.find(pkg => pkg.path === 'left');
    const right = result.checked.pkg.imports.find(pkg => pkg.path === 'right');
    expect(left?.imports[0]).toBe(first);
    expect(right?.imports[0]).toBe(first);
  });

  test('preserves source order for otherwise independent initializers', () => {
    const result = checkWith(
      {
        values: [
          'library("values")',
          'var int first = 4',
          'var int second = first + 1',
          'export read() => second',
        ].join('\n'),
      },
      'import values\nvalue = values.read()',
    );
    expect(result.errors).toEqual([]);
  });

  test('orders forward and transitive dependencies before dependents', () => {
    const result = checkWith(
      {
        values: [
          'library("values")',
          'var int later = readEarlier() + 1',
          'var int earlier = 4',
          'readEarlier() => earlier',
          'export read() => later',
        ].join('\n'),
      },
      'import values\nvalue = values.read()',
    );
    expect(result.errors).toEqual([]);
    const values = result.checked.pkg.imports[0];
    expect(
      result.checked.packageContexts
        .get(values)
        ?.initOrder.map(global => global.name),
    ).toEqual(['earlier', 'later']);
  });

  test('diagnoses initializer dependency cycles', () => {
    const result = checkWith(
      {
        values: [
          'library("values")',
          'var int a = readB()',
          'var int b = a + 1',
          'readB() => b',
          'export read() => a',
        ].join('\n'),
      },
      'import values\nvalue = values.read()',
    );
    expect(messages(result)).toContain(
      'package global initializer cycle: a -> b -> a',
    );
  });

  test('rejects runtime inputs, requests, and state mutation in initializers', () => {
    const runtimeInput = checkWith(
      {
        bad: [
          'library("bad")',
          'var float value = close',
          'export read() => value',
        ].join('\n'),
      },
      'import bad\nvalue = bad.read()',
    );
    expect(
      messages(runtimeInput).some(message =>
        message.includes('runtime builtin'),
      ),
    ).toBe(true);

    const request = checkWith(
      {
        bad: [
          'library("bad")',
          'var float value = request.security("X", "1D", 1.0)',
          'export read() => value',
        ].join('\n'),
      },
      'import bad\nvalue = bad.read()',
    );
    expect(
      messages(request).some(message => message.includes('requests')),
    ).toBe(true);

    const mutation = checkWith(
      {
        bad: [
          'library("bad")',
          'var int base = 0',
          'mutate() =>',
          '    base += 1',
          '    base',
          'var int value = mutate()',
          'export read() => value',
        ].join('\n'),
      },
      'import bad\nvalue = bad.read()',
    );
    expect(
      messages(mutation).some(message => message.includes('state-mutating')),
    ).toBe(true);

    const output = checkWith(
      {
        bad: [
          'library("bad")',
          'var int value = plotshape(true)',
          'export read() => 1',
        ].join('\n'),
      },
      'import bad\nvalue = bad.read()',
    );
    expect(
      messages(output).some(
        message =>
          message.includes("cannot call 'plotshape'") &&
          message.includes('output'),
      ),
    ).toBe(true);

    const directWrite = checkWith(
      {
        bad: [
          'library("bad")',
          'var int other = 0',
          'var int value = if true',
          '    other := 1',
          '    other',
          'export read() => value',
        ].join('\n'),
      },
      'import bad\nvalue = bad.read()',
    );
    expect(
      messages(directWrite).some(message =>
        message.includes('cannot mutate state'),
      ),
    ).toBe(true);

    const persistentLocal = checkWith(
      {
        bad: [
          'library("bad")',
          'seed() =>',
          '    var int value = 1',
          '    value',
          'var int value = seed()',
          'export read() => value',
        ].join('\n'),
      },
      'import bad\nvalue = bad.read()',
    );
    expect(
      messages(persistentLocal).some(message =>
        message.includes('persistent local state'),
      ),
    ).toBe(true);

    const mutableMethod = checkWith(
      {
        bad: [
          'library("bad")',
          'type Box',
          '    int value',
          '    int bump() =>',
          '        this.value := this.value + 1',
          '        this.value',
          'var Box box = Box.new(0)',
          'var int value = box.bump()',
          'export read() => value',
        ].join('\n'),
      },
      'import bad\nvalue = bad.read()',
    );
    expect(
      messages(mutableMethod).some(message =>
        message.includes('mutable method'),
      ),
    ).toBe(true);
  });

  test('checks only constructor field defaults omitted by a global initializer', () => {
    const omitted = checkWith(
      {
        bad: [
          'library("bad")',
          'noisy() =>',
          '    effect.emit(1)',
          '    7',
          'type Box',
          '    int value = noisy()',
          'var Box state = Box.new()',
          'export read() => state.value',
        ].join('\n'),
      },
      'import bad\nvalue = bad.read()',
    );
    expect(
      messages(omitted).some(
        message =>
          message.includes("cannot call 'effect.emit'") &&
          message.includes('emit'),
      ),
    ).toBe(true);

    const supplied = checkWith(
      {
        valid: [
          'library("valid")',
          'noisy() =>',
          '    effect.emit(1)',
          '    7',
          'type Box',
          '    int value = noisy()',
          'var Box state = Box.new(1)',
          'export read() => state.value',
        ].join('\n'),
      },
      'import valid\nvalue = valid.read()',
    );
    expect(supplied.errors).toEqual([]);
  });
});
