// Purpose: Output bind lowering preserves source evaluation order while assembling canonical host arguments.

import {describe, expect, test} from 'bun:test';
import {mustBuild} from '../noder/testing';
import {
  ExecutionError,
  type DataProvider,
  type OutputSink,
  type ProviderContext,
} from '../runtime/abi';
import {bind} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';
import {generate} from './codegen';

const SOURCE = [
  'indicator("output bind order")',
  'colors = matrix.new<color>()',
  'values = array.new<int>()',
  'plot(color = colors.get(0, 0), series = values.first())',
].join('\n');

const context: ProviderContext = {
  rows: 1,
  axis: null,
  series: () => null,
  builtinValue: () => undefined,
};

const provider: DataProvider = {
  resolveContext: () => Promise.resolve(context),
};

const sink: OutputSink = {
  declare() {},
  publish() {},
};

describe('output bind evaluation order', () => {
  test('named bind arguments fail in source order before canonical assembly', async () => {
    const program = mustBuild(SOURCE);
    const output = program.outputs[1];
    expect(output.bindArgs.map(arg => arg.name)).toEqual(['series', 'color']);
    expect(output.bindArgumentEvaluationOrder).toEqual([1, 0]);

    const module = loadModule(generate(program));
    const failure = await bind(module, {
      params: {},
      provider,
      sink,
      timeNow: 0,
    }).then(
      () => {
        throw new Error('expected output bind to fail');
      },
      error => error,
    );

    expect(failure).toBeInstanceOf(ExecutionError);
    if (!(failure instanceof ExecutionError)) {
      throw failure;
    }
    // Source order is color then series. The distinct codes prove matrix.get
    // runs before array.first even though bindArgs are canonically stored.
    expect(failure.code).toBe('INDEX_OUT_OF_BOUNDS');
  });
});
