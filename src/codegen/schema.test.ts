// Purpose: Both targets expose real Arrow schemas with complete nested types.

import {DataType, Field, Schema} from 'apache-arrow';
import {describe, expect, test} from 'vitest';
import type {Program} from '../ir/program';
import {
  BoolType,
  ColorType,
  FloatType,
  IntType,
  LineType,
  StringType,
  TypeKind,
  type EnumType,
  type StructType,
  type Type,
} from '../ir/type';
import {loadModule} from '../runtime/load';
import {encodeSchema, decodeSchema} from '../runtime/io';
import {generate} from './codegen';
import {fieldOf} from './schema';

const mode: EnumType = {
  kind: TypeKind.Enum,
  name: 'Mode',
  members: [{name: 'fast', title: 'Fast'}],
};
const value: StructType = {
  kind: TypeKind.Struct,
  name: 'Mode',
  fields: [
    {name: 'prices', type: {kind: TypeKind.Array, elem: FloatType}},
    {name: 'mode', type: mode},
  ],
};
const nominalIds = new Map<Type, string>([
  [mode, 'market.Mode'],
  [value, 'user.Mode'],
]);

function moduleFor(types: readonly Type[]) {
  const program: Program = {
    version: 1,
    nominalIds,
    params: [],
    requests: [],
    outputs: [
      {
        effect: 'probe',
        staticArgs: [],
        bindArgs: [],
        bindArgumentEvaluationOrder: [],
        channels: types.map((type, index) => ({name: `field${index}`, type})),
      },
    ],
    effects: [],
    packageGlobals: [],
    init: [],
    body: [],
  };
  expect(generate(program)).toBe(generate(program));
  return loadModule(generate(program));
}

describe('Arrow I/O projection', () => {
  test('retains scalar semantics, nullability and canonical nominal identities', () => {
    const module = moduleFor([
      IntType,
      FloatType,
      BoolType,
      StringType,
      ColorType,
      mode,
      value,
    ]);
    const fields = module.manifest.outputs[0].channels;
    expect(fields.every(field => field instanceof Field)).toBe(true);
    expect(fields.map(field => field.type.toString())).toEqual([
      'Float64',
      'Float64',
      'Bool',
      'Utf8',
      'Utf8',
      'Utf8',
      'Struct<{prices:List<Float64>, mode:Utf8}>',
    ]);
    expect(fields.map(field => field.metadata.get('tea:type'))).toEqual([
      'int',
      'float',
      'bool',
      'string',
      'color',
      'enum',
      'struct',
    ]);
    expect(fields.map(field => field.nullable)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(fields[5].metadata.get('tea:typeId')).toBe('market.Mode');
    expect(fields[6].metadata.get('tea:typeId')).toBe('user.Mode');
    expect(JSON.parse(fields[5].metadata.get('tea:members')!)).toEqual([
      {name: 'fast', title: 'Fast'},
    ]);
    expect(module.layout[module.manifest.outputs[0].layouts[6]]).toMatchObject({
      typeId: 'user.Mode',
    });
  });

  test('projects complete list, tuple, matrix, map and resource fields through IPC', () => {
    const fields = moduleFor([
      {kind: TypeKind.Array, elem: value},
      {kind: TypeKind.Tuple, elems: [IntType, StringType]},
      {kind: TypeKind.Matrix, elem: FloatType},
      {kind: TypeKind.Map, key: StringType, value},
      LineType,
    ]).manifest.outputs[0].channels;
    const restored = decodeSchema(encodeSchema(new Schema([...fields])));
    expect(restored).toEqual(new Schema([...fields]));
    expect(DataType.isList(restored.fields[0].type)).toBe(true);
    expect(restored.fields[0].type.children[0].metadata.get('tea:typeId')).toBe(
      'user.Mode',
    );
    expect(
      restored.fields[1].type.children.map((field: Field) => field.name),
    ).toEqual(['_0', '_1']);
    expect(
      restored.fields[2].type.children.map((field: Field) => field.name),
    ).toEqual(['rows', 'columns', 'values']);
    expect(restored.fields[3].type.children[0].type.children[0].nullable).toBe(
      false,
    );
    expect(
      restored.fields[4].type.children.map((field: Field) => field.name),
    ).toEqual(['kind', 'id']);
    expect(restored.fields[4].metadata.get('tea:name')).toBe('line');
  });

  test('requires canonical nominal identity and rejects recursive projection', () => {
    expect(() => fieldOf('value', value, new Map())).toThrow(
      'has no nominal identity',
    );
    const recursive: StructType = {
      kind: TypeKind.Struct,
      name: 'Branch',
      fields: [],
    };
    (recursive.fields as {name: string; type: Type}[]).push({
      name: 'next',
      type: recursive,
    });
    expect(() =>
      fieldOf('branch', recursive, new Map([[recursive, 'test.Branch']])),
    ).toThrow('recursive export');
  });
});

// Opt in with TEA_STRESS=1; each case is a narrow tree, so depth does not
// accidentally turn the test generator into an exponential allocation load.
test.runIf(process.env.TEA_STRESS === '1')(
  'stress: 10,000 seeded Arrow schema round trips to depth 32',
  () => {
    let seed = 0x51a7;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let index = 0; index < 10_000; index += 1) {
      const ids = new Map<Type, string>();
      let type: Type = [IntType, FloatType, BoolType, StringType][next() % 4];
      const depth = next() % 33;
      for (let level = 0; level < depth; level += 1) {
        switch (next() % 5) {
          case 0:
            type = {kind: TypeKind.Array, elem: type};
            break;
          case 1:
            type = {kind: TypeKind.Matrix, elem: type};
            break;
          case 2:
            type = {kind: TypeKind.Map, key: StringType, value: type};
            break;
          case 3:
            type = {kind: TypeKind.Tuple, elems: [BoolType, type]};
            break;
          default:
            type = {
              kind: TypeKind.Struct,
              name: 'Item',
              fields: [{name: 'value', type}],
            };
            ids.set(type, `test.Item${level}`);
        }
      }
      const schema = new Schema([fieldOf('value', type, ids)]);
      const bytes = encodeSchema(schema);
      expect(encodeSchema(decodeSchema(bytes))).toEqual(bytes);
    }
  },
  120_000,
);
