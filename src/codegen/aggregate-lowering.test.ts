// Purpose: Aggregate codegen contract tests — ABI 3 layouts and rooted value updates must preserve exact types, evaluation order, and copy-out semantics.

import {describe, expect, test} from 'bun:test';
import {DEFAULT_COMPILE_CONFIG} from '../base/config';
import {Errors} from '../base/print';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type BlockExpr,
  type ConstExpr,
  type HistReadExpr,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../ir/node';
import type {
  ConstMethodIrFunc,
  MutableMethodIrFunc,
  Program,
} from '../ir/program';
import {
  IntType,
  NA_VALUE,
  Qualifier,
  TypeKind,
  VoidType,
  type ArrayType,
  type Type,
  type TupleType,
  type UserField,
  type UserType,
} from '../ir/type';
import type {ModuleCode} from '../runtime/abi';
import {generate} from './codegen';

const pos = {base: {filename: 'aggregate-lowering.test.tea'}, line: 1, col: 1};

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

function block(stmts: readonly IrStmt[], value: IrExpr): BlockExpr {
  return {
    kind: IrKind.BlockExpr,
    pos,
    type: value.type,
    qualifier: value.qualifier,
    stmts,
    value,
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

function compile(ir: Program): ModuleCode & {
  readonly abi: number;
} {
  const js = generate(ir, DEFAULT_COMPILE_CONFIG, new Errors());
  return new Function(js)() as ModuleCode & {
    readonly abi: number;
  };
}

function userType(name: string, fields: readonly UserField[]): UserType {
  return {kind: TypeKind.UserType, name, fields};
}

interface TestUserValue {
  readonly kind: 'user-type';
  readonly layout: number;
  readonly fields: readonly unknown[];
}

interface TestCollectionValue {
  readonly kind: 'array';
  readonly layout: number;
  readonly values: readonly unknown[];
}

interface TestFrame {
  readonly values: unknown[];
  readonly subs: Map<number, TestFrame>;
}

function executionRuntime(
  root: TestFrame,
  events: string[],
): Record<string, unknown> {
  const isUser = (value: unknown): value is TestUserValue =>
    typeof value === 'object' && value !== null && 'fields' in value;
  const rebuild = (
    value: unknown,
    path: readonly number[],
    leaf: unknown,
  ): unknown => {
    if (path.length === 0) {
      return leaf;
    }
    if (!isUser(value)) {
      throw new Error('invalid user path');
    }
    const [head, ...tail] = path;
    const fields = [...value.fields];
    fields[head] = rebuild(fields[head], tail, leaf);
    return {...value, fields};
  };
  return {
    root: () => root,
    read: (frame: TestFrame, slot: number, offset: number) => {
      expect(offset).toBe(0);
      return frame.values[slot];
    },
    write: (frame: TestFrame, slot: number, value: unknown) => {
      events.push(frame === root ? `write-root:${slot}` : `write-func:${slot}`);
      frame.values[slot] = value;
    },
    frame: (frame: TestFrame, slot: number) => {
      let child = frame.subs.get(slot);
      if (child === undefined) {
        child = {values: [], subs: new Map()};
        frame.subs.set(slot, child);
      }
      return child;
    },
    newUser: (layout: number, fields: readonly unknown[]): TestUserValue => ({
      kind: 'user-type',
      layout,
      fields: [...fields],
    }),
    userField: (value: unknown, layout: number, index: number) => {
      events.push(`field:${layout}:${index}`);
      if (!isUser(value) || value.layout !== layout) {
        throw new Error('invalid user field read');
      }
      return value.fields[index];
    },
    rebuildUserPath: (
      value: unknown,
      _layout: number,
      path: readonly number[],
      leaf: unknown,
    ) => rebuild(value, path, leaf),
    callCollection: (
      operation: string,
      resultLayout: number,
      args: readonly unknown[],
    ) => {
      events.push(`call:${operation}:${resultLayout}`);
      if (operation === 'array.from') {
        return {
          kind: 'array',
          layout: resultLayout,
          values: [...args],
        } satisfies TestCollectionValue;
      }
      if (operation === 'array.size') {
        return (args[0] as TestCollectionValue).values.length;
      }
      throw new Error(`unexpected collection call ${operation}`);
    },
    mutateCollection: (
      operation: string,
      _layout: number,
      receiver: TestCollectionValue,
      args: readonly unknown[],
    ) => {
      events.push(`mutate:${operation}`);
      if (operation !== 'array.push') {
        throw new Error(`unexpected mutation ${operation}`);
      }
      return {
        replacement: {...receiver, values: [...receiver.values, args[0]]},
        result: null,
      };
    },
  };
}

describe('aggregate expression and rooted-write lowering', () => {
  test('projects typed empties when a transport tuple is na', () => {
    const tuple: TupleType = {kind: TypeKind.Tuple, elems: [IntType, IntType]};
    const tupleName = name('tuple', tuple);
    const observed = name('observed', IntType);
    const module = compile(
      program([
        write(tupleName, constant(tuple, NA_VALUE)),
        write(observed, {
          kind: IrKind.TupleGet,
          pos,
          type: IntType,
          qualifier: Qualifier.Series,
          x: read(tupleName),
          index: 0,
        }),
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    module.main(executionRuntime(frame, []) as never, frame as never);

    expect(frame.values[0]).toBeNull();
    expect(Number.isNaN(frame.values[1] as number)).toBeTrue();
  });

  test('constructs, reads, and rebases a direct field update after RHS writes', () => {
    const pair = userType('Pair', [
      {name: 'left', type: IntType},
      {name: 'right', type: IntType},
    ]);
    const rootName = name('pair', pair);
    const observed = name('observed', IntType);
    const module = compile(
      program([
        write(rootName, {
          kind: IrKind.NewUserValue,
          pos,
          type: pair,
          qualifier: Qualifier.Series,
          userType: pair,
          args: [constant(IntType, 1), constant(IntType, 2)],
          argumentEvaluationOrder: [0, 1],
        }),
        update(
          rootName,
          [0],
          block(
            [update(rootName, [1], constant(IntType, 9))],
            constant(IntType, 5),
          ),
        ),
        write(observed, field(read(rootName), 1, IntType)),
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    module.main(executionRuntime(frame, []) as never, frame as never);

    expect((frame.values[0] as TestUserValue).fields).toEqual([5, 9]);
    expect(frame.values[1]).toBe(9);
  });

  test('uses collection result layouts and rebases mutation after argument writes', () => {
    const arrayType: ArrayType = {kind: TypeKind.Array, elem: IntType};
    const holder = userType('Holder', [
      {name: 'values', type: arrayType},
      {name: 'marker', type: IntType},
    ]);
    const holderName = name('holder', holder);
    const size = name('size', IntType);
    const arrayFrom: IrExpr = {
      kind: IrKind.CallNative,
      pos,
      type: arrayType,
      qualifier: Qualifier.Series,
      native: 'array.from',
      slot: null,
      args: [constant(IntType, 1)],
      argumentEvaluationOrder: [0],
    };
    const module = compile(
      program([
        write(holderName, {
          kind: IrKind.NewUserValue,
          pos,
          type: holder,
          qualifier: Qualifier.Series,
          userType: holder,
          args: [arrayFrom, constant(IntType, 0)],
          argumentEvaluationOrder: [0, 1],
        }),
        {
          kind: IrKind.ExprStmt,
          pos,
          x: {
            kind: IrKind.MutateCollection,
            pos,
            type: VoidType,
            qualifier: Qualifier.Series,
            path: {root: holderName, fieldIndices: [0]},
            receiver: field(read(holderName), 0, arrayType),
            operation: 'array.push',
            args: [
              block(
                [update(holderName, [1], constant(IntType, 9))],
                constant(IntType, 2),
              ),
            ],
            argumentEvaluationOrder: [0],
          },
        },
        write(size, {
          kind: IrKind.CallNative,
          pos,
          type: IntType,
          qualifier: Qualifier.Series,
          native: 'array.size',
          slot: null,
          args: [field(read(holderName), 0, arrayType)],
          argumentEvaluationOrder: [0],
        }),
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    const events: string[] = [];
    module.main(executionRuntime(frame, events) as never, frame as never);

    const result = frame.values[0] as TestUserValue;
    expect((result.fields[0] as TestCollectionValue).values).toEqual([1, 2]);
    expect(result.fields[1]).toBe(9);
    expect(frame.values[1]).toBe(2);
    expect(events).toContain('call:array.from:0');
    expect(events).toContain('call:array.size:1');
    const receiverRead = events.indexOf('field:2:0');
    const argumentWrite = events.indexOf('write-root:0', receiverRead + 1);
    expect(receiverRead).toBeLessThan(argumentWrite);
    expect(argumentWrite).toBeLessThan(events.indexOf('mutate:array.push'));
  });

  test('evaluates a const-method receiver before explicit arguments without writeback', () => {
    const point = userType('Point', [{name: 'x', type: IntType}]);
    const holder = userType('Holder', [
      {name: 'point', type: point},
      {name: 'marker', type: IntType},
    ]);
    const receiver = name('this', point);
    const amount = name('amount', IntType);
    const inspect: ConstMethodIrFunc = {
      callMode: 'const-method',
      name: 'inspect',
      params: [amount],
      receiver,
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: {
        kind: IrKind.Binary,
        pos,
        type: IntType,
        qualifier: Qualifier.Series,
        op: IrOp.Add,
        x: field(read(receiver), 0, IntType),
        y: read(amount),
      },
    };
    const holderName = name('holder', holder);
    const resultName = name('result', IntType);
    const module = compile(
      program([
        write(holderName, {
          kind: IrKind.NewUserValue,
          pos,
          type: holder,
          qualifier: Qualifier.Series,
          userType: holder,
          args: [
            {
              kind: IrKind.NewUserValue,
              pos,
              type: point,
              qualifier: Qualifier.Series,
              userType: point,
              args: [constant(IntType, 1)],
              argumentEvaluationOrder: [0],
            },
            constant(IntType, 2),
          ],
          argumentEvaluationOrder: [0, 1],
        }),
        write(resultName, {
          kind: IrKind.CallConstMethod,
          pos,
          type: IntType,
          qualifier: Qualifier.Series,
          func: inspect,
          receiver: field(read(holderName), 0, point),
          slot: 0,
          args: [
            block(
              [update(holderName, [1], constant(IntType, 9))],
              constant(IntType, 5),
            ),
          ],
          argumentEvaluationOrder: [0],
        }),
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    const events: string[] = [];
    module.main(executionRuntime(frame, events) as never, frame as never);

    expect(frame.values[1]).toBe(6);
    const result = frame.values[0] as TestUserValue;
    expect((result.fields[0] as TestUserValue).fields).toEqual([1]);
    expect(result.fields[1]).toBe(9);
    const receiverRead = events.indexOf('field:2:0');
    const argumentWrite = events.indexOf('write-root:0', receiverRead + 1);
    const calleeReceiverWrite = events.indexOf('write-func:0');
    expect(receiverRead).toBeGreaterThanOrEqual(0);
    expect(receiverRead).toBeLessThan(argumentWrite);
    expect(argumentWrite).toBeLessThan(calleeReceiverWrite);
    expect(events.filter(event => event === 'write-root:0')).toHaveLength(2);
  });

  test('copies a mutable receiver before args and rebases copy-out afterward', () => {
    const point = userType('Point', [{name: 'x', type: IntType}]);
    const holder = userType('Holder', [
      {name: 'point', type: point},
      {name: 'sibling', type: IntType},
    ]);
    const receiver = name('self', point);
    const amount = name('amount', IntType);
    const mutate: MutableMethodIrFunc = {
      callMode: 'mutable-method',
      name: 'replaceX',
      params: [amount],
      receiver,
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: block(
        [update(receiver, [0], read(amount))],
        field(read(receiver), 0, IntType),
      ),
    };
    const holderName = name('holder', holder);
    const resultName = name('result', IntType);
    const module = compile(
      program([
        write(holderName, {
          kind: IrKind.NewUserValue,
          pos,
          type: holder,
          qualifier: Qualifier.Series,
          userType: holder,
          args: [
            {
              kind: IrKind.NewUserValue,
              pos,
              type: point,
              qualifier: Qualifier.Series,
              userType: point,
              args: [constant(IntType, 1)],
              argumentEvaluationOrder: [0],
            },
            constant(IntType, 2),
          ],
          argumentEvaluationOrder: [0, 1],
        }),
        write(resultName, {
          kind: IrKind.CallMutableMethod,
          pos,
          type: IntType,
          qualifier: Qualifier.Series,
          func: mutate,
          path: {root: holderName, fieldIndices: [0]},
          receiver: field(read(holderName), 0, point),
          slot: 0,
          args: [
            block(
              [update(holderName, [1], constant(IntType, 9))],
              constant(IntType, 5),
            ),
          ],
          argumentEvaluationOrder: [0],
        }),
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    const events: string[] = [];
    module.main(executionRuntime(frame, events) as never, frame as never);

    const result = frame.values[0] as TestUserValue;
    expect((result.fields[0] as TestUserValue).fields[0]).toBe(5);
    expect(result.fields[1]).toBe(9);
    expect(frame.values[1]).toBe(5);
    const receiverRead = events.indexOf('field:2:0');
    const argumentWrite = events.indexOf('write-root:0', 1);
    const calleeWrite = events.indexOf('write-func:0');
    expect(receiverRead).toBeGreaterThanOrEqual(0);
    expect(receiverRead).toBeLessThan(argumentWrite);
    expect(argumentWrite).toBeLessThan(calleeWrite);
  });

  test('rebases a nested mutable method through the outer hidden receiver', () => {
    const point = userType('Point', [{name: 'x', type: IntType}]);
    const holder = userType('Holder', [{name: 'point', type: point}]);
    const pointReceiver = name('pointThis', point);
    const pointAmount = name('pointAmount', IntType);
    const replaceX: MutableMethodIrFunc = {
      callMode: 'mutable-method',
      name: 'Point.replaceX',
      params: [pointAmount],
      receiver: pointReceiver,
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: block(
        [update(pointReceiver, [0], read(pointAmount))],
        field(read(pointReceiver), 0, IntType),
      ),
    };
    const holderReceiver = name('holderThis', holder);
    const holderAmount = name('holderAmount', IntType);
    const replacePointX: MutableMethodIrFunc = {
      callMode: 'mutable-method',
      name: 'Holder.replacePointX',
      params: [holderAmount],
      receiver: holderReceiver,
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: {
        kind: IrKind.CallMutableMethod,
        pos,
        type: IntType,
        qualifier: Qualifier.Series,
        func: replaceX,
        path: {root: holderReceiver, fieldIndices: [0]},
        receiver: field(read(holderReceiver), 0, point),
        slot: 0,
        args: [read(holderAmount)],
        argumentEvaluationOrder: [0],
      },
    };
    const rootName = name('holder', holder);
    const resultName = name('result', IntType);
    const module = compile(
      program([
        write(rootName, {
          kind: IrKind.NewUserValue,
          pos,
          type: holder,
          qualifier: Qualifier.Series,
          userType: holder,
          args: [
            {
              kind: IrKind.NewUserValue,
              pos,
              type: point,
              qualifier: Qualifier.Series,
              userType: point,
              args: [constant(IntType, 1)],
              argumentEvaluationOrder: [0],
            },
          ],
          argumentEvaluationOrder: [0],
        }),
        write(resultName, {
          kind: IrKind.CallMutableMethod,
          pos,
          type: IntType,
          qualifier: Qualifier.Series,
          func: replacePointX,
          path: {root: rootName, fieldIndices: []},
          receiver: read(rootName),
          slot: 0,
          args: [constant(IntType, 5)],
          argumentEvaluationOrder: [0],
        }),
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    module.main(executionRuntime(frame, []) as never, frame as never);

    const result = frame.values[0] as TestUserValue;
    expect((result.fields[0] as TestUserValue).fields).toEqual([5]);
    expect(frame.values[1]).toBe(5);
  });

  test('does not copy out a mutable receiver when the callee throws', () => {
    const arrayType: ArrayType = {kind: TypeKind.Array, elem: IntType};
    const holder = userType('Holder', [
      {name: 'values', type: arrayType},
      {name: 'marker', type: IntType},
    ]);
    const receiver = name('self', holder);
    const failing: MutableMethodIrFunc = {
      callMode: 'mutable-method',
      name: 'failing',
      params: [],
      receiver,
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: block(
        [
          update(receiver, [1], constant(IntType, 9)),
          {
            kind: IrKind.ExprStmt,
            pos,
            x: {
              kind: IrKind.MutateCollection,
              pos,
              type: VoidType,
              qualifier: Qualifier.Series,
              path: {root: receiver, fieldIndices: [0]},
              receiver: field(read(receiver), 0, arrayType),
              operation: 'array.set',
              args: [constant(IntType, 0), constant(IntType, 2)],
              argumentEvaluationOrder: [0, 1],
            },
          },
        ],
        field(read(receiver), 1, IntType),
      ),
    };
    const rootName = name('holder', holder);
    const arrayFrom: IrExpr = {
      kind: IrKind.CallNative,
      pos,
      type: arrayType,
      qualifier: Qualifier.Series,
      native: 'array.from',
      slot: null,
      args: [constant(IntType, 1)],
      argumentEvaluationOrder: [0],
    };
    const module = compile(
      program([
        write(rootName, {
          kind: IrKind.NewUserValue,
          pos,
          type: holder,
          qualifier: Qualifier.Series,
          userType: holder,
          args: [arrayFrom, constant(IntType, 1)],
          argumentEvaluationOrder: [0, 1],
        }),
        {
          kind: IrKind.ExprStmt,
          pos,
          x: {
            kind: IrKind.CallMutableMethod,
            pos,
            type: IntType,
            qualifier: Qualifier.Series,
            func: failing,
            path: {root: rootName, fieldIndices: []},
            receiver: read(rootName),
            slot: 0,
            args: [],
            argumentEvaluationOrder: [],
          },
        },
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    expect(() =>
      module.main(executionRuntime(frame, []) as never, frame as never),
    ).toThrow('unexpected mutation array.set');
    expect((frame.values[0] as TestUserValue).fields[1]).toBe(1);
  });
});
