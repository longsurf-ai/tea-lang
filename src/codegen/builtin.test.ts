import type {Module} from '../runtime/module-binding';
// Purpose: Typed builtin codegen tests — current-ABI modules and reads preserve source identity, value layout, depth, and the distinct builtin carrier.

import {describe, expect, test} from 'vitest';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  type HistReadExpr,
  type ReadExpr,
  type IrExpr,
} from '../ir/node';
import type {BuiltinInput, Program} from '../ir/program';
import {BoolType, IntType, Qualifier, StringType, type Type} from '../ir/type';
import {mustBuild} from '../noder/testing';
import {RUNTIME_ABI_VERSION} from '../runtime/module-abi';
import {loadModule} from '../runtime/load';
import {bool, int, text} from '../runtime/js/value';
import {generate} from './codegen';

const pos = {
  base: {filename: 'builtin.test.tea'},
  line: 1,
  col: 1,
};

function constant(value: number): IrExpr {
  return {
    kind: IrKind.Const,
    pos,
    type: IntType,
    qualifier: Qualifier.Const,
    value,
  };
}

function input(
  source: BuiltinInput['source'],
  type: Type,
  qualifier: Qualifier,
  depth: BuiltinInput['depth'] = {kind: DepthKind.None},
): BuiltinInput {
  return {source, type, qualifier, depth};
}

function read(
  builtin: BuiltinInput,
  offset: IrExpr | null,
): HistReadExpr | ReadExpr {
  const base = {
    pos,
    type: builtin.type,
    qualifier: builtin.qualifier,
    place: {kind: PlaceKind.Builtin, builtin},
  } as const;
  return offset === null
    ? {...base, kind: IrKind.Read}
    : {...base, kind: IrKind.HistRead, offset};
}

describe('typed builtin lowering', () => {
  test('publishes dense current-ABI specs and lowers history through ctx.builtin', () => {
    const time = input(
      {domain: 'time', field: 'time'},
      IntType,
      Qualifier.Series,
      {kind: DepthKind.Bound, expr: constant(3)},
    );
    const first = input(
      {domain: 'barstate', field: 'isfirst'},
      BoolType,
      Qualifier.Series,
    );
    const ticker = input(
      {domain: 'syminfo', field: 'tickerid'},
      StringType,
      Qualifier.Simple,
    );
    const program: Program = {
      version: 1,
      nominalIds: new Map(),
      params: [],
      requests: [],
      outputs: [],
      packageGlobals: [],
      init: [],
      body: [read(time, constant(2)), read(first, null), read(ticker, null)],
    };

    const source = generate(program);
    const module = loadModule(source);

    expect(module.abi).toBe(RUNTIME_ABI_VERSION);
    expect(module.inputs.series).toEqual([]);
    expect(module.inputs.builtins).toEqual([
      {
        source: {domain: 'time', field: 'time'},
        constant: false,
        empty: int(NaN),
        depth: {kind: 'const', bars: 3},
      },
      {
        source: {domain: 'barstate', field: 'isfirst'},
        constant: false,
        empty: bool(false),
        depth: {kind: 'none'},
      },
      {
        source: {domain: 'syminfo', field: 'tickerid'},
        constant: true,
        empty: text(null),
        depth: {kind: 'none'},
      },
    ]);
    expect(source).not.toContain('module.inputs.builtins[0].depth =');
    expect(source).toMatch(
      /ctx\.inputs\.builtins\["time\.time"\]\.hist\(\(t\d+\)\.value\)/,
    );
    expect(source).toContain('ctx.inputs.builtins["barstate.isfirst"].hist(0)');
    expect(source).toContain('ctx.inputs.builtins["syminfo.tickerid"].hist(0)');
  });

  test('restarts builtin ids in a request child module', () => {
    const source = generate(
      mustBuild(
        'value = request.security("X", "D", bar_index)\nemit "output0" value',
      ),
    );
    const module = loadModule(source) as Module;

    expect(module.inputs.builtins).toEqual([]);
    expect(module.requests[0].module.abi).toBe(RUNTIME_ABI_VERSION);
    expect(module.requests[0].module.state).not.toHaveProperty('layout');
    expect(module.requests[0].module.inputs.series).toEqual([]);
    expect(module.requests[0].module.inputs.builtins).toMatchObject([
      {source: {domain: 'bar', field: 'bar_index'}},
    ]);
    expect(source).toContain('ctx.inputs.builtins["bar.bar_index"].hist(0)');
  });
});
