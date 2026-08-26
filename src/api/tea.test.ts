// Purpose: Tagged-template API — proves embedded source, interpolation,
// implicit Tea libraries, diagnostics, and the canonical Program projection.

import {describe, expect, test} from 'vitest';
import {Observable, of, Subject} from 'rxjs';
import * as z from 'zod';
import {d, m, ns, w, y, type Clock} from './clock';
import type {Datum} from './node';
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
    const source = new DataStream(
      z.object({close: z.number()}),
      of({close: 1}),
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
    const source = new DataStream(
      z.object({close: z.number()}),
      of({close: 1}, {close: 2}),
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

    expect(sink.values.map(result => result['output_0'])).toEqual([21, 22]);
  });

  test('validates each DataStream emission exactly once', async () => {
    let parses = 0;
    const schema = z.object({close: z.number()}).transform(value => {
      parses += 1;
      return value;
    });
    const node = tea`plot(close)`;
    node.bind(new DataStream(schema, of({close: 1}, {close: 2})));
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(parses).toBe(2);
    expect(values(sink)).toEqual([1, 2]);
  });

  test('binds request streams by declaration name, not requested symbol', async () => {
    const node = tea`
      daily = request.security("X", "D", close)
      weekly = request.security("X", "W", close)
      plot(daily + weekly)
    `;

    expect(node.module.manifest.requests.map(request => request.name)).toEqual([
      'daily',
      'weekly',
    ]);
    expect(() => node.bind({X: numericSource(1)})).toThrow(
      "no bind-known root series or static request child matches 'X'",
    );
    expect(
      node.bind({
        daily: clockedNumericSource(d, 1),
        weekly: clockedNumericSource(w, 10),
      }),
    ).toBe(node);
    expect(node.ready()).toBe(true);

    const sink = new StepSink();
    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([11]);
  });

  test('rejects request and DataStream clock disagreement before subscribing', () => {
    let subscriptions = 0;
    const node = tea`
      requested = request.security("X", "D", close)
      plot(requested)
    `;
    node.bind({
      requested: new DataStream(
        z.object({close: z.number()}),
        new Observable(subscriber => {
          subscriptions += 1;
          return of({close: 1}).subscribe(subscriber);
        }),
        m,
      ),
    });

    expect(() => node.to(new StepSink())).toThrow('expects clock');
    expect(subscriptions).toBe(0);
  });

  test('rejects conflicting root clocks before changing binding state', () => {
    const node = tea`plot(close + open)`;
    const initial = node.module;

    expect(() =>
      node.bind({
        close: clockedNumericSource(d, 1),
        open: clockedNumericSource(w, 1),
      }),
    ).toThrow('bound DataStream clocks disagree');
    expect(node.module).toBe(initial);
  });

  test('rejects a count-window ratio outside JavaScript safe integers', () => {
    const node = tea`
      lower = request.security_lower_tf("X", "", close)
      plot(close + lower.size())
    `;
    node.bind({
      close: clockedNumericSource(y, 10),
      lower: clockedNumericSource(ns, 1),
    });

    expect(() => node.to(new StepSink())).toThrow('clock ratio is too large');
  });

  test('keeps a request stream bound when its symbol parameter changes', () => {
    const node = tea`
      symbol = input.symbol("X")
      requested = request.security(symbol, "D", close)
      plot(requested)
    `;
    node.bind({symbol: 'X'});

    node.bind({requested: numericSource(1)});
    const oldModule = node.module;
    expect(node.ready()).toBe(true);

    node.bind({symbol: 'Y'});
    expect(oldModule.manifest.requests[0]?.context?.symbol).toBe('X');
    expect(node.module.manifest.requests[0]?.context?.symbol).toBe('Y');
    expect(node.ready()).toBe(true);
  });

  test('propagates compilation-global parameters into request child binding', () => {
    const node = tea`
      length = input.int(3)
      requested = request.security("X", "D", close[length])
      plot(requested)
    `;
    node.bind({length: 6});
    node.bind({requested: numericSource(1)});

    expect(node.ready()).toBe(true);
    expect(
      node.module.requests[0]?.manifest.params.map(param => param.value),
    ).toEqual([6]);
    expect(node.module.requests[0]?.manifest.series[0]?.depth).toEqual({
      kind: 'const',
      bars: 6,
    });
  });

  test('rejects inline, function-owned, and nested request calls', () => {
    const inline = () => tea`
      plot(request.security("X", "D", close))
    `;
    const inFunction = () => tea`
      fetch() => request.security("X", "D", close)
      requested = fetch()
      plot(requested)
    `;
    const nested = () => tea`
      requested = request.security(
        "X",
        "D",
        request.security("Y", "W", close)
      )
      plot(requested)
    `;

    for (const compile of [inline, inFunction, nested]) {
      expect(compile).toThrow(
        'request call must directly initialize one plain top-level variable',
      );
    }
  });

  test('executes scalar requests one-to-one', async () => {
    const node = tea`
      requested = request.security("X", "D", close)
      plot(close + requested)
    `;
    node.bind({
      close: numericSource(10, 20),
      requested: numericSource(1, 2),
    });
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([11, 22]);
  });

  test('collects lower-timeframe values by regular clock count', async () => {
    const twoMinutes = (2n * m) as Clock;
    const node = tea`
      lower = request.security_lower_tf("X", "1", close)
      plot(close)
      plot(lower.size())
      plot(lower.first())
      plot(lower.last())
    `;
    node.bind({
      close: clockedNumericSource(twoMinutes, 10, 20),
      lower: clockedNumericSource(m, 1, 2, 3, 4),
    });
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(outputValues(sink)).toEqual([
      [10, 2, 1, 2],
      [20, 2, 3, 4],
    ]);
  });

  test('collects event-time windows including empty windows', async () => {
    const node = tea`
      lower = request.security_lower_tf("X", "", close)
      plot(close)
      plot(lower.size())
    `;
    node.bind({
      close: timedNumericSource(
        {time: 10n, close: 10},
        {time: 20n, close: 20},
        {time: 30n, close: 30},
      ),
      lower: timedNumericSource(
        {time: 5n, close: 1},
        {time: 10n, close: 2},
        {time: 25n, close: 3},
      ),
    });
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(outputValues(sink)).toEqual([
      [10, 2],
      [20, 0],
      [30, 1],
    ]);
  });

  test('drops lower-timeframe values that arrive after their window', async () => {
    const mainRows = new Subject<TimedNumericDatum>();
    const childRows = new Subject<TimedNumericDatum>();
    const node = tea`
      lower = request.security_lower_tf("X", "", close)
      plot(close)
      plot(lower.size())
      plot(lower.first())
    `;
    node.bind({
      close: timedNumericSubject(mainRows),
      lower: timedNumericSubject(childRows),
    });
    const sink = new StepSink();
    node.to(sink);

    childRows.next({time: 5n, close: 1});
    mainRows.next({time: 10n, close: 10});
    await sink.waitFor(1);

    childRows.next({time: 8n, close: 99});
    childRows.next({time: 15n, close: 2});
    mainRows.next({time: 20n, close: 20});
    await sink.waitFor(2);

    childRows.complete();
    mainRows.complete();
    await sink.completion;

    expect(outputValues(sink)).toEqual([
      [10, 1, 1],
      [20, 1, 2],
    ]);
  });

  test('falls back to one-to-one arrays without clocks or event time', async () => {
    const node = tea`
      lower = request.security_lower_tf("X", "D", close)
      plot(close)
      plot(lower.size())
      plot(lower.first())
    `;
    node.bind({
      close: numericSource(10, 20),
      lower: numericSource(1, 2),
    });
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(outputValues(sink)).toEqual([
      [10, 1, 1],
      [20, 1, 2],
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

    expect(() => node.bind({x: source, missing: source})).toThrow(
      "no bind-known root series or static request child matches 'missing'",
    );
    expect(node.module).toBe(initial);
    expect(node.ready()).toBe(false);
    expect(node.bind({x: source, y: source})).toBe(node);
    expect(node.ready()).toBe(true);
  });

  test('fans out one execution and gives late sinks only future results', async () => {
    const rows = new Subject<{close: number}>();
    let sourceSubscriptions = 0;
    const source = new DataStream(
      z.object({close: z.number()}),
      new Observable(subscriber => {
        sourceSubscriptions += 1;
        return rows.subscribe(subscriber);
      }),
    );
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
    const source = new DataStream(z.object({close: z.number()}), rows);
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
    const source = new DataStream(
      z.object({close: z.number()}),
      new Observable(subscriber => {
        const subscription = rows.subscribe(subscriber);
        return () => {
          teardowns += 1;
          subscription.unsubscribe();
        };
      }),
    );
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
  return sink.values.map(result => result['output_0']);
}

function outputValues(sink: StepSink): readonly (readonly unknown[])[] {
  return sink.values.map(result =>
    Object.entries(result)
      .filter(([name]) => name.startsWith('output_'))
      .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)))
      .map(([, value]) => value),
  );
}

function numericSource(...values: readonly number[]): DataStream<{
  close: number;
}> {
  return new DataStream(
    z.object({close: z.number()}),
    of(...values.map(close => ({close}))),
  );
}

function clockedNumericSource(
  clock: Clock,
  ...values: readonly number[]
): DataStream<{close: number}> {
  return new DataStream(
    z.object({close: z.number()}),
    of(...values.map(close => ({close}))),
    clock,
  );
}

interface TimedNumericDatum {
  readonly time: bigint;
  readonly close: number;
}

const timedNumericSchema = z.object({time: z.bigint(), close: z.number()});

function timedNumericSource(
  ...values: readonly TimedNumericDatum[]
): DataStream<TimedNumericDatum> {
  return new DataStream(timedNumericSchema, of(...values));
}

function timedNumericSubject(
  source: Subject<TimedNumericDatum>,
): DataStream<TimedNumericDatum> {
  return new DataStream(timedNumericSchema, source);
}

class StepSink {
  readonly values: Datum[] = [];
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

  next(value: Datum): void {
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
