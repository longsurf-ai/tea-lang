// Purpose: Typed builtin codegen tests — current-ABI manifests and reads preserve source identity, value layout, depth, and the distinct builtin carrier.

import {describe, expect, test} from 'vitest';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  type HistReadExpr,
  type IrExpr,
} from '../ir/node';
import type {BuiltinInput, Program} from '../ir/program';
import {BoolType, IntType, Qualifier, StringType, type Type} from '../ir/type';
import {mustBuild} from '../noder/testing';
import {RUNTIME_ABI_VERSION, type JSModule} from '../runtime/module-abi';
import {loadModule} from '../runtime/load';
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

function read(builtin: BuiltinInput, offset: IrExpr | null): HistReadExpr {
  return {
    kind: IrKind.HistRead,
    pos,
    type: builtin.type,
    qualifier: builtin.qualifier,
    place: {kind: PlaceKind.Builtin, builtin},
    offset,
  };
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
      effects: [],
      packageGlobals: [],
      init: [],
      body: [
        {kind: IrKind.ExprStmt, pos, x: read(time, constant(2))},
        {kind: IrKind.ExprStmt, pos, x: read(first, null)},
        {kind: IrKind.ExprStmt, pos, x: read(ticker, null)},
      ],
    };

    const source = generate(program);
    const module = loadModule(source);

    expect(module.abi).toBe(RUNTIME_ABI_VERSION);
    expect(module.manifest.series).toEqual([]);
    expect(module.manifest.builtin).toEqual([
      {
        source: {domain: 'time', field: 'time'},
        layout: 0,
        depth: {kind: 'const', bars: 3},
      },
      {
        source: {domain: 'barstate', field: 'isfirst'},
        layout: 1,
        depth: {kind: 'none'},
      },
      {
        source: {domain: 'syminfo', field: 'tickerid'},
        layout: 2,
        depth: {kind: 'none'},
      },
    ]);
    expect(source).not.toContain('manifest.builtin[0].depth =');
    expect(source).toMatch(/ctx\.builtin\(0, t\d+\)/);
    expect(source).toContain('ctx.builtin(1, 0)');
    expect(source).toContain('ctx.builtin(2, 0)');
  });

  test('restarts builtin ids in a request child module', () => {
    const source = generate(
      mustBuild('value = request.security("X", "D", bar_index)\nplot(value)'),
    );
    const module = loadModule(source) as JSModule;

    expect(module.manifest.builtin).toEqual([]);
    expect(module.requests[0].abi).toBe(RUNTIME_ABI_VERSION);
    expect(module.requests[0].layout).toBe(module.layout);
    expect(module.requests[0].manifest.series).toEqual([]);
    expect(module.requests[0].manifest.builtin).toMatchObject([
      {source: {domain: 'bar', field: 'bar_index'}},
    ]);
    expect(source).toContain('ctx.builtin(0, 0)');
  });
});
