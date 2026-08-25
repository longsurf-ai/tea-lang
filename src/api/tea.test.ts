// Purpose: Tagged-template API — proves embedded source, interpolation,
// implicit Tea libraries, diagnostics, and the canonical Program projection.

import {describe, expect, test} from 'vitest';
import {of, Subject} from 'rxjs';
import * as z from 'zod';
import type {StepResult} from '../runtime/js-runtime';
import {moduleBindings} from '../runtime/module-binding';
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

  test('keeps one Node identity while installing immutable module snapshots', () => {
    const node = tea`
      length = input.int(14)
      plot(close + length)
    `;
    const source = new DataStream(z.object({close: z.number()}), subscriber =>
      of({close: 1}).subscribe(subscriber),
    );

    const initial = node.module;
    expect(node.bind(source)).toBe(node);
    const withSource = node.module;
    expect(node.bind({length: 20})).toBe(node);
    const ready = node.module;

    expect(initial.remaining().map(binding => binding.name)).toEqual([
      'length',
      'close',
    ]);
    expect(withSource.remaining().map(binding => binding.name)).toEqual([
      'length',
    ]);
    expect(ready.ready()).toBe(true);
    expect(node.ready()).toBe(true);
    expect(withSource).not.toBe(initial);
    expect(ready).not.toBe(withSource);
    expect(ready.remaining()).toEqual([]);
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
    `;
    node.bind(source);
    node.bind({length: 20});
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

    expect(node.ready()).toBe(false);
    expect(node.bind({X: source})).toBe(node);
    expect(node.ready()).toBe(true);
    expect(() => node.to(new StepSink())).toThrow(
      'Node request execution requires time and finality semantics that DataStream does not provide',
    );
  });

  test('uses bound request parameters as keyed child identities', () => {
    const source = numericSource(1);
    const node = tea`
      symbol = input.symbol("X")
      requested = request.security(symbol, "D", close)
      plot(requested)
    `;
    node.bind({symbol: 'Y'});

    expect(node.ready()).toBe(false);
    const beforeFailure = node.module;
    expect(() => node.bind({X: source})).toThrow(
      "no bind-known root series or static request child matches 'X'",
    );
    expect(node.module.manifest).toStrictEqual(beforeFailure.manifest);
    expect(node.module.requests[0]?.manifest).toStrictEqual(
      beforeFailure.requests[0]?.manifest,
    );
    expect(node.ready()).toBe(false);
    expect(node.bind({Y: source})).toBe(node);
    expect(node.ready()).toBe(true);
  });

  test('invalidates a bound request stream when its parameter identity changes', () => {
    const node = tea`
      symbol = input.symbol("X")
      requested = request.security(symbol, "D", close)
      plot(requested)
    `;
    node.bind({symbol: 'X'});

    node.bind({X: numericSource(1)});
    const oldModule = node.module;
    expect(node.ready()).toBe(true);

    node.bind({symbol: 'Y'});
    expect(oldModule.manifest.requests[0]?.context?.symbol).toBe('X');
    expect(node.module.manifest.requests[0]?.context?.symbol).toBe('Y');
    expect(node.ready()).toBe(false);

    node.bind({Y: numericSource(2)});
    expect(node.ready()).toBe(true);
  });

  test('propagates compilation-global parameters into request child binding', () => {
    const node = tea`
      length = input.int(3)
      requested = request.security("X", "D", close[length])
      plot(requested)
    `;
    node.bind({length: 6});
    node.bind({X: numericSource(1)});

    expect(node.ready()).toBe(true);
    expect(
      node.module.requests[0]?.manifest.params.map(param => param.value),
    ).toEqual([6]);
    expect(node.module.requests[0]?.manifest.series[0]?.depth).toEqual({
      kind: 'const',
      bars: 6,
    });
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

    expect(node.bind({X: source})).toBe(node);
    expect(node.ready()).toBe(false);
    expect(node.bind({Y: source})).toBe(node);
    expect(node.ready()).toBe(true);
  });

  test('fans one keyed stream into matching root and request-child series', () => {
    const node = tea`
      requested = request.security("close", "D", close)
      plot(close + requested)
    `;
    expect(node.bind({close: numericSource(1)})).toBe(node);
    expect(node.ready()).toBe(true);
    expect(
      moduleBindings(node.module).find(binding => binding.name === 'close'),
    ).toMatchObject({kind: 'series', supplied: true});
    expect(
      moduleBindings(node.module.requests[0]!).find(
        binding => binding.name === 'close',
      ),
    ).toMatchObject({kind: 'series', supplied: true});
  });

  test('fans one request key into every recursively matching child', () => {
    const node = tea`
      daily = request.security("X", "D", close)
      weekly = request.security("X", "W", close)
      plot(daily + weekly)
    `;

    node.bind({X: numericSource(1)});

    expect(node.ready()).toBe(true);
    expect(
      node.module.requests.map(request =>
        moduleBindings(request).find(binding => binding.name === 'close'),
      ),
    ).toEqual([
      {kind: 'series', name: 'close', supplied: true},
      {kind: 'series', name: 'close', supplied: true},
    ]);
  });

  test('keeps request-child binding atomic when a later key fails', () => {
    const node = tea`
      x = request.security("X", "D", close)
      y = request.security("Y", "D", close)
      plot(x + y)
    `;
    const initial = node.module;
    const source = numericSource(1);

    expect(() => node.bind({X: source, missing: source})).toThrow(
      "no bind-known root series or static request child matches 'missing'",
    );
    expect(node.module).toBe(initial);
    expect(node.ready()).toBe(false);
    expect(node.bind({X: source, Y: source})).toBe(node);
    expect(node.ready()).toBe(true);
  });

  test('fans out one execution and gives late sinks only future results', async () => {
    const rows = new Subject<{close: number}>();
    let sourceSubscriptions = 0;
    const source = new DataStream(z.object({close: z.number()}), subscriber => {
      sourceSubscriptions += 1;
      return rows.subscribe(subscriber);
    });
    const node = tea`plot(close)`;
    node.bind(source);
    const first = new StepSink();
    const second = new StepSink();

    expect(sourceSubscriptions).toBe(0);
    const firstSubscription = node.to(first);
    const secondSubscription = node.to(second);
    expect(sourceSubscriptions).toBe(1);

    rows.next({close: 1});
    await Promise.all([first.waitFor(1), second.waitFor(1)]);

    const late = new StepSink();
    const lateSubscription = node.to(late);
    rows.next({close: 2});
    await Promise.all([first.waitFor(2), second.waitFor(2), late.waitFor(1)]);
    rows.complete();
    await Promise.all([first.completion, second.completion, late.completion]);

    expect(values(first)).toEqual([1, 2]);
    expect(values(second)).toEqual([1, 2]);
    expect(values(late)).toEqual([2]);
    expect(sourceSubscriptions).toBe(1);
    expect(firstSubscription.closed).toBe(true);
    expect(secondSubscription.closed).toBe(true);
    expect(lateSubscription.closed).toBe(true);
  });

  test('rejects binding after execution starts', async () => {
    const rows = new Subject<{close: number}>();
    const source = new DataStream(z.object({close: z.number()}), subscriber =>
      rows.subscribe(subscriber),
    );
    const node = tea`plot(close)`;
    node.bind(source);
    const sink = new StepSink();

    node.to(sink);
    expect(() => node.bind({})).toThrow(
      'Node cannot bind after execution has started',
    );
    rows.complete();
    await sink.completion;
  });

  test('owns source cancellation and disposes idempotently', async () => {
    const rows = new Subject<{close: number}>();
    let teardowns = 0;
    const source = new DataStream(z.object({close: z.number()}), subscriber => {
      const subscription = rows.subscribe(subscriber);
      return () => {
        teardowns += 1;
        subscription.unsubscribe();
      };
    });
    const node = tea`plot(close)`;
    node.bind(source);
    const sink = new StepSink();
    const sinkSubscription = node.to(sink);

    node.dispose();
    node.dispose();
    await sink.completion;

    expect(teardowns).toBe(1);
    expect(sinkSubscription.closed).toBe(true);
    expect(() => node.bind({})).toThrow('Node is disposed');
    expect(() => node.to(new StepSink())).toThrow('Node is disposed');
  });
});

function values(sink: StepSink): readonly unknown[] {
  return sink.values.map(result => result.output[0]?.channels[0]);
}

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
  private readonly waiters: {
    readonly count: number;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }[] = [];

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
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!;
      if (this.values.length < waiter.count) continue;
      this.waiters.splice(index, 1);
      waiter.resolve();
    }
  }

  error(error: unknown): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.reject(error);
  }

  complete(): void {
    this.resolve();
  }

  waitFor(count: number): Promise<void> {
    if (this.values.length >= count) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({count, resolve, reject});
    });
  }
}
