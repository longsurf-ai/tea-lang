// Purpose: Walker tests — derived enumerations reach names, funcs, request edges, series inputs, and state counts through every reference path, counting shared objects once.

import {describe, expect, test} from 'bun:test';
import {newFileBase, type Pos} from '../base/pos';
import {dumpProgram} from './dumper';
import {
  DepthKind,
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
  type FreeIrFunc,
  type MutableMethodIrFunc,
  type Program,
  type RequestEdge,
  type SeriesInput,
} from './program';
import {FloatType, Qualifier, StringType} from './type';
import {
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

const close: SeriesInput = {
  id: 'close',
  type: FloatType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.Const, bars: 2},
};

const x: Name = {
  name: 'x',
  storage: Storage.PerBar,
  type: FloatType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.None},
  init: null,
};

const p: Name = {
  name: 'p',
  storage: Storage.PerBar,
  type: FloatType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.None},
  init: null,
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
  init: null,
};

const child: Program = {
  version: 1,
  params: [],
  requests: [],
  outputs: [],
  init: [],
  body: [],
};

const edge: RequestEdge = {
  pos,
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
  merge: {
    mode: MergeMode.Sample,
    gaps: false,
    lookahead: false,
    ignoreInvalidSymbol: false,
    currency: null,
    calcBarsCount: null,
  },
  resultName: childResult,
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
  ],
};

const receiver: Name = {
  name: 'receiver',
  storage: Storage.PerBar,
  type: FloatType,
  qualifier: Qualifier.Series,
  depth: {kind: DepthKind.None},
  init: null,
};

const mutate: MutableMethodIrFunc = {
  callMode: 'mutable-method',
  name: 'mutate',
  params: [],
  receiver,
  locals: [],
  resultType: FloatType,
  resultQualifier: Qualifier.Series,
  body: {
    kind: IrKind.HistRead,
    pos,
    type: FloatType,
    qualifier: Qualifier.Series,
    place: {kind: PlaceKind.Name, name: receiver},
    offset: null,
  },
};

const mutationProgram: Program = {
  version: 1,
  params: [],
  requests: [],
  outputs: [],
  init: [],
  body: [
    {
      kind: IrKind.UpdateValuePath,
      pos,
      path: {root: x, fieldIndices: [0]},
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
        path: {root: x, fieldIndices: [1]},
        receiver: {
          kind: IrKind.HistRead,
          pos,
          type: FloatType,
          qualifier: Qualifier.Series,
          place: {kind: PlaceKind.Name, name: x},
          offset: null,
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
        path: {root: x, fieldIndices: []},
        receiver: {
          kind: IrKind.HistRead,
          pos,
          type: FloatType,
          qualifier: Qualifier.Series,
          place: {kind: PlaceKind.Name, name: x},
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
  test('call kinds admit only their matching function mode', () => {
    expect(CALL_MODE_TYPES).toEqual([true, true, true]);
  });

  test('names reach through writes, places, and function params', () => {
    expect(namesOf(program)).toEqual([x, p]);
  });

  test('funcs, requests, and series inputs are each counted once', () => {
    expect(funcsOf(program)).toEqual([inc]);
    expect(requestsOf(program)).toEqual([edge]);
    expect(seriesInputsOf(program)).toEqual([close]);
  });

  test('slot count derives from the maximum minted id', () => {
    expect(slotCountOf(program)).toBe(1);
  });

  test('the child program does not leak into the parent enumeration', () => {
    expect(namesOf(program)).not.toContain(childResult);
    expect(requestsOf(child)).toEqual([]);
  });

  test('rooted update, collection mutation, and mutable method calls expose ownership', () => {
    expect(namesOf(mutationProgram)).toEqual([x, receiver]);
    expect(funcsOf(mutationProgram)).toEqual([mutate]);
    expect(slotCountOf(mutationProgram)).toBe(3);
    expect(dumpProgram(mutationProgram)).toContain('UpdateValuePath x[0]');
    expect(dumpProgram(mutationProgram)).toContain(
      'MutateCollection array.pop path=x[1]',
    );
    expect(dumpProgram(mutationProgram)).toContain(
      'CallMutableMethod mutate path=x slot=2',
    );
  });
});
