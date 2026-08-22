// Purpose: Tagged-template API — proves embedded source, interpolation,
// implicit Tea libraries, diagnostics, and the canonical Program projection.

import {describe, expect, test} from 'vitest';
import {TeaCompileError, tea} from './tea';

describe('tea', () => {
  test('compiles an indented template through the ordinary Program frontend', () => {
    const fastWindow = 14;
    const program = tea`
      //@version=1
      indicator("EMA crossover")

      fast_window = input.int(${fastWindow}, "Fast window")
      slow_window = input.int(28, "Slow window")
      fast_ema = ta.ema(close, fast_window)
      slow_ema = ta.ema(close, slow_window)
      crossed = ta.crossover(fast_ema, slow_ema)

      plot(fast_ema, "Fast EMA")
      plot(slow_ema, "Slow EMA")
      plotshape(crossed, "Crossover")
    `;

    expect(program.version).toBe(1);
    expect(program.params.map(param => param.name)).toEqual([
      'fast_window',
      'slow_window',
    ]);
    expect(program.outputs.map(output => output.effect)).toEqual([
      'indicator',
      'plot',
      'plot',
      'plotshape',
    ]);
  });

  test('reports compiler diagnostics with a stable virtual filename', () => {
    let thrown: unknown;
    try {
      tea`indicator("unterminated)`;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TeaCompileError);
    const error = thrown as TeaCompileError;
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]).toMatchObject({
      pos: {
        base: {filename: '<tea-template>'},
        line: 1,
        col: 11,
      },
      msg: 'string literal not terminated',
    });
    expect(error.message).toBe(
      '<tea-template>:1:11: string literal not terminated',
    );
  });
});
