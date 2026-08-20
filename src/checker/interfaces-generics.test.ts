// Purpose: RED contracts for method-only interfaces and concrete generic struct specialization.

import {describe, expect, test} from 'vitest';
import {formatType, TypeKind, typesEqual} from '../ir/type';
import {funcsOf, namesOf} from '../ir/visit';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {mustBuild} from '../noder/testing';
import {NodeKind, type CallExpr, type DeclStmt} from '../syntax/nodes';
import {parseText} from '../syntax/testing';
import {
  CallKind,
  type ConstructorCall,
  type FunctionCall,
  type Info,
} from './info';
import {ObjectKind} from './object';
import {checkText, declaredName, type CheckResult} from './testing';

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
  return checkText(
    source,
    'main.tea',
    resolveImports([parsed.file], memoryRegistry(sources), []),
  );
}

function messages(result: CheckResult): string[] {
  return result.errors.map(error => error.msg);
}

function declarationCall(result: CheckResult, name: string): CallExpr {
  const stmt = result.file.stmtList.find(
    (candidate): candidate is DeclStmt =>
      candidate.kind === NodeKind.DeclStmt &&
      candidate.target.kind === NodeKind.Name &&
      candidate.target.value === name,
  );
  if (stmt?.init.kind !== NodeKind.CallExpr) {
    throw new Error(`fixture declaration '${name}' has no direct call`);
  }
  return stmt.init;
}

function functionCall(result: CheckResult, name: string): FunctionCall {
  const call = result.info.calls.get(declarationCall(result, name));
  if (call?.kind !== CallKind.Function) {
    throw new Error(`fixture declaration '${name}' has no function resolution`);
  }
  return call;
}

function constructorCall(result: CheckResult, name: string): ConstructorCall {
  const call = result.info.calls.get(declarationCall(result, name));
  if (call?.kind !== CallKind.Constructor) {
    throw new Error(
      `fixture declaration '${name}' has no constructor resolution`,
    );
  }
  return call;
}

function onlyConstructor(info: Info): ConstructorCall {
  const calls = [...info.calls.values()].filter(
    (call): call is ConstructorCall => call.kind === CallKind.Constructor,
  );
  if (calls.length !== 1) {
    throw new Error(`fixture function owns ${calls.length} constructor calls`);
  }
  return calls[0];
}

describe('static method-only interfaces', () => {
  test('uses implicit satisfaction and permits extra methods', () => {
    const result = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        '    int extra() const => 99',
        'type Holder<T: Reader>',
        '    T source',
        '    int read() const => this.source.read()',
        'source = Source.new(7)',
        'holder = Holder.new(source)',
        'value = holder.read()',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    const interfaceDecl = result.file.stmtList[0];
    expect(interfaceDecl.kind).toBe(NodeKind.InterfaceDecl);
    if (interfaceDecl.kind === NodeKind.InterfaceDecl) {
      expect(result.info.defs.get(interfaceDecl.name)).toBe(
        result.checked.pkg.scope.lookup('Reader') ?? undefined,
      );
    }
    expect(declaredName(result, 'value').type.kind).toBe(TypeKind.Int);
  });

  test('exports qualified constraints while keeping private interfaces inaccessible', () => {
    const result = checkWith(
      {
        contracts: [
          'library("contracts")',
          'export interface PublicReader',
          '    int read() const',
          'interface HiddenReader',
          '    int read() const',
        ].join('\n'),
      },
      [
        'import contracts as api',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        'type PublicHolder<T: api.PublicReader>',
        '    T source',
        'good = PublicHolder.new(Source.new(1))',
        'type PrivateHolder<T: api.HiddenReader>',
        '    T source',
      ].join('\n'),
    );

    const api = result.checked.pkg.scope.lookup('api');
    if (api?.kind !== ObjectKind.PackageName) {
      throw new Error('fixture lost its imported package binding');
    }
    expect(api.pkg.exports.has('PublicReader')).toBe(true);
    expect(api.pkg.exports.has('HiddenReader')).toBe(false);
    expect(messages(result)).toContain("unknown interface 'api.HiddenReader'");
    expect(
      messages(result).some(message => message.includes('api.PublicReader')),
    ).toBe(false);
  });

  test('infers an exported generic constructor through a package alias', () => {
    const result = checkWith(
      {
        boxes: [
          'library("boxes")',
          'export interface Reader',
          '    int read() const',
          'export type Box<T: Reader>',
          '    T source',
          '    int read() const => this.source.read()',
        ].join('\n'),
      },
      [
        'import boxes as api',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        'api.Box<Source> box = api.Box.new(Source.new(7))',
        'value = box.read()',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    expect(formatType(declaredName(result, 'box').type)).toBe('Box<Source>');
    expect(declaredName(result, 'value').type.kind).toBe(TypeKind.Int);
  });

  const mismatches = [
    {
      name: 'missing method',
      method: '',
      expected: "Bad does not satisfy Contract: missing method 'apply'",
    },
    {
      name: 'arity',
      method: '    int apply(float value, int extra) const => 0',
      expected:
        "Bad does not satisfy Contract: method 'apply' has 2 parameters, want 1",
    },
    {
      name: 'parameter type',
      method: '    int apply(int value) const => value',
      expected:
        "Bad does not satisfy Contract: method 'apply' parameter 1 has type int, want float",
    },
    {
      name: 'result type',
      method: '    float apply(float value) const => value',
      expected:
        "Bad does not satisfy Contract: method 'apply' returns float, want int",
    },
    {
      name: 'receiver mode',
      method: '    int apply(float value) => int(value)',
      expected:
        "Bad does not satisfy Contract: method 'apply' has mutable receiver, want const",
    },
  ] as const;

  for (const mismatch of mismatches) {
    test(`rejects interface ${mismatch.name} mismatch`, () => {
      const result = checkText(
        [
          'interface Contract',
          '    int apply(float value) const',
          'type Bad',
          '    int marker',
          mismatch.method,
          'type Box<T: Contract>',
          '    T value',
          'bad = Bad.new(0)',
          'box = Box.new(bad)',
        ]
          .filter(Boolean)
          .join('\n'),
      );

      expect(messages(result)).toContain(mismatch.expected);
    });
  }
});

describe('constrained generic structs', () => {
  test('validates field annotations and bodies without an instantiation', () => {
    const unknownField = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Box<T: Reader>',
        '    Unknown value',
      ].join('\n'),
    );
    expect(messages(unknownField)).toContain("unknown type 'Unknown'");

    const unknownBodyName = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Box<T: Reader>',
        '    T value',
        '    int broken() const => unknown',
      ].join('\n'),
    );
    expect(messages(unknownBodyName)).toContain("undeclared name 'unknown'");

    const constraintMethod = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Box<T: Reader>',
        '    T value',
        '    int broken() const => this.value.secret()',
      ].join('\n'),
    );
    expect(messages(constraintMethod)).toContain(
      "type parameter 'T' constrained by 'Reader' has no method 'secret'",
    );
  });

  test('does not publish symbolic validation facts to Program IR', () => {
    const program = mustBuild(
      [
        'interface Reader',
        '    int read() const',
        'type Box<T: Reader>',
        '    T value',
        '    int read() const => this.value.read()',
        'plot(1)',
      ].join('\n'),
    );

    expect(
      objectKinds(program).filter(kind =>
        [
          'interface',
          'interfaceMethod',
          'genericStruct',
          'typeParameter',
          NodeKind.InterfaceDecl,
          NodeKind.TypeParam,
          NodeKind.GenericType,
        ].includes(kind),
      ),
    ).toEqual([]);
  });

  test('rejects duplicate members without requiring an instantiation', () => {
    const result = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Box<T: Reader>',
        '    T source',
        '    int source() const => 1',
      ].join('\n'),
    );

    expect(messages(result)).toContain(
      "duplicate member 'source' in type 'Box'",
    );
  });

  const STRATEGY_SOURCE = [
    'interface Broker',
    '    int quote(int signal) const',
    'interface Portfolio',
    '    int balance() const',
    'type FastBroker',
    '    int offset',
    '    int quote(int signal) const => signal + this.offset',
    'type SlowBroker',
    '    int offset',
    '    int quote(int signal) const => signal - this.offset',
    'type Book',
    '    int cash',
    '    int balance() const => this.cash',
    'type Strategy<B: Broker, P: Portfolio>',
    '    B broker',
    '    P portfolio',
    '    int evaluate(int signal) const => this.broker.quote(signal) + this.portfolio.balance()',
    'configure(broker, portfolio) => Strategy.new(broker, portfolio)',
    'sameA = Strategy.new(FastBroker.new(1), Book.new(10))',
    'sameB = Strategy.new(FastBroker.new(2), Book.new(20))',
    'different = Strategy.new(SlowBroker.new(1), Book.new(10))',
    'first = configure(FastBroker.new(3), Book.new(30))',
    'second = configure(SlowBroker.new(4), Book.new(40))',
    'firstValue = first.evaluate(5)',
    'secondValue = second.evaluate(5)',
  ].join('\n');

  test('infers Strategy-like constructors and interns concrete tuples canonically', () => {
    const result = checkText(STRATEGY_SOURCE);
    expect(result.errors).toEqual([]);

    const sameA = constructorCall(result, 'sameA');
    const sameB = constructorCall(result, 'sameB');
    const different = constructorCall(result, 'different');
    expect(sameA.type).toBe(sameB.type);
    expect(sameA.type.type).toBe(sameB.type.type);
    expect(different.type).not.toBe(sameA.type);
    expect(typesEqual(different.type.type, sameA.type.type)).toBe(false);
    expect(sameA.type.type.name).toBe('Strategy<FastBroker, Book>');
    expect(different.type.type.name).toBe('Strategy<SlowBroker, Book>');
    expect(sameA.type.fields.map(field => formatType(field.type))).toEqual([
      'FastBroker',
      'Book',
    ]);
  });

  test('infers type parameters through collection field shapes', () => {
    const result = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        'type Batch<T: Reader>',
        '    array<T> values',
        'batch = Batch.new(array.from(Source.new(1)))',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    expect(formatType(declaredName(result, 'batch').type)).toBe(
      'Batch<Source>',
    );
  });

  test('keeps free-function and method facts separate per concrete instantiation', () => {
    const result = checkText(STRATEGY_SOURCE);
    expect(result.errors).toEqual([]);

    const firstConfigure = functionCall(result, 'first');
    const secondConfigure = functionCall(result, 'second');
    expect(firstConfigure.instance).not.toBe(secondConfigure.instance);
    expect(firstConfigure.instance.info).not.toBe(
      secondConfigure.instance.info,
    );

    const firstType = onlyConstructor(firstConfigure.instance.info).type;
    const secondType = onlyConstructor(secondConfigure.instance.info).type;
    expect(firstType).not.toBe(secondType);

    const firstEvaluate = functionCall(result, 'firstValue');
    const secondEvaluate = functionCall(result, 'secondValue');
    expect(firstEvaluate.instance.template).not.toBe(
      secondEvaluate.instance.template,
    );
    expect(firstEvaluate.instance.info).not.toBe(secondEvaluate.instance.info);
    expect(firstEvaluate.instance.template.receiver?.owner).toBe(firstType);
    expect(secondEvaluate.instance.template.receiver?.owner).toBe(secondType);

    const firstNestedCalls = [...firstEvaluate.instance.info.calls.values()];
    const secondNestedCalls = [...secondEvaluate.instance.info.calls.values()];
    expect(
      firstNestedCalls.filter(call => call.kind === CallKind.Function),
    ).toHaveLength(2);
    expect(
      secondNestedCalls.filter(call => call.kind === CallKind.Function),
    ).toHaveLength(2);
  });

  test('validates unused methods once their generic owner is instantiated', () => {
    const result = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        'type Box<T: Reader>',
        '    T source',
        '    string broken() const => 1',
        'box = Box.new(Source.new(1))',
      ].join('\n'),
    );

    expect(messages(result)).toContain(
      "method 'Box<Source>.broken' returns int, want string",
    );
    expect(result.info.calls.has(declarationCall(result, 'box'))).toBe(true);
  });

  test('allows only methods declared by the type-parameter constraint', () => {
    const result = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        '    int secret() const => 42',
        'type Box<T: Reader>',
        '    T source',
        '    int allowed() const => this.source.read()',
        '    int forbidden() const => this.source.secret()',
        'box = Box.new(Source.new(1))',
        'value = box.allowed()',
      ].join('\n'),
    );

    expect(messages(result)).toContain(
      "type parameter 'T' constrained by 'Reader' has no method 'secret'",
    );
    expect(
      messages(result).some(message => message.includes("method 'read'")),
    ).toBe(false);
  });

  test('keeps constraint provenance on generic method parameters and aliases', () => {
    const result = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        '    int secret() const => 42',
        'type Box<T: Reader>',
        '    T source',
        '    int forbidden(T other) const =>',
        '        alias = other',
        '        alias.secret()',
        'box = Box.new(Source.new(1))',
      ].join('\n'),
    );

    expect(messages(result)).toContain(
      "type parameter 'T' constrained by 'Reader' has no method 'secret'",
    );
  });

  test('checks generic method defaults with ordinary sibling-parameter rules', () => {
    const result = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        'fallback = Source.new(0)',
        'type Box<T: Reader>',
        '    T source',
        '    int choose(T fallback = fallback) const => fallback.read()',
        'box = Box.new(Source.new(1))',
      ].join('\n'),
    );

    expect(messages(result)).toContain(
      "method parameter default cannot reference method parameter 'fallback'",
    );
  });

  test('validates generic methods after an enclosing constructor helper finishes', () => {
    const result = checkText(
      [
        'interface Reader',
        '    int read() const',
        'type Source',
        '    int value',
        '    int read() const => this.value',
        'make(value) => Box.new(value)',
        'type Box<T: Reader>',
        '    T source',
        '    int clone_read() const => make(this.source).source.read()',
        'box = make(Source.new(1))',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
  });

  test('publishes only concrete value types and direct calls to Program IR', () => {
    const source = [
      'interface Reader',
      '    int read() const',
      'type Source',
      '    int value',
      '    int read() const => this.value',
      'type Box<T: Reader>',
      '    T source',
      '    int read() const => this.source.read()',
      'box = Box.new(Source.new(7))',
      'value = box.read()',
      'plot(value)',
    ].join('\n');
    const program = mustBuild(source);

    const box = namesOf(program).find(name => name.name === 'box');
    expect(box?.type.kind).toBe(TypeKind.Struct);
    if (box?.type.kind === TypeKind.Struct) {
      expect(box.type.name).toBe('Box<Source>');
      const sourceFieldType = box.type.fields[0]?.type;
      expect(sourceFieldType?.kind).toBe(TypeKind.Struct);
      if (sourceFieldType?.kind === TypeKind.Struct) {
        expect(sourceFieldType.name).toBe('Source');
      }
    }
    expect(funcsOf(program).map(func => func.name)).toContain(
      'Box<Source>.read',
    );

    const kinds = objectKinds(program);
    expect(
      kinds.filter(kind =>
        [
          'interface',
          'genericStruct',
          'typeParameter',
          NodeKind.InterfaceDecl,
          NodeKind.TypeParam,
          NodeKind.GenericType,
        ].includes(kind),
      ),
    ).toEqual([]);
  });
});

function objectKinds(root: unknown): string[] {
  const kinds: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
      return;
    }
    seen.add(value);
    if ('kind' in value && typeof value.kind === 'string') {
      kinds.push(value.kind);
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(root);
  return kinds;
}
