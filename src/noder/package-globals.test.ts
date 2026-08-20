// Purpose: Imported runtime globals project through ordinary Names and function IR, with canonical identity across aliases and fresh child-Program projections.

import {describe, expect, test} from 'vitest';
import {Errors, fatal} from '../base/print';
import {newFileBase} from '../base/pos';
import {checkPackage} from '../checker/check';
import {IrKind} from '../ir/node';
import {funcsOf, namesOf} from '../ir/visit';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {parse} from '../syntax/syntax';
import {buildProgram} from './noder';

function buildWith(
  source: string,
  libraries: Readonly<Record<string, string>>,
) {
  const errors = new Errors();
  const file = parse(newFileBase('main.tea'), source, (pos, message) =>
    errors.errorAt(pos, message),
  );
  const registry: Registry = (path: string): PackageSource | null => {
    const library = libraries[path];
    return library === undefined
      ? null
      : {filename: `memory/${path}.tea`, source: library};
  };
  const checked = checkPackage(
    [file],
    errors,
    resolveImports([file], registry, []),
  );
  if (errors.count !== 0) {
    return fatal(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  return buildProgram(checked, errors);
}

const COUNTER = [
  'library("counter")',
  'var int value = 1',
  'export next() =>',
  '    value := value + 1',
  '    value',
].join('\n');

describe('package runtime global projection', () => {
  test('an imported function reads and writes one Program-owned var Name', () => {
    const program = buildWith('import counter\nresult = counter.next()', {
      counter: COUNTER,
    });
    const global = namesOf(program).find(name => name.name === 'value');
    expect(global).toBeDefined();
    expect(program.body[0]).toMatchObject({
      kind: IrKind.InitName,
      name: global,
    });
    const next = funcsOf(program).find(func => func.name.endsWith('next'));
    expect(next).toBeDefined();
    expect(next?.locals).not.toContain(global);
    expect(next?.body.kind).toBe(IrKind.BlockExpr);
  });

  test('two aliases share one canonical Name projection', () => {
    const program = buildWith(
      [
        'import counter as first',
        'import counter as second',
        'a = first.next()',
        'b = second.next()',
      ].join('\n'),
      {counter: COUNTER},
    );
    expect(namesOf(program).filter(name => name.name === 'value')).toHaveLength(
      1,
    );
  });

  test('request children own a distinct Name projection', () => {
    const program = buildWith(
      [
        'import counter',
        'outside = counter.next()',
        'inside = request.security("X", "1D", counter.next())',
      ].join('\n'),
      {counter: COUNTER},
    );
    const rootGlobal = namesOf(program).find(name => name.name === 'value');
    const childGlobal = namesOf(program.requests[0].child).find(
      name => name.name === 'value',
    );
    expect(rootGlobal).toBeDefined();
    expect(childGlobal).toBeDefined();
    expect(childGlobal).not.toBe(rootGlobal);

    expect(funcsOf(program.requests[0].child)).toHaveLength(1);
  });

  test('orders imported-package globals before importer globals', () => {
    const program = buildWith('import outer\nvalue = outer.read()', {
      inner: [
        'library("inner")',
        'var int base = 2',
        'export read() => base',
      ].join('\n'),
      bridge: [
        'library("bridge")',
        'import inner',
        'export read() => inner.read()',
      ].join('\n'),
      outer: [
        'library("outer")',
        'import bridge',
        'var int derived = bridge.read() + 1',
        'export read() => derived',
      ].join('\n'),
    });
    expect(program.packageGlobals.map(global => global.name)).toEqual([
      'base',
      'derived',
    ]);
  });

  test('does not project state for import-only, type-only, or unused globals', () => {
    const library = [
      'library("state")',
      'export type Box',
      '    int value',
      'var int used = 1',
      'var int unused = 2',
      'export read() => used',
    ].join('\n');
    expect(
      buildWith('import state\nplot(1)', {state: library}).packageGlobals,
    ).toEqual([]);
    expect(
      buildWith('import state\nbox = state.Box.new(1)', {state: library})
        .packageGlobals,
    ).toEqual([]);
    expect(
      buildWith('import state\nvalue = state.read()', {
        state: library,
      }).packageGlobals.map(global => global.name),
    ).toEqual(['used']);
  });
});
