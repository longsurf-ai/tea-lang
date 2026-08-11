// Purpose: Typed execution-input codegen tests — ABI 4 manifests and reads must preserve source identity, value layout, depth, and the distinct execution carrier.

import {describe, expect, test} from 'bun:test';
import {DEFAULT_COMPILE_CONFIG} from '../base/config';
import {Errors} from '../base/print';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  type HistReadExpr,
  type IrExpr,
} from '../ir/node';
import type {ExecutionInput, Program} from '../ir/program';
import {BoolType, IntType, Qualifier, StringType, type Type} from '../ir/type';
import {mustBuild} from '../noder/testing';
import {generate} from './codegen';

const pos = {
  base: {filename: 'execution-input.test.tea'},
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
  source: ExecutionInput['source'],
  type: Type,
  qualifier: Qualifier,
  depth: ExecutionInput['depth'] = {kind: DepthKind.None},
): ExecutionInput {
  return {source, type, qualifier, depth};
}

function read(execution: ExecutionInput, offset: IrExpr | null): HistReadExpr {
  return {
    kind: IrKind.HistRead,
    pos,
    type: execution.type,
    qualifier: execution.qualifier,
    place: {kind: PlaceKind.Execution, execution},
    offset,
  };
}

describe('typed execution input lowering', () => {
  test('publishes dense ABI 4 specs and lowers history through rt.execution', () => {
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
      params: [],
      requests: [],
      outputs: [],
      init: [],
      body: [
        {kind: IrKind.ExprStmt, pos, x: read(time, constant(2))},
        {kind: IrKind.ExprStmt, pos, x: read(first, null)},
        {kind: IrKind.ExprStmt, pos, x: read(ticker, null)},
      ],
    };

    const source = generate(program, DEFAULT_COMPILE_CONFIG, new Errors());
    const module = new Function(source)() as {
      readonly abi: number;
      readonly manifest: {
        readonly series: readonly unknown[];
        readonly execution: readonly unknown[];
      };
    };

    expect(module.abi).toBe(4);
    expect(module.manifest.series).toEqual([]);
    expect(module.manifest.execution).toEqual([
      {
        source: {domain: 'time', field: 'time'},
        layout: 0,
        depth: {kind: 'bound'},
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
    expect(source).toContain('rt.bindExecutionDepth(0, (3));');
    expect(source).toMatch(/rt\.execution\(0, t\d+\)/);
    expect(source).toContain('rt.execution(1, 0)');
    expect(source).toContain('rt.execution(2, 0)');
  });

  test('restarts execution ids in a request child module', () => {
    const source = generate(
      mustBuild('value = request.security("X", "D", bar_index)\nplot(value)'),
      DEFAULT_COMPILE_CONFIG,
      new Errors(),
    );
    const module = new Function(source)() as {
      readonly manifest: {
        readonly execution: readonly unknown[];
      };
      readonly requests: readonly {
        readonly manifest: {
          readonly series: readonly unknown[];
          readonly execution: readonly {readonly source: unknown}[];
        };
      }[];
    };

    expect(module.manifest.execution).toEqual([]);
    expect(module.requests[0].manifest.series).toEqual([]);
    expect(module.requests[0].manifest.execution).toMatchObject([
      {source: {domain: 'bar', field: 'bar_index'}},
    ]);
    expect(source).toContain('rt.execution(0, 0)');
  });
});
