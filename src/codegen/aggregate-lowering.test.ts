import {Module} from '../runtime/module-binding';
// Purpose: Aggregate codegen contract tests — layouts, reference field stores, and collection locations preserve exact types and evaluation order.

import {describe, expect, test} from 'vitest';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type BlockExpr,
  type ConstExpr,
  type HistReadExpr,
  type SelectorExpr,
  type ReadExpr,
  type WritableExpr,
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

import {loadModule} from '../runtime/load';
import {unwrap, type Value} from '../runtime/js/value';
import {Context} from '../runtime/js/context';
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

function read(target: Name): ReadExpr & WritableExpr {
  return {
    kind: IrKind.Read,
    pos,
    type: target.type,
    qualifier: target.qualifier,
    place: {kind: PlaceKind.Name, name: target},
  };
}

function readAt(target: Name, offset: number): HistReadExpr {
  return {
    ...read(target),
    kind: IrKind.HistRead,
    offset: constant(IntType, offset),
  };
}

function field(x: IrExpr, fieldIndex: number, type: Type): SelectorExpr {
  return {
    kind: IrKind.Selector,
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
  return {kind: IrKind.Assign, pos, target: read(target), value, op: null};
}

function storeField(
  object: IrExpr,
  owner: StructType,
  fieldIndex: number,
  value: IrExpr,
): IrStmt {
  return {
    kind: IrKind.Assign,
    pos,
    target: field(object, fieldIndex, owner.fields[fieldIndex].type),
    value,
    op: null,
  };
}

function program(body: readonly IrStmt[]): Program {
  return {
    version: 1,
    nominalIds: new Map(),
    params: [],
    requests: [],
    outputs: [],
    packageGlobals: [],
    init: [],
    body,
  };
}

function compile(ir: Program): Module & {
  readonly abi: number;
} {
  const js = generate(ir);
  return loadModule(js) as Module & {
    readonly abi: number;
  };
}

function structType(name: string, fields: readonly StructField[]): StructType {
  return {kind: TypeKind.Struct, name, fields};
}

interface TestStructValue {
  readonly fields: unknown[];
}

interface TestCollectionValue {
  readonly values: readonly unknown[];
}

interface TestFrame {
  readonly values: unknown[];
  readonly subs: Map<number, TestFrame>;
}

// Execute actual generated code and storage; only observe method order and values.
function execute(module: Module, root: TestFrame, events: string[]): void {
  const instrumented = new Module(module, context => {
    const step = context.storage;
    const write = step.write.bind(step);
    step.write = (frame, slot, value) => {
      events.push(
        frame === step.rootFrame ? `write-root:${slot}` : `write-func:${slot}`,
      );
      write(frame, slot, value);
    };
    const field = step.structField.bind(step);
    step.structField = (value, ctor, name, empty) => {
      events.push(`field:${name}`);
      return field(value, ctor, name, empty);
    };
    const store = step.storeStructField.bind(step);
    step.storeStructField = (value, ctor, name, replacement) => {
      events.push(`store:${name}`);
      store(value, ctor, name, replacement);
    };
    const call = step.callCollection.bind(step);
    step.callCollection = (operation, empty, args) => {
      events.push(`call:${operation}`);
      return call(operation, empty, args);
    };
    const mutate = step.mutateCollection.bind(step);
    step.mutateCollection = (operation, receiver, args) => {
      events.push(`mutate:${operation}`);
      return mutate(operation, receiver, args);
    };
    const snapshot = (value: Value<unknown>): unknown => {
      const raw = unwrap(value);
      if (raw === null) return null;
      if (value.ctor !== undefined) {
        const defaults = Reflect.construct(value.ctor, []) as Record<
          string,
          Value<unknown>
        >;
        return {
          fields: Object.entries(defaults).map(([name, empty]) =>
            snapshot(step.structField(raw, value.ctor!, name, empty)),
          ),
        };
      }
      if (value.kind === 'array') {
        return {
          values: (
            step.collectionEntries(raw) as readonly Value<unknown>[]
          ).map(snapshot),
        };
      }
      return raw;
    };
    try {
      module.main(context);
    } finally {
      root.values.splice(
        0,
        root.values.length,
        ...module.state.frames[0].locals.map((local, slot) =>
          snapshot(
            local.empty.withStored(step.read(step.rootFrame, slot, 0), context),
          ),
        ),
      );
    }
  });
  const context = new Context(instrumented.bind());
  try {
    context.step({series: [], builtins: [], requests: [], provisional: false});
  } finally {
    context.dispose();
  }
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
    execute(module, frame, []);

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
    execute(module, frame, []);

    expect((frame.values[0] as TestStructValue).fields).toEqual([5, 9]);
    expect(frame.values[1]).toBe(9);
  });

  test('uses typed collection results and a captured field location after argument writes', () => {
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
      native: {
        name: 'array.from',
        argTypes: [IntType],
        resultType: arrayType,
        effect: 'allocate',
      },
      receiver: null,
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
          kind: IrKind.CallNative,
          pos,
          type: VoidType,
          qualifier: Qualifier.Series,
          receiver: field(read(holderName), 0, arrayType),
          native: {
            name: 'array.push',
            argTypes: [IntType],
            resultType: VoidType,
            effect: 'write',
          },
          args: [
            block(
              [storeField(read(holderName), holder, 1, constant(IntType, 9))],
              constant(IntType, 2),
            ),
          ],
          argumentEvaluationOrder: [0],
        },
        write(size, {
          kind: IrKind.CallNative,
          pos,
          type: IntType,
          qualifier: Qualifier.Series,
          native: {
            name: 'array.size',
            argTypes: [arrayType],
            resultType: IntType,
            effect: 'read',
          },
          receiver: null,
          args: [field(read(holderName), 0, arrayType)],
          argumentEvaluationOrder: [0],
        }),
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    const events: string[] = [];
    execute(module, frame, events);

    const result = frame.values[0] as TestStructValue;
    expect((result.fields[0] as TestCollectionValue).values).toEqual([1, 2]);
    expect(result.fields[1]).toBe(9);
    expect(frame.values[1]).toBe(2);
    expect(events).toContain('call:array.from');
    expect(events).toContain('call:array.size');
    const receiverRead = events.indexOf('field:values');
    const argumentWrite = events.indexOf('store:marker', receiverRead + 1);
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
        kind: IrKind.CallFunc,
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
    execute(module, frame, events);

    expect(frame.values[1]).toBe(6);
    const result = frame.values[0] as TestStructValue;
    expect((result.fields[0] as TestStructValue).fields).toEqual([1]);
    expect(result.fields[1]).toBe(9);
    const receiverRead = events.indexOf('field:point');
    const argumentWrite = events.indexOf('store:marker', receiverRead + 1);
    expect(receiverRead).toBeGreaterThanOrEqual(0);
    expect(receiverRead).toBeLessThan(argumentWrite);
    expect(events).not.toContain('write-func:0');
    expect(events.filter(event => event === 'write-root:0')).toHaveLength(1);
    expect(js).not.toMatch(/ctx\.write\(fr, \d+, p\d+\)/);
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
        kind: IrKind.CallFunc,
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
    execute(module, frame, events);

    const result = frame.values[0] as TestStructValue;
    expect((result.fields[0] as TestStructValue).fields[0]).toBe(5);
    expect(result.fields[1]).toBe(9);
    expect(frame.values[1]).toBe(5);
    const receiverRead = events.indexOf('field:point');
    const argumentWrite = events.indexOf('store:sibling');
    const receiverWrite = events.indexOf('store:x', argumentWrite + 1);
    expect(receiverRead).toBeGreaterThanOrEqual(0);
    expect(receiverRead).toBeLessThan(argumentWrite);
    expect(argumentWrite).toBeLessThan(receiverWrite);
    expect(events).not.toContain('write-func:0');
    expect(js).not.toMatch(/ctx\.write\(fr, \d+, p\d+\)/);
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
        kind: IrKind.CallFunc,
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
    execute(module, frame, []);

    expect((frame.values[0] as TestStructValue).fields).toEqual([5]);
    expect(frame.values[1]).toBe(5);
    expect(js).not.toMatch(/ctx\.write\(fr, \d+, p\d+\)/);
    expect(js).toContain('amount = (');
    expect(js).toContain('.require()');
    expect(js).toContain('.field("x")');
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
          receiver: null,
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

    expect(js).toContain('frame.locals.source.set(p0_source);');
    expect(js).toContain('frame.locals.source.hist((int(1)).value)');
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
        kind: IrKind.CallFunc,
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
        kind: IrKind.CallFunc,
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
    execute(module, frame, []);

    expect(js).not.toContain('rebuild');
    expect(js).toContain('.field("x")');
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
            kind: IrKind.CallNative,
            pos,
            type: VoidType,
            qualifier: Qualifier.Series,
            receiver: field(read(receiver), 0, arrayType),
            native: {
              name: 'array.set',
              argTypes: [IntType, IntType],
              resultType: VoidType,
              effect: 'write',
            },
            args: [constant(IntType, 99), constant(IntType, 2)],
            argumentEvaluationOrder: [0, 1],
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
      native: {
        name: 'array.from',
        argTypes: [IntType],
        resultType: arrayType,
        effect: 'allocate',
      },
      receiver: null,
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
          kind: IrKind.CallFunc,
          pos,
          type: IntType,
          qualifier: Qualifier.Series,
          func: failing,
          receiver: read(rootName),
          slot: 0,
          args: [],
          argumentEvaluationOrder: [],
        },
      ]),
    );
    const frame: TestFrame = {values: [], subs: new Map()};
    expect(() => execute(module, frame, [])).toThrow(/outside/);
    // Observe the pending write before the bounds failure unwinds execution.
    // The real Context aborts the Heap transaction after this observation.
    expect((frame.values[0] as TestStructValue).fields[1]).toBe(9);
  });
});
