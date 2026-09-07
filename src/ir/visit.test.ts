// Purpose: Walker tests — derived enumerations reach names, funcs, request edges, series inputs, builtins, and state counts through every reference path, counting shared objects once.

import {describe, expect, test} from 'vitest';
import {newFileBase, type Pos} from '../base/pos';
import {dumpProgram} from './dumper';
import {frameTopologyOf} from './frames';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type CallFuncExpr,
  type BlockExpr,
  type WritableExpr,
  type IrExpr,
  type IrStmt,
  type Name,
} from './node';
import {
  MergeMode,
  type IrFunc,
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
  walkIrStmt,
} from './visit';

const pos: Pos = {base: newFileBase('t.tea'), line: 1, col: 1};

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const CALL_MODE_TYPES: readonly [Same<CallFuncExpr['func'], IrFunc>] = [true];

const read = (name: Name): WritableExpr => ({
  kind: IrKind.Read,
  pos,
  type: name.type,
  qualifier: name.qualifier,
  place: {kind: PlaceKind.Name, name},
});

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
      kind: IrKind.Read,
      pos,
      type: FloatType,
      qualifier: Qualifier.Series,
      place: {kind: PlaceKind.Name, name: p},
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
  nominalIds: new Map(),
  params: [],
  requests: [],
  outputs: [],
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
  nominalIds: new Map(),
  params: [],
  requests: [edge],
  outputs: [],
  packageGlobals: [],
  init: [],
  body: [
    {
      kind: IrKind.Assign,
      pos,
      target: read(x),
      op: null,
      value: {
        kind: IrKind.CallFunc,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        func: inc,
        receiver: null,
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
      kind: IrKind.Read,
      pos,
      type: FloatType,
      qualifier: Qualifier.Series,
      place: {kind: PlaceKind.Request, request: edge},
    },
    {
      kind: IrKind.HistRead,
      pos,
      type: IntType,
      qualifier: Qualifier.Series,
      place: {kind: PlaceKind.Builtin, builtin: barIndex},
      offset: int(1),
    },
  ],
};

const bindOnlyProgram: Program = {
  version: 1,
  nominalIds: new Map(),
  params: [],
  requests: [],
  outputs: [],
  packageGlobals: [
    {
      ...x,
      depth: {
        kind: DepthKind.Bound,
        expr: {
          kind: IrKind.CallFunc,
          pos,
          type: FloatType,
          qualifier: Qualifier.Series,
          func: inc,
          receiver: null,
          slot: 0,
          args: [num(1)],
          argumentEvaluationOrder: [0],
        },
      },
    },
  ],
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
  nominalIds: new Map(),
  params: [],
  requests: [],
  outputs: [],
  packageGlobals: [],
  init: [],
  body: [
    {
      kind: IrKind.Assign,
      pos,
      target: {
        kind: IrKind.Selector,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        x: read(holderName),
        fieldIndex: 0,
      },
      value: num(2),
      op: null,
    },
    {
      kind: IrKind.CallNative,
      pos,
      type: FloatType,
      qualifier: Qualifier.Series,
      receiver: {
        kind: IrKind.Selector,
        pos,
        type: holder.fields[1].type,
        qualifier: Qualifier.Series,
        x: read(holderName),
        fieldIndex: 1,
      },
      native: {
        name: 'array.pop',
        argTypes: [],
        resultType: FloatType,
        effect: 'write',
      },
      args: [],
      argumentEvaluationOrder: [],
    },
    {
      kind: IrKind.CallFunc,
      pos,
      type: FloatType,
      qualifier: Qualifier.Series,
      func: mutate,
      receiver: read(holderName),
      slot: 2,
      argumentEvaluationOrder: [],
      args: [],
    },
  ],
};

describe('derived enumerations', () => {
  test('statement-position calls, selectors, and control flow visit each expression once', () => {
    const body: BlockExpr = {
      kind: IrKind.BlockExpr,
      pos,
      type: FloatType,
      qualifier: Qualifier.Series,
      stmts: [read(x)],
      value: num(1),
    };
    const roots: IrStmt[] = [
      ...mutationProgram.body.slice(1),
      {
        kind: IrKind.Selector,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        x: read(holderName),
        fieldIndex: 0,
      },
      {
        kind: IrKind.IfExpr,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        cond: bool(true),
        then: body,
        else: null,
      },
      {
        kind: IrKind.WhileExpr,
        pos,
        type: FloatType,
        qualifier: Qualifier.Series,
        cond: bool(false),
        body,
      },
    ];
    for (const root of roots) {
      const expressions: IrExpr[] = [];
      const statements: IrStmt[] = [];
      walkIrStmt(root, {
        expr: expr => expressions.push(expr),
        stmt: stmt => statements.push(stmt),
      });
      expect(expressions[0]).toBe(root);
      expect(expressions.length).toBe(new Set(expressions).size);
      expect(statements).toEqual([]);
    }
  });

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

  test('one call kind refers to every user function mode', () => {
    expect(CALL_MODE_TYPES).toEqual([true]);
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
    expect(dumpProgram(mutationProgram)).toContain('Assign');
    expect(dumpProgram(mutationProgram)).toContain(
      'CallNative array.pop write',
    );
    expect(dumpProgram(mutationProgram)).toContain('CallFunc mutate slot=2');
  });
});
