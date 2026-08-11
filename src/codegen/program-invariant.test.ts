// Purpose: Codegen's final static-boundary tests — malformed hand-built aggregate Programs fail before becoming untyped generated JavaScript.

import {describe, expect, test} from 'bun:test';
import {DEFAULT_COMPILE_CONFIG} from '../base/config';
import {Errors} from '../base/print';
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
  type UserField,
  type UserType,
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
    init: null,
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

function update(
  root: Name,
  fieldIndices: readonly number[],
  value: IrExpr,
): IrStmt {
  return {
    kind: IrKind.UpdateValuePath,
    pos,
    path: {root, fieldIndices},
    value,
  };
}

function program(body: readonly IrStmt[]): Program {
  return {
    version: 1,
    params: [],
    requests: [],
    outputs: [],
    init: [],
    body,
  };
}

function compile(ir: Program): void {
  generate(ir, DEFAULT_COMPILE_CONFIG, new Errors());
}

function userType(name: string, fields: readonly UserField[]): UserType {
  return {kind: TypeKind.UserType, name, fields};
}

describe('malformed Program rejection', () => {
  test('rejects constructor and field nodes that disagree with their user type', () => {
    const pair = userType('Pair', [
      {name: 'left', type: IntType},
      {name: 'right', type: IntType},
    ]);
    const root = name('pair', pair);
    expect(() =>
      compile(
        program([
          write(root, {
            kind: IrKind.NewUserValue,
            pos,
            type: pair,
            qualifier: Qualifier.Series,
            userType: pair,
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
            kind: IrKind.NewUserValue,
            pos,
            type: pair,
            qualifier: Qualifier.Series,
            userType: pair,
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
            kind: IrKind.NewUserValue,
            pos,
            type: pair,
            qualifier: Qualifier.Series,
            userType: pair,
            args: [constant(IntType, 1), constant(IntType, 2)],
            argumentEvaluationOrder: [1, 1],
          }),
        ]),
      ),
    ).toThrow(
      "constructor 'Pair.new' has an invalid argument evaluation order",
    );
  });

  test('rejects a rooted path that traverses a non-user value', () => {
    const root = name('x', IntType);
    expect(() =>
      compile(
        program([
          write(root, constant(IntType, 1)),
          update(root, [0], constant(IntType, 2)),
        ]),
      ),
    ).toThrow('field path traverses non-user type Int');
  });

  test('rejects a method receiver exposed as an explicit parameter', () => {
    const receiver = name('receiver', IntType);
    const invalid: MutableMethodIrFunc = {
      callMode: 'mutable-method',
      name: 'invalid',
      params: [receiver],
      receiver,
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: read(receiver),
    };
    const root = name('root', IntType);
    expect(() =>
      compile(
        program([
          write(root, constant(IntType, 1)),
          {
            kind: IrKind.ExprStmt,
            pos,
            x: {
              kind: IrKind.CallMutableMethod,
              pos,
              type: IntType,
              qualifier: Qualifier.Series,
              func: invalid,
              path: {root, fieldIndices: []},
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
