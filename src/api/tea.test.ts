// Purpose: Tagged-template API — proves embedded source, interpolation,
// implicit Tea libraries, diagnostics, and the canonical Program projection.

import {describe, expect, test} from 'vitest';
import {of} from 'rxjs';
import * as z from 'zod';
import type {StepResult} from '../runtime/js-runtime';
import type {Sink} from './sink';
import {DataStream} from './stream';
import {TeaCompileError, tea} from './tea';

describe('tea', () => {
  test('compiles an indented template into a generated JSModule', () => {
    const fastWindow = 14;
    const node = tea`
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

    expect(node.module.manifest.params.map(param => param.name)).toEqual([
      'fast_window',
      'slow_window',
    ]);
    expect(node.module.manifest.outputs.map(output => output.effect)).toEqual([
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

  test('owns a JSModule from creation and keeps binding steps immutable', () => {
    const node = tea`
      length = input.int(14)
      plot(close + length)
    `;
    const source = new DataStream(z.object({close: z.number()}), subscriber =>
      of({close: 1}).subscribe(subscriber),
    );

    const withSource = node.bind(source);
    const ready = withSource.bind({length: 20});

    expect(node.module.remaining().map(binding => binding.name)).toEqual([
      'length',
      'close',
    ]);
    expect(node.ready()).toBe(false);
    expect(withSource.ready()).toBe(false);
    expect(ready.ready()).toBe(true);
    expect(withSource.module).not.toBe(node.module);
    expect(ready.module).not.toBe(withSource.module);
    expect(ready.module.remaining()).toEqual([]);
  });

  test('is ready at creation when the Program has no binding requirements', () => {
    const node = tea`plot(1)`;

    expect(node.module.ready()).toBe(true);
    expect(node.module.remaining()).toEqual([]);
    expect(node.ready()).toBe(true);
  });

  test('drives one state-owning runtime from the bound source Observable', async () => {
    const source = new DataStream(z.object({close: z.number()}), subscriber =>
      of({close: 1}, {close: 2}).subscribe(subscriber),
    );
    const node = tea`
      length = input.int(14)
      plot(close + length)
    `
      .bind(source)
      .bind({length: 20});
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(sink.values.map(result => result.output[0]?.channels[0])).toEqual([
      21, 22,
    ]);
  });

  test('owns static request children and routes a bind-known context source', () => {
    const source = numericSource(1, 2);
    const node = tea`
      requested = request.security("X", "D", close)
      plot(requested)
    `;

    const ready = node.bind({X: source});

    expect(node.ready()).toBe(false);
    expect(ready.ready()).toBe(true);
    expect(() => ready.to(new StepSink())).toThrow(
      'TeaNode request execution requires time and finality semantics that DataStream does not provide',
    );
  });

  test('uses bound request parameters as keyed child identities', () => {
    const source = numericSource(1);
    const node = tea`
      symbol = input.symbol("X")
      requested = request.security(symbol, "D", close)
      plot(requested)
    `.bind({symbol: 'Y'});

    expect(node.ready()).toBe(false);
    expect(() => node.bind({X: source})).toThrow(
      "no bind-known root series or static request child matches 'X'",
    );
    expect(node.bind({Y: source}).ready()).toBe(true);
  });

  test('propagates compilation-global parameters into request child binding', () => {
    const node = tea`
      length = input.int(3)
      requested = request.security("X", "D", close[length])
      plot(requested)
    `
      .bind({length: 6})
      .bind({X: numericSource(1)});

    expect(node.ready()).toBe(true);
    expect(node.module.requests[0]?.parameterValues).toEqual([6]);
    expect(node.module.requests[0]?.binding?.retention.series).toEqual([6]);
  });

  test('discovers nested request children after their parents bind', () => {
    const source = numericSource(1);
    const node = tea`
      requested = request.security(
        "X",
        "D",
        request.security("Y", "W", close)
      )
      plot(requested)
    `;

    const withOuter = node.bind({X: source});
    const ready = withOuter.bind({Y: source});

    expect(withOuter.ready()).toBe(false);
    expect(ready.ready()).toBe(true);
  });
});

function numericSource(...values: readonly number[]): DataStream<{
  close: number;
}> {
  return new DataStream(z.object({close: z.number()}), subscriber =>
    of(...values.map(close => ({close}))).subscribe(subscriber),
  );
}

class StepSink implements Sink<StepResult> {
  readonly values: StepResult[] = [];
  readonly completion: Promise<void>;
  private readonly resolve: () => void;
  private readonly reject: (error: unknown) => void;

  constructor() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.completion = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.resolve = resolve;
    this.reject = reject;
  }

  next(value: StepResult): void {
    this.write(value);
  }

  write(value: StepResult): void {
    this.values.push(value);
  }

  error(error: unknown): void {
    this.reject(error);
  }

  complete(): void {
    this.resolve();
  }
}
