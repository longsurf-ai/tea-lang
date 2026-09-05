// Purpose: Aggregate-layout projection tests — layouts remain exact, nominal, deterministic, and finite through collection recursion.

import {describe, expect, test} from 'vitest';
import {DepthKind, IrKind, Storage, type Name} from '../ir/node';
import type {Program} from '../ir/program';
import {RUNTIME_ABI_VERSION} from '../runtime/module-abi';
import {
  BoolType,
  ColorType,
  FloatType,
  IntType,
  LabelType,
  LineType,
  NA_VALUE,
  Qualifier,
  StringType,
  TypeKind,
  type ArrayType,
  type EnumType,
  type MapType,
  type MatrixType,
  type StructField,
  type StructType,
} from '../ir/type';
import {generate} from './codegen';
import {loadModule} from '../runtime/load';

const pos = {base: {filename: 'aggregate-layout.test.tea'}, line: 1, col: 1};

function structType(name: string, fields: readonly StructField[]): StructType {
  return {kind: TypeKind.Struct, name, fields};
}

describe('aggregate layout projection', () => {
  test('emits exact, nominal, collision-free layouts', () => {
    const left: EnumType = {
      kind: TypeKind.Enum,
      name: 'Mode',
      members: [{name: 'on', title: 'On'}],
    };
    const right: EnumType = {
      kind: TypeKind.Enum,
      name: 'Mode',
      members: [{name: 'on', title: 'On'}],
    };
    const recursiveFields: StructField[] = [];
    const recursive = structType('Node', recursiveFields);
    const children: ArrayType = {kind: TypeKind.Array, elem: recursive};
    recursiveFields.push(
      {name: 'value', type: IntType},
      {name: 'children', type: children},
    );
    const ints: ArrayType = {kind: TypeKind.Array, elem: IntType};
    const floats: MatrixType = {kind: TypeKind.Matrix, elem: FloatType};
    const nodes: MapType = {
      kind: TypeKind.Map,
      key: StringType,
      value: recursive,
    };
    const envelope = structType('Envelope', [
      {name: 'integer', type: IntType},
      {name: 'decimal', type: FloatType},
      {name: 'flag', type: BoolType},
      {name: 'text', type: StringType},
      {name: 'color', type: ColorType},
      {name: 'leftMode', type: left},
      {name: 'rightMode', type: right},
      {name: 'line', type: LineType},
      {name: 'label', type: LabelType},
      {name: 'ints', type: ints},
      {name: 'floats', type: floats},
      {name: 'nodes', type: nodes},
    ]);
    const root: Name = {
      name: 'root',
      storage: Storage.PerBar,
      type: envelope,
      qualifier: Qualifier.Series,
      depth: {kind: DepthKind.None},
    };
    const ir: Program = {
      version: 1,
      nominalIds: new Map(),
      params: [],
      requests: [],
      outputs: [],
      effects: [],
      packageGlobals: [],
      init: [],
      body: [
        {
          kind: IrKind.WriteName,
          pos,
          name: root,
          value: {
            kind: IrKind.NewStruct,
            pos,
            type: envelope,
            qualifier: Qualifier.Series,
            structType: envelope,
            args: envelope.fields.map(field => ({
              kind: IrKind.Const,
              pos,
              type: field.type,
              qualifier: Qualifier.Series,
              value: field.type.kind === TypeKind.Bool ? false : NA_VALUE,
            })),
            argumentEvaluationOrder: envelope.fields.map(
              (_field, index) => index,
            ),
          },
        },
      ],
    };

    const source = generate(ir);
    const module = loadModule(source) as {
      readonly abi: number;
      readonly layout: readonly unknown[];
      readonly manifest: {
        readonly frames: readonly {
          readonly locals: readonly unknown[];
        }[];
      };
    };

    expect(module.abi).toBe(RUNTIME_ABI_VERSION);
    expect(module.manifest.frames[0].locals).toEqual([
      {storage: Storage.PerBar, depth: {kind: 'none'}, layout: 0},
    ]);
    expect(module.layout).toEqual([
      {
        kind: 'struct',
        name: 'Envelope',
        fields: [
          {name: 'integer', layout: 1},
          {name: 'decimal', layout: 2},
          {name: 'flag', layout: 3},
          {name: 'text', layout: 4},
          {name: 'color', layout: 5},
          {name: 'leftMode', layout: 6},
          {name: 'rightMode', layout: 7},
          {name: 'line', layout: 8},
          {name: 'label', layout: 9},
          {name: 'ints', layout: 10},
          {name: 'floats', layout: 11},
          {name: 'nodes', layout: 12},
        ],
      },
      {kind: 'number', numeric: 'int'},
      {kind: 'number', numeric: 'float'},
      {kind: 'boolean'},
      {kind: 'nullable-scalar', scalar: 'string'},
      {kind: 'nullable-scalar', scalar: 'color'},
      {kind: 'enum', name: 'Mode', members: ['on']},
      {kind: 'enum', name: 'Mode', members: ['on']},
      {kind: 'resource', handle: TypeKind.Line},
      {kind: 'resource', handle: TypeKind.Label},
      {kind: 'array', element: 1},
      {kind: 'matrix', element: 2},
      {kind: 'map', key: 4, value: 13},
      {
        kind: 'struct',
        name: 'Node',
        fields: [
          {name: 'value', layout: 1},
          {name: 'children', layout: 14},
        ],
      },
      {kind: 'array', element: 13},
    ]);
  });
});
