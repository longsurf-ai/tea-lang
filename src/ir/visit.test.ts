// Purpose: Walker tests — derived enumerations reach names, funcs, request edges, series inputs, and state counts through every reference path, counting shared objects once.

import {describe, expect, test} from 'bun:test';
import {newFileBase, type Pos} from '../base/pos';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type IrExpr,
  type Name,
} from './node';
import {
  MergeMode,
  type IrFunc,
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

const inc: IrFunc = {
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

describe('derived enumerations', () => {
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
});
