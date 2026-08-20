// Purpose: Static-interface semantic declarations and exact implicit method-set satisfaction.

import {describe, expect, test} from 'vitest';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {parseText} from '../syntax/testing';
import {
  ObjectKind,
  satisfies,
  type InterfaceObject,
  type StructObject,
} from './object';
import {checkText, type CheckResult} from './testing';

function interfaceNamed(result: CheckResult, name: string): InterfaceObject {
  const object = result.checked.pkg.scope.lookup(name);
  expect(object?.kind).toBe(ObjectKind.Interface);
  if (object?.kind !== ObjectKind.Interface) {
    throw new Error(`fixture declares no interface '${name}'`);
  }
  return object;
}

function structNamed(result: CheckResult, name: string): StructObject {
  const object = result.checked.pkg.scope.lookup(name);
  expect(object?.kind).toBe(ObjectKind.Struct);
  if (object?.kind !== ObjectKind.Struct) {
    throw new Error(`fixture declares no struct '${name}'`);
  }
  return object;
}

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

describe('static interfaces', () => {
  test('predeclares an interface and resolves its complete ordered signatures', () => {
    const result = checkText(
      [
        'interface Codec',
        '    Payload roundtrip(Payload value) const',
        '    int size(Payload value)',
        'type Payload',
        '    int value',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    const codec = interfaceNamed(result, 'Codec');
    const payload = structNamed(result, 'Payload');
    expect(codec.methods.map(method => method.name)).toEqual([
      'roundtrip',
      'size',
    ]);
    expect(codec.methods[0].receiverMode).toBe('const');
    expect(codec.methods[0].params[0].type).toBe(payload.type);
    expect(codec.methods[0].result).toBe(payload.type);
    expect(result.info.defs.get(codec.decl.name)).toBe(codec);
    expect(result.info.defs.get(codec.methods[0].decl.name)).toBe(
      codec.methods[0],
    );
  });

  test('rejects duplicate method names after resolving their signatures', () => {
    const result = checkText(
      [
        'interface Broker',
        '    int submit(float price)',
        '    int submit(int quantity)',
      ].join('\n'),
    );

    expect(result.errors.map(error => error.msg)).toContain(
      "duplicate method 'submit' in interface 'Broker'",
    );
    expect(interfaceNamed(result, 'Broker').methods).toHaveLength(1);
  });

  test('exports only public interface declarations from a library package', () => {
    const result = checkWith(
      {
        contracts: [
          'library("contracts")',
          'export interface Broker',
          '    int submit(float price)',
          'interface Hidden',
          '    int secret() const',
        ].join('\n'),
      },
      'import contracts as api\nvalue = 1',
    );

    expect(result.errors).toEqual([]);
    const binding = result.checked.pkg.scope.lookup('api');
    expect(binding?.kind).toBe(ObjectKind.PackageName);
    if (binding?.kind !== ObjectKind.PackageName) {
      throw new Error('missing package binding');
    }
    expect(binding.pkg.scope.lookup('Broker')?.kind).toBe(ObjectKind.Interface);
    expect(binding.pkg.scope.lookup('Hidden')?.kind).toBe(ObjectKind.Interface);
    expect(binding.pkg.exports.get('Broker')?.kind).toBe(ObjectKind.Interface);
    expect(binding.pkg.exports.has('Hidden')).toBe(false);
  });

  test('interfaces never enter value typing or construction', () => {
    const result = checkText(
      [
        'interface Broker',
        '    int submit(float price)',
        'Broker annotated = na',
        'constructed = Broker.new()',
        'called = Broker()',
        'bare = Broker',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);

    expect(messages).toContain(
      "interface 'Broker' cannot be used as a value type",
    );
    expect(messages).toContain("interface 'Broker' cannot be constructed");
    expect(messages).toContain("interface 'Broker' is not callable");
    expect(messages).toContain("interface 'Broker' is not a value");
  });
});

describe('implicit interface satisfaction', () => {
  test('requires an exact method set signature while allowing extra methods', () => {
    const result = checkText(
      [
        'interface Broker',
        '    int submit(simple float price) const',
        'type Exact',
        '    int submit(simple float quoted) const => 1',
        '    int extra() const => 1',
        'type Missing',
        '    int other(simple float price) const => 1',
        'type Arity',
        '    int submit(simple float price, int quantity) const => 1',
        'type Parameter',
        '    int submit(simple int price) const => 1',
        'type Qualifier',
        '    int submit(float price) const => 1',
        'type Result',
        '    float submit(simple float price) const => price',
        'type Receiver',
        '    int submit(simple float price) => 1',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    const broker = interfaceNamed(result, 'Broker');
    expect(satisfies(structNamed(result, 'Exact'), broker)).toBe(true);
    for (const name of [
      'Missing',
      'Arity',
      'Parameter',
      'Qualifier',
      'Result',
      'Receiver',
    ]) {
      expect(satisfies(structNamed(result, name), broker)).toBe(false);
    }
  });
});
