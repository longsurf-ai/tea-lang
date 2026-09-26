// Purpose: Red/regression tests for checking source libraries as complete
// semantic packages rather than loader-shaped function namespaces.

import {describe, expect, test} from 'vitest';
import {Qualifier, typesEqual} from '../ir/type';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {parseText} from '../syntax/testing';
import {ObjectKind} from './object';
import {checkText, declaredName, type CheckResult} from './testing';

// Keep these fixtures at the source Registry boundary. They deliberately do
// not construct semantic export maps, so the tests exercise the SourcePackage
// seam instead of bypassing checker elaboration.
function memoryRegistry(sources: Readonly<Record<string, string>>): Registry {
  return (path: string): PackageSource | 'external' | null => {
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
  const importer = resolveImports([parsed.file], memoryRegistry(sources), []);
  return checkText(source, 'main.tea', importer);
}

function messages(result: CheckResult): string[] {
  return result.errors.map(error => error.msg);
}

function hasMessage(result: CheckResult, ...parts: string[]): boolean {
  return messages(result).some(message =>
    parts.every(part => message.includes(part)),
  );
}

function packageBinding(result: CheckResult, name: string) {
  const object = result.checked.pkg.scope.lookup(name);
  expect(object?.kind).toBe(ObjectKind.PackageName);
  return object?.kind === ObjectKind.PackageName ? object.pkg : undefined;
}

describe('source library headers and package declarations', () => {
  test('requires one leading library() header', () => {
    const valid = checkWith(
      {lib: 'library("lib")\nexport value() => 1\n'},
      'import lib\nvalue = lib.value()',
    );
    expect(valid.errors).toEqual([]);

    const missing = checkWith(
      {lib: 'export value() => 1\n'},
      'import lib\nvalue = 1',
    );
    expect(hasMessage(missing, 'no library() declaration')).toBe(true);

    const late = checkWith(
      {lib: 'export value() => 1\nlibrary("lib")\n'},
      'import lib\nvalue = 1',
    );
    expect(hasMessage(late, 'library() declaration', 'first')).toBe(true);

    const duplicate = checkWith(
      {lib: 'library("lib")\nlibrary("other")\nexport value() => 1\n'},
      'import lib\nvalue = 1',
    );
    expect(hasMessage(duplicate, 'duplicate', 'library() declaration')).toBe(
      true,
    );

    const invalidName = checkWith(
      {lib: 'library("not-addressable")\nexport value() => 1\n'},
      'import lib\nvalue = 1',
    );
    expect(hasMessage(invalidName, 'not a valid source identifier')).toBe(true);
  });

  test('rejects duplicate functions, import aliases, and cross-kind names', () => {
    const duplicateFunctions = checkWith(
      {
        lib: [
          'library("lib")',
          'export value() => 1',
          'export value() => 2',
        ].join('\n'),
      },
      'import lib\nvalue = lib.value()',
    );
    expect(hasMessage(duplicateFunctions, "'value' is already declared")).toBe(
      true,
    );

    const duplicateAliases = checkWith(
      {
        left: 'library("left")\nexport value() => 1\n',
        right: 'library("right")\nexport value() => 2\n',
        lib: [
          'library("lib")',
          'import left as dep',
          'import right as dep',
          'export value() => dep.value()',
        ].join('\n'),
      },
      'import lib\nvalue = lib.value()',
    );
    expect(hasMessage(duplicateAliases, "'dep' is already declared")).toBe(
      true,
    );

    const crossKind = checkWith(
      {
        lib: [
          'library("lib")',
          'export type Item',
          '    int value',
          'export Item() => 1',
        ].join('\n'),
      },
      'import lib\nvalue = 1',
    );
    expect(hasMessage(crossKind, "'Item' is already declared")).toBe(true);
  });

  test('predeclares functions for earlier package-owned defaults', () => {
    const result = checkWith(
      {
        lib: [
          'library("lib")',
          'export type Item',
          '    int value = initial()',
          'initial() => 7',
        ].join('\n'),
      },
      'import lib\nitem = lib.Item.new()\nvalue = item.value',
    );
    expect(result.errors).toEqual([]);
  });

  test('rejects a default package name that shadows a native namespace', () => {
    const result = checkWith(
      {dependency: 'library("math")\nexport answer() => 1\n'},
      'import dependency\nvalue = math.answer()',
    );
    expect(hasMessage(result, "cannot redeclare built-in 'math'")).toBe(true);
  });

  test('checks invalid unused type defaults and method bodies', () => {
    const result = checkWith(
      {
        broken: [
          'library("broken")',
          'export type Broken',
          '    int value = "not an int"',
          '    string wrong() const => 1',
        ].join('\n'),
      },
      // Nothing constructs Broken or calls wrong: declaration checking itself
      // must own both diagnostics.
      'import broken\nvalue = 1',
    );
    expect(hasMessage(result, 'string', 'int', "field 'value'")).toBe(true);
    expect(
      hasMessage(result, "method 'Broken.wrong'", 'returns int', 'want string'),
    ).toBe(true);
    expect(
      result.errors.every(
        error => error.pos.base.filename === 'memory/broken.tea',
      ),
    ).toBe(true);
  });

  test('checks unused function signatures while leaving polymorphic bodies lazy', () => {
    const unknownType = checkWith(
      {
        broken: [
          'library("broken")',
          'export invalid(Missing value) => value',
        ].join('\n'),
      },
      'import broken\nvalue = 1',
    );
    expect(hasMessage(unknownType, "unknown type 'Missing'")).toBe(true);

    const duplicateParam = checkWith(
      {
        broken: 'library("broken")\nexport invalid(value, value) => value\n',
      },
      'import broken\nvalue = 1',
    );
    expect(hasMessage(duplicateParam, "duplicate parameter 'value'")).toBe(
      true,
    );

    const lazyBody = checkWith(
      {
        valid: 'library("valid")\nexport lazy(value) => missing + value\n',
      },
      'import valid\nvalue = 1',
    );
    expect(lazyBody.errors).toEqual([]);
  });
});

describe('source library type API', () => {
  test('keeps unexported functions, types, and enums private', () => {
    const result = checkWith(
      {
        model: [
          'library("model")',
          'type Hidden',
          '    int value',
          'enum Secret',
          '    one',
          'hidden() => 1',
          'export type Public',
          '    int value',
        ].join('\n'),
      },
      [
        'import model as pkg',
        'good = pkg.Public.new(1)',
        'badType = pkg.Hidden.new(1)',
        'badEnum = pkg.Secret.one',
        'badFunction = pkg.hidden()',
      ].join('\n'),
    );
    expect(hasMessage(result, 'pkg.Hidden')).toBe(true);
    expect(hasMessage(result, 'pkg.Secret')).toBe(true);
    expect(hasMessage(result, 'pkg.hidden')).toBe(true);
    expect(
      messages(result).some(message => message.includes('pkg.Public')),
    ).toBe(false);
  });

  test('resolves pkg.Type annotations, constructors, and enum members', () => {
    const result = checkWith(
      {
        model: [
          'library("model")',
          'export type Order',
          '    int quantity = 1',
          'export enum Side',
          '    buy = "Buy"',
          '    sell = "Sell"',
          'export identity(Order order) => order',
        ].join('\n'),
      },
      [
        'import model as pkg',
        'pkg.Order order = pkg.Order.new()',
        'pkg.Side side = pkg.Side.buy',
        'copy = pkg.identity(order)',
        'quantity = copy.quantity',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);

    const model = packageBinding(result, 'pkg');
    const order = model?.scope.lookup('Order');
    const side = model?.scope.lookup('Side');
    const identity = model?.exports.get('identity');
    expect(order?.kind).toBe(ObjectKind.Struct);
    expect(side?.kind).toBe(ObjectKind.Enum);
    expect(identity?.kind).toBe(ObjectKind.Function);
    if (order?.kind === ObjectKind.Struct) {
      expect(declaredName(result, 'order').type).toBe(order.type);
      expect(declaredName(result, 'copy').type).toBe(order.type);
      if (identity?.kind === ObjectKind.Function) {
        expect(identity.declaredParams[0]?.type).toBe(order.type);
      }
    }
    if (side?.kind === ObjectKind.Enum) {
      expect(declaredName(result, 'side').type).toBe(side.type);
    }
  });

  test('imports const and mutable methods with library-owned defaults', () => {
    const result = checkWith(
      {
        counters: [
          'library("counters")',
          'const initial = 7',
          'export struct Counter',
          '    int value = initial',
          '    int read() const => this.value',
          '    int add(int amount = initial) =>',
          '        this.value := this.value + amount',
          '        this.value',
        ].join('\n'),
      },
      [
        'import counters as pkg',
        'counter = pkg.Counter.new()',
        'before = counter.read()',
        'after = counter.add()',
        'current = counter.read()',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(declaredName(result, 'before').type).toBe(
      declaredName(result, 'after').type,
    );
    expect(declaredName(result, 'counter').qualifier).toBe(Qualifier.Series);
  });

  test('reuses one semantic package and nominal type across aliases and transitive imports', () => {
    const result = checkWith(
      {
        core: ['library("core")', 'export type Token', '    int value'].join(
          '\n',
        ),
        bridge: [
          'library("bridge")',
          'import core as dependency',
          'export echo(dependency.Token token) => token',
        ].join('\n'),
      },
      [
        'import core as first',
        'import core as second',
        'import bridge',
        'first.Token a = first.Token.new(1)',
        'second.Token b = a',
        'c = bridge.echo(b)',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);

    const first = packageBinding(result, 'first');
    const second = packageBinding(result, 'second');
    const bridge = packageBinding(result, 'bridge');
    const dependency = bridge?.scope.lookup('dependency');
    const transitive =
      dependency?.kind === ObjectKind.PackageName ? dependency.pkg : undefined;
    expect(first).toBe(second);
    expect(first).toBe(transitive);

    const token = first?.scope.lookup('Token');
    expect(token?.kind).toBe(ObjectKind.Struct);
    if (token?.kind === ObjectKind.Struct) {
      expect(declaredName(result, 'a').type).toBe(token.type);
      expect(declaredName(result, 'b').type).toBe(token.type);
      expect(declaredName(result, 'c').type).toBe(token.type);
    }
  });

  test('keeps same-named nominal types from different packages distinct', () => {
    const result = checkWith(
      {
        left: 'library("left")\nexport type Item\n    int value\n',
        right: 'library("right")\nexport type Item\n    int value\n',
      },
      [
        'import left',
        'import right',
        'left.Item l = left.Item.new(1)',
        'right.Item r = right.Item.new(1)',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    const left = packageBinding(result, 'left')?.scope.lookup('Item');
    const right = packageBinding(result, 'right')?.scope.lookup('Item');
    expect(left?.kind).toBe(ObjectKind.Struct);
    expect(right?.kind).toBe(ObjectKind.Struct);
    if (left?.kind === ObjectKind.Struct && right?.kind === ObjectKind.Struct) {
      expect(left).not.toBe(right);
      expect(typesEqual(left.type, right.type)).toBe(false);
    }
  });
});

describe('exported input aliases', () => {
  const ind =
    'library("ind")\nexport macd = input.series("indicator.macd")\nexport twice() => macd * 2\n';

  test('an alias is the Builtin series input its initializer names', () => {
    const result = checkWith(
      {ind},
      'import ind\nnow = ind.macd\nprev = ind.macd[1]\nsum = ind.twice()',
    );
    expect(result.errors).toEqual([]);
    const alias = packageBinding(result, 'ind')?.exports.get('macd');
    expect(alias).toMatchObject({
      kind: ObjectKind.Builtin,
      qualifier: Qualifier.Series,
      binding: {kind: 'series', id: 'indicator.macd'},
    });
  });

  test('only input.series may initialize an exported variable', () => {
    const computed = checkWith(
      {lib: 'library("lib")\nexport x = close + 1\n'},
      'import lib\nvalue = 1',
    );
    expect(
      hasMessage(computed, 'library variables may only alias input.series'),
    ).toBe(true);
  });

  test('no package may redeclare or assign a prelude input alias', () => {
    for (const lib of [
      'library("lib")\nconst close = 2.0\nexport f(float x) => close + x\n',
      'library("lib")\nexport close = input.series("mid")\nexport f(float x) => x\n',
      'library("lib")\nexport f(float high) => high\n',
    ]) {
      // Parameters are declared when an instance is checked, so call f.
      const result = checkWith({lib}, 'import lib\nvalue = lib.f(1.0)');
      expect(hasMessage(result, 'cannot redeclare built-in')).toBe(true);
    }
    const assigned = checkWith(
      {lib: 'library("lib")\nexport f() =>\n    close := 1\n    0\n'},
      'import lib\nvalue = lib.f()',
    );
    expect(hasMessage(assigned, "cannot assign to built-in 'close'")).toBe(
      true,
    );
  });

  test('alias names follow the series input and declaration rules', () => {
    const reserved = checkWith(
      {lib: 'library("lib")\nexport t = input.series("time")\n'},
      'import lib\nvalue = 1',
    );
    expect(hasMessage(reserved, "'input.series' name 'time' is reserved")).toBe(
      true,
    );
    const duplicate = checkWith(
      {
        lib: 'library("lib")\nexport m = input.series("a")\nexport m = input.series("b")\n',
      },
      'import lib\nvalue = 1',
    );
    expect(hasMessage(duplicate, "'m' is already declared")).toBe(true);
  });

  test('entry scripts and function bodies cannot export a variable', () => {
    const entry = checkWith({}, 'export x = input.series("x")');
    expect(
      hasMessage(
        entry,
        'only a library can export a variable, at its top level',
      ),
    ).toBe(true);

    const nested = checkWith(
      {lib: 'library("lib")\nexport f() =>\n    export y = 1\n    y\n'},
      'import lib\nvalue = lib.f()',
    );
    expect(
      hasMessage(
        nested,
        'only a library can export a variable, at its top level',
      ),
    ).toBe(true);
  });
});
