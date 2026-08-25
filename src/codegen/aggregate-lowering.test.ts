// Purpose: Aggregate codegen contract tests — layouts, reference field stores, and collection locations preserve exact types and evaluation order.

import {describe, expect, test} from 'vitest';
import {
  CollectionLocationKind,
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
  FreeIrFunc,
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
  type StructField,
  type StructType,
} from '../ir/type';
import type {JSModule} from '../runtime/abi';
import {loadModule} from '../runtime/load';
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

function readAt(target: Name, offset: number): HistReadExpr {
  return {
    ...read(target),
    offset: constant(IntType, offset),
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

function compile(ir: Program): JSModule & {
  readonly abi: number;
} {
  const js = generate(ir);
  return loadModule(js) as JSModule & {
    readonly abi: number;
  };
}

function structType(name: string, fields: readonly StructField[]): StructType {
  return {kind: TypeKind.Struct, name, fields};
}

interface TestStructValue {
  readonly kind: 'storage-ref';
  readonly layout: number;
  readonly fields: unknown[];
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
  const isStruct = (value: unknown): value is TestStructValue =>
    typeof value === 'object' &&
    value !== null &&
    (value as {kind?: unknown}).kind === 'storage-ref';
  const requireStruct = (value: unknown, layout: number): TestStructValue => {
    events.push(`require:${layout}`);
    if (!isStruct(value) || value.layout !== layout) {
      throw new Error('invalid struct reference');
    }
    return value;
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
    newStruct: (
      layout: number,
      fields: readonly unknown[],
    ): TestStructValue => ({
      kind: 'storage-ref',
      layout,
      fields: [...fields],
    }),
    requireStruct,
    structField: (value: unknown, layout: number, index: number) => {
      events.push(`field:${layout}:${index}`);
      return requireStruct(value, layout).fields[index];
    },
    storeStructField: (
      value: unknown,
      layout: number,
      fieldIndex: number,
      replacement: unknown,
    ) => {
      events.push(`store:${layout}:${fieldIndex}`);
      requireStruct(value, layout).fields[fieldIndex] = replacement;
    },
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

describe('aggregate expression and reference-store lowering', () => {
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
    expect(Number.isNaN(frame.values[1] as number)).toBe(true);
  });

  test('constructs, reads, and stores through a captured reference after RHS writes', () => {
    const pair = structType('Pair', [
      {name: 'left', type: IntType},
      {name: 'right', type: IntType},
    ]);
    const rootName = name('pair', pair);
    const observed = name('observed', IntType);
    const module = compile(
      program([
        write(rootName, {
          kind: IrKind.NewStruct,
          pos,
          type: pair,
          qualifier: Qualifier.Series,
          structType: pair,
          args: [constant(IntType, 1), constant(IntType, 2)],
          argumentEvaluationOrder: [0, 1],
        }),
        storeField(
          read(rootName),
          pair,
          0,
          block(
            [storeField(read(rootName), pair, 1, constant(IntType, 9))],
            constant(IntType, 5),
          ),
        ),
        write(observed, field(read(rootName), 1, IntType)),
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    module.main(executionRuntime(frame, []) as never, frame as never);

    expect((frame.values[0] as TestStructValue).fields).toEqual([5, 9]);
    expect(frame.values[1]).toBe(9);
  });

  test('uses collection result layouts and a captured field location after argument writes', () => {
    const arrayType: ArrayType = {kind: TypeKind.Array, elem: IntType};
    const holder = structType('Holder', [
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
          kind: IrKind.NewStruct,
          pos,
          type: holder,
          qualifier: Qualifier.Series,
          structType: holder,
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
            location: {
              kind: CollectionLocationKind.StructField,
              object: read(holderName),
              owner: holder,
              fieldIndex: 0,
            },
            operation: 'array.push',
            args: [
              block(
                [storeField(read(holderName), holder, 1, constant(IntType, 9))],
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

    const result = frame.values[0] as TestStructValue;
    expect((result.fields[0] as TestCollectionValue).values).toEqual([1, 2]);
    expect(result.fields[1]).toBe(9);
    expect(frame.values[1]).toBe(2);
    expect(events).toContain('call:array.from:0');
    expect(events).toContain('call:array.size:1');
    const receiverRead = events.indexOf('field:2:0');
    const argumentWrite = events.indexOf('store:2:1', receiverRead + 1);
    expect(receiverRead).toBeLessThan(argumentWrite);
    expect(argumentWrite).toBeLessThan(events.indexOf('mutate:array.push'));
  });

  test('evaluates a const-method receiver before explicit arguments without writeback', () => {
    const point = structType('Point', [{name: 'x', type: IntType}]);
    const holder = structType('Holder', [
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
    const ir = program([
      write(holderName, {
        kind: IrKind.NewStruct,
        pos,
        type: holder,
        qualifier: Qualifier.Series,
        structType: holder,
        args: [
          {
            kind: IrKind.NewStruct,
            pos,
            type: point,
            qualifier: Qualifier.Series,
            structType: point,
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
            [storeField(read(holderName), holder, 1, constant(IntType, 9))],
            constant(IntType, 5),
          ),
        ],
        argumentEvaluationOrder: [0],
      }),
    ]);
    const js = generate(ir);
    const module = compile(ir);
    const frame: TestFrame = {values: [], subs: new Map()};
    const events: string[] = [];
    module.main(executionRuntime(frame, events) as never, frame as never);

    expect(frame.values[1]).toBe(6);
    const result = frame.values[0] as TestStructValue;
    expect((result.fields[0] as TestStructValue).fields).toEqual([1]);
    expect(result.fields[1]).toBe(9);
    const receiverRead = events.indexOf('field:2:0');
    const argumentWrite = events.indexOf('store:2:1', receiverRead + 1);
    expect(receiverRead).toBeGreaterThanOrEqual(0);
    expect(receiverRead).toBeLessThan(argumentWrite);
    expect(events).not.toContain('write-func:0');
    expect(events.filter(event => event === 'write-root:0')).toHaveLength(1);
    expect(js).not.toMatch(/rt\.write\(fr, \d+, p\d+\)/);
  });

  test('captures a mutable receiver before args and shares in-place field writes', () => {
    const point = structType('Point', [{name: 'x', type: IntType}]);
    const holder = structType('Holder', [
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
        [storeField(read(receiver), point, 0, read(amount))],
        field(read(receiver), 0, IntType),
      ),
    };
    const holderName = name('holder', holder);
    const resultName = name('result', IntType);
    const ir = program([
      write(holderName, {
        kind: IrKind.NewStruct,
        pos,
        type: holder,
        qualifier: Qualifier.Series,
        structType: holder,
        args: [
          {
            kind: IrKind.NewStruct,
            pos,
            type: point,
            qualifier: Qualifier.Series,
            structType: point,
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
        receiver: field(read(holderName), 0, point),
        slot: 0,
        args: [
          block(
            [storeField(read(holderName), holder, 1, constant(IntType, 9))],
            constant(IntType, 5),
          ),
        ],
        argumentEvaluationOrder: [0],
      }),
    ]);
    const js = generate(ir);
    const module = compile(ir);
    const frame: TestFrame = {values: [], subs: new Map()};
    const events: string[] = [];
    module.main(executionRuntime(frame, events) as never, frame as never);

    const result = frame.values[0] as TestStructValue;
    expect((result.fields[0] as TestStructValue).fields[0]).toBe(5);
    expect(result.fields[1]).toBe(9);
    expect(frame.values[1]).toBe(5);
    const receiverRead = events.indexOf('field:2:0');
    const argumentWrite = events.indexOf('store:2:1');
    const receiverWrite = events.indexOf('store:0:0', argumentWrite + 1);
    expect(receiverRead).toBeGreaterThanOrEqual(0);
    expect(receiverRead).toBeLessThan(argumentWrite);
    expect(argumentWrite).toBeLessThan(receiverWrite);
    expect(events).not.toContain('write-func:0');
    expect(js).not.toMatch(/rt\.write\(fr, \d+, p\d+\)/);
  });

  test('keeps history-free formal zero reads, reassignment, and receiver updates in JS locals', () => {
    const point = structType('Point', [{name: 'x', type: IntType}]);
    const receiver = name('self', point);
    const amount = name('amount', IntType);
    const bump: MutableMethodIrFunc = {
      callMode: 'mutable-method',
      name: 'bump',
      params: [amount],
      receiver,
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: block(
        [
          write(amount, {
            kind: IrKind.Binary,
            pos,
            type: IntType,
            qualifier: Qualifier.Series,
            op: IrOp.Add,
            x: readAt(amount, 0),
            y: constant(IntType, 1),
          }),
          storeField(read(receiver), point, 0, read(amount)),
        ],
        field(read(receiver), 0, IntType),
      ),
    };
    const pointName = name('point', point);
    const resultName = name('result', IntType);
    const ir = program([
      write(pointName, {
        kind: IrKind.NewStruct,
        pos,
        type: point,
        qualifier: Qualifier.Series,
        structType: point,
        args: [constant(IntType, 1)],
        argumentEvaluationOrder: [0],
      }),
      write(resultName, {
        kind: IrKind.CallMutableMethod,
        pos,
        type: IntType,
        qualifier: Qualifier.Series,
        func: bump,
        receiver: read(pointName),
        slot: 0,
        args: [constant(IntType, 4)],
        argumentEvaluationOrder: [0],
      }),
    ]);
    const js = generate(ir);
    const module = compile(ir);
    const frame: TestFrame = {values: [], subs: new Map()};
    module.main(executionRuntime(frame, []) as never, frame as never);

    expect((frame.values[0] as TestStructValue).fields).toEqual([5]);
    expect(frame.values[1]).toBe(5);
    expect(js).not.toMatch(/rt\.write\(fr, \d+, p\d+\)/);
    expect(js).toContain('p1 = (');
    expect(js).toMatch(/rt\.requireStruct\(\(t\d+\), 0\)/);
    expect(js).toContain('rt.storeStructField((');
    expect(js).not.toContain('return {receiver:');
  });

  test('keeps a history-bearing function formal in checked state', () => {
    const source = name('source', IntType);
    source.depth = {kind: DepthKind.Const, bars: 1};
    const previous: FreeIrFunc = {
      callMode: 'free',
      name: 'previous',
      params: [source],
      locals: [],
      resultType: IntType,
      resultQualifier: Qualifier.Series,
      body: readAt(source, 1),
    };
    const result = name('result', IntType);
    const js = generate(
      program([
        write(result, {
          kind: IrKind.CallFunc,
          pos,
          type: IntType,
          qualifier: Qualifier.Series,
          func: previous,
          slot: 0,
          args: [constant(IntType, 4)],
          argumentEvaluationOrder: [0],
        }),
      ]),
    );

    expect(js).toContain('rt.write(fr, 0, p0);');
    expect(js).toContain('rt.read(fr, 0, t0)');
  });

  test('shares a nested mutable method receiver through the outer receiver', () => {
    const point = structType('Point', [{name: 'x', type: IntType}]);
    const holder = structType('Holder', [{name: 'point', type: point}]);
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
        [storeField(read(pointReceiver), point, 0, read(pointAmount))],
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
        receiver: field(read(holderReceiver), 0, point),
        slot: 0,
        args: [read(holderAmount)],
        argumentEvaluationOrder: [0],
      },
    };
    const rootName = name('holder', holder);
    const resultName = name('result', IntType);
    const ir = program([
      write(rootName, {
        kind: IrKind.NewStruct,
        pos,
        type: holder,
        qualifier: Qualifier.Series,
        structType: holder,
        args: [
          {
            kind: IrKind.NewStruct,
            pos,
            type: point,
            qualifier: Qualifier.Series,
            structType: point,
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
        receiver: read(rootName),
        slot: 0,
        args: [constant(IntType, 5)],
        argumentEvaluationOrder: [0],
      }),
    ]);
    const js = generate(ir);
    const module = compile(ir);
    const frame: TestFrame = {values: [], subs: new Map()};
    module.main(executionRuntime(frame, []) as never, frame as never);

    expect(js).not.toContain('rebuild');
    expect(js).toContain('rt.storeStructField((');
    const result = frame.values[0] as TestStructValue;
    expect((result.fields[0] as TestStructValue).fields).toEqual([5]);
    expect(frame.values[1]).toBe(5);
  });

  test('leaves rollback of in-place method writes to the runtime transaction', () => {
    const arrayType: ArrayType = {kind: TypeKind.Array, elem: IntType};
    const holder = structType('Holder', [
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
          storeField(read(receiver), holder, 1, constant(IntType, 9)),
          {
            kind: IrKind.ExprStmt,
            pos,
            x: {
              kind: IrKind.MutateCollection,
              pos,
              type: VoidType,
              qualifier: Qualifier.Series,
              location: {
                kind: CollectionLocationKind.StructField,
                object: read(receiver),
                owner: holder,
                fieldIndex: 0,
              },
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
          kind: IrKind.NewStruct,
          pos,
          type: holder,
          qualifier: Qualifier.Series,
          structType: holder,
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
    // This minimal ABI mock has no HeapTransaction. Generated code performs
    // the in-place store before the later throw; the real StructStorageRuntime
    // stages a whole replacement payload that abort can discard.
    expect((frame.values[0] as TestStructValue).fields[1]).toBe(9);
  });
});
