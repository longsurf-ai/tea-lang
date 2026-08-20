// Purpose: Codegen's final static-boundary tests — malformed hand-built aggregate Programs fail before becoming untyped generated JavaScript.

import {describe, expect, test} from 'vitest';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  Storage,
  type ConstExpr,
  type HistReadExpr,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../ir/node';
import type {MutableMethodIrFunc, Program} from '../ir/program';
import {
  IntType,
  Qualifier,
  TypeKind,
  type Type,
  type StructField,
  type StructType,
} from '../ir/type';
import {generate} from './codegen';

const pos = {base: {filename: 'program-invariant.test.tea'}, line: 1, col: 1};

function constant(type: Type, value: ConstExpr['value']): ConstExpr {
  return {
    kind: IrKind.Const,
    pos,
    type,
    qualifier: Qualifier.Series,
    value,
  };
}

function name(id: string, type: Type): Name {
  return {
    name: id,
    storage: Storage.PerBar,
    type,
    qualifier: Qualifier.Series,
    depth: {kind: DepthKind.None},
  };
}

function read(target: Name): HistReadExpr {
  return {
    kind: IrKind.HistRead,
    pos,
    type: target.type,
    qualifier: target.qualifier,
    place: {kind: PlaceKind.Name, name: target},
    offset: null,
  };
}

function field(x: IrExpr, fieldIndex: number, type: Type): IrExpr {
  return {
    kind: IrKind.FieldGet,
    pos,
    type,
    qualifier: Qualifier.Series,
    x,
    fieldIndex,
  };
}

function write(target: Name, value: IrExpr): IrStmt {
  return {kind: IrKind.WriteName, pos, name: target, value};
}

function storeField(
  object: IrExpr,
  owner: StructType,
  fieldIndex: number,
  value: IrExpr,
): IrStmt {
  return {
    kind: IrKind.StoreField,
    pos,
    object,
    owner,
    fieldIndex,
    value,
  };
}

function program(body: readonly IrStmt[]): Program {
  return {
    version: 1,
    params: [],
    requests: [],
    outputs: [],
    effects: [],
    packageGlobals: [],
    init: [],
    body,
  };
}

function compile(ir: Program): void {
  generate(ir);
}

function structType(name: string, fields: readonly StructField[]): StructType {
  return {kind: TypeKind.Struct, name, fields};
}

describe('malformed Program rejection', () => {
  test('rejects constructor and field nodes that disagree with their struct', () => {
    const pair = structType('Pair', [
      {name: 'left', type: IntType},
      {name: 'right', type: IntType},
    ]);
    const root = name('pair', pair);
    expect(() =>
      compile(
        program([
          write(root, {
            kind: IrKind.NewStruct,
            pos,
            type: pair,
            qualifier: Qualifier.Series,
            structType: pair,
            args: [constant(IntType, 1)],
            argumentEvaluationOrder: [0],
          }),
        ]),
      ),
    ).toThrow("constructor for 'Pair' has the wrong argument count");

    expect(() =>
      compile(
        program([
          write(root, {
            kind: IrKind.NewStruct,
            pos,
            type: pair,
            qualifier: Qualifier.Series,
            structType: pair,
            args: [constant(IntType, 1), constant(IntType, 2)],
            argumentEvaluationOrder: [0, 1],
          }),
          {kind: IrKind.ExprStmt, pos, x: field(read(root), 2, IntType)},
        ]),
      ),
    ).toThrow('field index 2 is out of range for Pair');

    expect(() =>
      compile(
        program([
          write(root, {
            kind: IrKind.NewStruct,
            pos,
            type: pair,
            qualifier: Qualifier.Series,
            structType: pair,
            args: [constant(IntType, 1), constant(IntType, 2)],
            argumentEvaluationOrder: [1, 1],
          }),
        ]),
      ),
    ).toThrow(
      "constructor 'Pair.new' has an invalid argument evaluation order",
    );
  });

  test('rejects a field store whose object disagrees with its owner', () => {
    const pair = structType('Pair', [{name: 'value', type: IntType}]);
    const root = name('x', IntType);
    expect(() =>
      compile(
        program([
          write(root, constant(IntType, 1)),
          storeField(read(root), pair, 0, constant(IntType, 2)),
        ]),
      ),
    ).toThrow('struct field store object disagrees with its owner type');
  });

  test('rejects a method receiver exposed as an explicit parameter', () => {
    const box = structType('Box', [{name: 'value', type: IntType}]);
    const receiver = name('receiver', box);
    const invalid: MutableMethodIrFunc = {
      callMode: 'mutable-method',
      name: 'invalid',
      params: [receiver],
      receiver,
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: field(read(receiver), 0, IntType),
    };
    const root = name('root', box);
    expect(() =>
      compile(
        program([
          write(root, {
            kind: IrKind.NewStruct,
            pos,
            type: box,
            qualifier: Qualifier.Series,
            structType: box,
            args: [constant(IntType, 1)],
            argumentEvaluationOrder: [0],
          }),
          {
            kind: IrKind.ExprStmt,
            pos,
            x: {
              kind: IrKind.CallMutableMethod,
              pos,
              type: IntType,
              qualifier: Qualifier.Series,
              func: invalid,
              receiver: read(root),
              slot: 0,
              args: [constant(IntType, 2)],
              argumentEvaluationOrder: [0],
            },
          },
        ]),
      ),
    ).toThrow(
      "method 'invalid' hidden receiver also appears in explicit params or locals",
    );
  });
});
