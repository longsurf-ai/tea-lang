// Purpose: Walker tests — derived enumerations reach names, funcs, request edges, series inputs, builtins, and state counts through every reference path, counting shared objects once.

import {describe, expect, test} from 'vitest';
import {newFileBase, type Pos} from '../base/pos';
import {dumpProgram} from './dumper';
import {frameTopologyOf} from './frames';
import {
  DepthKind,
  CollectionLocationKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type CallConstMethodExpr,
  type CallFuncExpr,
  type CallMutableMethodExpr,
  type IrExpr,
  type Name,
} from './node';
import {
  MergeMode,
  type ConstMethodIrFunc,
  type BuiltinInput,
  type FreeIrFunc,
  type MutableMethodIrFunc,
  type Program,
  type RequestEdge,
  type SeriesInput,
} from './program';
import {
  BoolType,
  FloatType,
  IntType,
  Qualifier,
  StringType,
  TypeKind,
  type StructType,
} from './type';
import {
  builtinInputsOf,
  funcsOf,
  namesOf,
  requestsOf,
  seriesInputsOf,
  slotCountOf,
} from './visit';

const pos: Pos = {base: newFileBase('t.tea'), line: 1, col: 1};

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const CALL_MODE_TYPES: readonly [
  Same<CallFuncExpr['func'], FreeIrFunc>,
  Same<CallConstMethodExpr['func'], ConstMethodIrFunc>,
  Same<CallMutableMethodExpr['func'], MutableMethodIrFunc>,
] = [true, true, true];

const num = (value: number): IrExpr => ({
  kind: IrKind.Const,
  pos,
  type: FloatType,
  qualifier: Qualifier.Const,
  value,
});

const bool = (value: boolean): IrExpr => ({
  kind: IrKind.Const,
  pos,
  type: BoolType,
  qualifier: Qualifier.Const,
  value,
});

const int = (value: number): IrExpr => ({
  kind: IrKind.Const,
  pos,
  type: IntType,
  qualifier: Qualifier.Const,
  value,
});

const text = (value: string): IrExpr => ({
  kind: IrKind.Const,
  pos,
  type: StringType,
  qualifier: Qualifier.Const,
  value,
});

const close: SeriesInput = {
  id: 'close',
  type: FloatType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.Const, bars: 2},
};

const barIndex: BuiltinInput = {
  source: {domain: 'bar', field: 'bar_index'},
  type: IntType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.Const, bars: 1},
};

const x: Name = {
  name: 'x',
  storage: Storage.PerBar,
  type: FloatType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.None},
};

const p: Name = {
  name: 'p',
  storage: Storage.PerBar,
  type: FloatType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.None},
};

const inc: FreeIrFunc = {
  callMode: 'free',
  name: 'inc',
  params: [p],
  locals: [],
  resultType: FloatType,
  resultQualifier: Qualifier.Series,
  body: {
    kind: IrKind.Binary,
    pos,
    type: FloatType,
    qualifier: Qualifier.Series,
    op: IrOp.Add,
    x: {
      kind: IrKind.HistRead,
      pos,
      type: FloatType,
      qualifier: Qualifier.Series,
      place: {kind: PlaceKind.Name, name: p},
      offset: null,
    },
    y: num(1),
  },
};

const childResult: Name = {
  name: 'r',
  storage: Storage.PerBar,
  type: FloatType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.None},
};

const child: Program = {
  version: 1,
  params: [],
  requests: [],
  outputs: [],
  effects: [],
  packageGlobals: [],
  init: [],
  body: [],
};

const edge: RequestEdge = {
  pos,
  name: 'requested',
  symbol: {
    kind: IrKind.Const,
    pos,
    type: StringType,
    qualifier: Qualifier.Simple,
    value: 'AAPL',
  },
  timeframe: {
    kind: IrKind.Const,
    pos,
    type: StringType,
    qualifier: Qualifier.Simple,
    value: 'D',
  },
  contextArgumentEvaluationOrder: [0, 1],
  optionArgumentEvaluationOrder: [0, 1, 2, 3],
  merge: {
    mode: MergeMode.Sample,
    availability: text('end'),
    fill: text('carry'),
    ignoreInvalidSymbol: bool(false),
    calcBarsCount: int(0),
  },
  resultName: childResult,
  captureType: FloatType,
  resultType: FloatType,
  dynamic: false,
  depth: {kind: DepthKind.None},
  child,
};

const program: Program = {
  version: 1,
  params: [],
  requests: [edge],
  outputs: [],
  effects: [],
  packageGlobals: [],
  init: [],
  body: [
    {
      kind: IrKind.WriteName,
      pos,
      name: x,
      value: {
        kind: IrKind.CallFunc,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        func: inc,
        slot: 0,
        args: [
          {
            kind: IrKind.HistRead,
            pos,
            type: FloatType,
            qualifier: Qualifier.Series,
            place: {kind: PlaceKind.Series, series: close},
            offset: num(1),
          },
        ],
        argumentEvaluationOrder: [0],
      },
    },
    {
      kind: IrKind.ExprStmt,
      pos,
      x: {
        kind: IrKind.HistRead,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        place: {kind: PlaceKind.Request, request: edge},
        offset: null,
      },
    },
    {
      kind: IrKind.ExprStmt,
      pos,
      x: {
        kind: IrKind.HistRead,
        pos,
        type: IntType,
        qualifier: Qualifier.Series,
        place: {kind: PlaceKind.Builtin, builtin: barIndex},
        offset: int(1),
      },
    },
  ],
};

const bindOnlyProgram: Program = {
  version: 1,
  params: [],
  requests: [],
  outputs: [
    {
      effect: 'plot',
      staticArgs: [],
      bindArgs: [
        {
          name: 'linewidth',
          expr: {
            kind: IrKind.CallFunc,
            pos,
            type: FloatType,
            qualifier: Qualifier.Series,
            func: inc,
            slot: 0,
            args: [num(1)],
            argumentEvaluationOrder: [0],
          },
        },
      ],
      bindArgumentEvaluationOrder: [0],
      channels: [],
    },
  ],
  effects: [],
  packageGlobals: [],
  init: [],
  body: [],
};

const holder: StructType = {
  kind: TypeKind.Struct,
  name: 'Holder',
  fields: [
    {name: 'value', type: FloatType},
    {name: 'values', type: {kind: TypeKind.Array, elem: FloatType}},
  ],
};

const holderName: Name = {
  name: 'holder',
  storage: Storage.PerBar,
  type: holder,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.None},
};

const receiver: Name = {
  name: 'receiver',
  storage: Storage.PerBar,
  type: holder,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.None},
};

const mutate: MutableMethodIrFunc = {
  callMode: 'mutable-method',
  name: 'mutate',
  params: [],
  receiver,
  locals: [],
  resultType: FloatType,
  resultQualifier: Qualifier.Series,
  body: num(0),
};

const mutationProgram: Program = {
  version: 1,
  params: [],
  requests: [],
  outputs: [],
  effects: [],
  packageGlobals: [],
  init: [],
  body: [
    {
      kind: IrKind.StoreField,
      pos,
      object: {
        kind: IrKind.HistRead,
        pos,
        type: holder,
        qualifier: Qualifier.Series,
        place: {kind: PlaceKind.Name, name: holderName},
        offset: null,
      },
      owner: holder,
      fieldIndex: 0,
      value: num(2),
    },
    {
      kind: IrKind.ExprStmt,
      pos,
      x: {
        kind: IrKind.MutateCollection,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        location: {
          kind: CollectionLocationKind.StructField,
          object: {
            kind: IrKind.HistRead,
            pos,
            type: holder,
            qualifier: Qualifier.Series,
            place: {kind: PlaceKind.Name, name: holderName},
            offset: null,
          },
          owner: holder,
          fieldIndex: 1,
        },
        operation: 'array.pop',
        args: [],
        argumentEvaluationOrder: [],
      },
    },
    {
      kind: IrKind.ExprStmt,
      pos,
      x: {
        kind: IrKind.CallMutableMethod,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        func: mutate,
        receiver: {
          kind: IrKind.HistRead,
          pos,
          type: holder,
          qualifier: Qualifier.Series,
          place: {kind: PlaceKind.Name, name: holderName},
          offset: null,
        },
        slot: 2,
        argumentEvaluationOrder: [],
        args: [],
      },
    },
  ],
};

describe('derived enumerations', () => {
  test('one topology owns frame names and call-site children for every target', () => {
    const topology = frameTopologyOf(program);
    expect(topology.frames).toHaveLength(2);
    expect(topology.root.locals).toEqual([x]);
    expect(topology.root.children).toEqual([
      {slot: 0, callee: inc, frameId: 1},
    ]);
    expect(topology.frameByFunc.get(inc)?.locals).toEqual([p]);
    expect(topology.nameLocations.get(x)).toEqual({frameId: 0, slot: 0});
    expect(topology.nameLocations.get(p)).toEqual({frameId: 1, slot: 0});
  });

  test('root topology includes bind-only call sites', () => {
    const topology = frameTopologyOf(bindOnlyProgram);
    expect(topology.root.children).toEqual([
      {slot: 0, callee: inc, frameId: 1},
    ]);
  });

  test('call kinds admit only their matching function mode', () => {
    expect(CALL_MODE_TYPES).toEqual([true, true, true]);
  });

  test('names reach through writes, places, and function params', () => {
    expect(namesOf(program)).toEqual([x, p]);
  });

  test('funcs, requests, series, and builtins are each counted once', () => {
    expect(funcsOf(program)).toEqual([inc]);
    expect(requestsOf(program)).toEqual([edge]);
    expect(seriesInputsOf(program)).toEqual([close]);
    expect(builtinInputsOf(program)).toEqual([barIndex]);
    expect(dumpProgram(program)).toContain(
      'builtin bar.bar_index: series int depth=const(1)',
    );
  });

  test('slot count derives from the maximum minted id', () => {
    expect(slotCountOf(program)).toBe(1);
  });

  test('the child program does not leak into the parent enumeration', () => {
    expect(namesOf(program)).not.toContain(childResult);
    expect(requestsOf(child)).toEqual([]);
  });

  test('field stores, collection locations, and mutable method calls expose ownership', () => {
    expect(namesOf(mutationProgram)).toEqual([holderName, receiver]);
    expect(funcsOf(mutationProgram)).toEqual([mutate]);
    expect(slotCountOf(mutationProgram)).toBe(3);
    expect(dumpProgram(mutationProgram)).toContain('StoreField Holder[0]');
    expect(dumpProgram(mutationProgram)).toContain(
      'MutateCollection array.pop location=Holder[1]',
    );
    expect(dumpProgram(mutationProgram)).toContain(
      'CallMutableMethod mutate slot=2',
    );
  });
});
