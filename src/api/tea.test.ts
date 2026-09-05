// Purpose: Tagged-template API — proves embedded source, interpolation,
// implicit Tea libraries, diagnostics, and the canonical Program projection.

import {describe, expect, test, vi} from 'vitest';
import {Observable, of, Subject} from 'rxjs';
import {
  DataType,
  Field,
  Float64,
  Int32,
  Int64,
  List,
  Schema,
  TimestampMillisecond,
  Utf8,
} from 'apache-arrow';
import * as io from '../runtime/io';
import {d, i, m, ns, w, y, type Clock} from './clock';
import {createNode, type Datum} from './node';
import {DataStream} from './stream';
import {TeaCompileError, tea} from './tea';

const numericSchema = new Schema([new Field('close', new Float64(), false)]);

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
    const source = new DataStream(numericSchema, of({close: 1}));

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
    const source = new DataStream(numericSchema, of({close: 1}, {close: 2}));
    const node = tea`
      length = input.int(14)
      plot(close + length)
    `;
    node.bind(source);
    node.bind({length: 20});
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([21, 22]);
  });

  test('publishes lossless outputs with Node index and source time', async () => {
    const node = tea`plot(close[1])`;
    node.bind(
      timedNumericSource({time: 100n, close: 10}, {time: 200n, close: 20}),
    );
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(sink.values).toEqual([
      {
        index: 0,
        time: 100,
        output0: {series: Number.NaN},
        timed: true,
        provisional: false,
      },
      {
        index: 1,
        time: 200,
        output0: {series: 10},
        timed: true,
        provisional: false,
      },
    ]);
    expect(Object.isFrozen(sink.values[0])).toBe(true);
    expect(Object.isFrozen(sink.values[0]!.output0)).toBe(true);
  });

  test('rejects inexact event time before executing a step', async () => {
    const node = tea`plot(close)`;
    node.bind(timedNumericSource({time: 9_007_199_254_740_993n, close: 10}));
    const sink = new StepSink();

    node.to(sink);

    await expect(sink.completion).rejects.toThrow(
      'DataStream time must be an exact epoch-ms integer',
    );
    expect(sink.values).toEqual([]);
  });

  test('rejects interval close times that move backward', async () => {
    const node = tea`plot(close)`;
    node.bind(
      intervalNumericSource(
        {time: 0n, time_close: 3n, close: 10},
        {time: 1n, time_close: 2n, close: 20},
      ),
    );
    const sink = new StepSink();

    node.to(sink);

    await expect(sink.completion).rejects.toThrow(
      'DataStream time_close must be nondecreasing',
    );
    expect(values(sink)).toEqual([10]);
  });

  test('validates a finite DataStream index count', async () => {
    const shortNode = tea`plot(close)`;
    shortNode.bind(new DataStream(numericSchema, of({close: 1}), i, 2));
    const shortSink = new StepSink();
    shortNode.to(shortSink);
    await expect(shortSink.completion).rejects.toThrow(
      'DataStream emitted 1 values for 2 declared indices',
    );

    const longNode = tea`plot(close)`;
    longNode.bind(
      new DataStream(numericSchema, of({close: 1}, {close: 2}), i, 1),
    );
    const longSink = new StepSink();
    longNode.to(longSink);
    await expect(longSink.completion).rejects.toThrow(
      'DataStream emitted more than its declared 1 indices',
    );
  });

  test('fails shared execution when an observer throws during delivery', async () => {
    let produced = 0;
    let teardowns = 0;
    const source = new DataStream(
      numericSchema,
      new Observable(subscriber => {
        for (const close of [1, 2]) {
          if (subscriber.closed) break;
          produced += 1;
          subscriber.next({close});
        }
        if (!subscriber.closed) subscriber.complete();
        return () => {
          teardowns += 1;
        };
      }),
    );
    const node = tea`plot(close)`;
    node.bind(source);
    const failure = new Error('delivery failed');
    const errors: unknown[] = [];

    const subscription = node.to({
      next() {
        throw failure;
      },
      error(error) {
        errors.push(error);
      },
    });

    expect(produced).toBe(1);
    expect(teardowns).toBe(1);
    expect(errors).toEqual([failure]);
    expect(subscription.closed).toBe(true);
  });

  test('validates each DataStream emission exactly once', async () => {
    const validate = vi.spyOn(io, 'validateRecord');
    const schema = new Schema(
      numericSchema.fields,
      new Map([['test:source', 'once']]),
    );
    const node = tea`plot(close)`;
    node.bind(new DataStream(schema, of({close: 1}, {close: 2})));
    const sink = new StepSink();
    try {
      node.to(sink);
      await sink.completion;
      expect(
        validate.mock.calls.filter(
          ([schema]) => schema.metadata.get('test:source') === 'once',
        ),
      ).toHaveLength(2);
      expect(values(sink)).toEqual([1, 2]);
    } finally {
      validate.mockRestore();
    }
  });

  test('checks demanded Arrow input fields before subscribing or binding', () => {
    const subscribe = vi.fn();
    const cases = [
      new Schema([new Field('open', new Float64(), false)]),
      new Schema([new Field('close', new Utf8(), false)]),
      new Schema([new Field('close', new Float64(), true)]),
      new Schema([
        new Field(
          'close',
          new List(new Field('item', new Float64(), false)),
          false,
        ),
      ]),
    ];
    for (const schema of cases) {
      const node = tea`plot(close)`;
      const before = node.module.remaining();
      const stream = new DataStream(
        schema,
        new Observable(subscriber => {
          subscribe();
          subscriber.complete();
        }),
      );
      expect(() => node.bind(stream)).toThrow(/close/);
      expect(node.module.remaining()).toEqual(before);
    }
    expect(subscribe).not.toHaveBeenCalled();
  });

  test('accepts compatible Arrow numeric fields and millisecond timestamps', async () => {
    const node = tea`plot(close)`;
    const schema = new Schema([
      new Field('time', new TimestampMillisecond(), false),
      new Field('close', new Int32(), false),
    ]);
    node.bind(
      new DataStream(
        schema,
        of(
          {time: -1, close: 10},
          {time: 0n, close: 20},
          {time: Number.MAX_SAFE_INTEGER, close: 30},
        ),
      ),
    );
    const sink = new StepSink();
    node.to(sink);
    await sink.completion;
    expect(values(sink)).toEqual([10, 20, 30]);
    expect(sink.values.map(value => value.time)).toEqual([
      -1,
      0,
      Number.MAX_SAFE_INTEGER,
    ]);
  });

  test('preserves absent and present-null source time in Arrow rows', async () => {
    const node = tea`plot(close)`;
    const schema = new Schema([
      new Field('time', new TimestampMillisecond(), true),
      ...numericSchema.fields,
    ]);
    node.bind(new DataStream(schema, of({close: 1}, {time: null, close: 2})));
    const sink = new StepSink();
    node.to(sink);
    await sink.completion;
    expect(Object.hasOwn(sink.values[0]!, 'time')).toBe(false);
    expect(sink.values[0]!.timed).toBe(false);
    expect(sink.values[1]!.time).toBe(null);
    expect(sink.values[1]!.timed).toBe(true);
  });

  test('isolates supplied and exposed module schemas throughout hot execution', async () => {
    const supplied = tea`plot(close)`.module;
    supplied.manifest.inputs.fields[0]!.metadata.set('test:owner', 'original');
    supplied.manifest.outputs[0]!.channels[0]!.metadata.set(
      'test:owner',
      'original',
    );
    const node = createNode(supplied);
    const rows = new Subject<{close: number}>();
    node.bind(new DataStream(numericSchema, rows));
    supplied.manifest.inputs.fields[0]!.metadata.set('test:owner', 'caller');
    supplied.manifest.outputs[0]!.channels[0]!.metadata.set(
      'test:owner',
      'caller',
    );
    const sink = new StepSink();
    node.to(sink);
    rows.next({close: 10});
    const exposed = node.module;
    exposed.manifest.inputs.fields[0]!.metadata.set('test:owner', 'reader');
    exposed.manifest.outputs[0]!.channels[0]!.metadata.set(
      'test:owner',
      'reader',
    );
    exposed.inputs.fields.splice(0);
    exposed.outputs.fields.splice(0);
    rows.next({close: 20});
    rows.complete();
    await sink.completion;
    expect(values(sink)).toEqual([10, 20]);
    expect(node.module.inputs.fields[0]!.metadata.get('test:owner')).toBe(
      'original',
    );
    const output = node.module.outputs.fields.find(
      field => field.name === 'output0',
    )!;
    expect(DataType.isStruct(output.type)).toBe(true);
    expect(output.type.children[0]!.metadata.get('test:owner')).toBe(
      'original',
    );
  });

  test('does not treat Pine contextual builtins as a third binding kind', () => {
    const node = tea`plot(bar_index)`;

    expect(() => node.bind({bar_index: numericSource(0)})).toThrow(
      "no bind-known root series or static request child matches 'bar_index'",
    );
  });

  test('supplies root contextual builtins from Node construction', async () => {
    const node = tea`
      plot(bar_index)
      plot(last_bar_index)
      plot(barstate.islast ? 1 : 0)
    `;
    node.bind(numericSource(10, 20, 30));
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(outputValues(sink)).toEqual([
      [0, 2, 0],
      [1, 2, 0],
      [2, 2, 1],
    ]);
  });

  test('gives every request child its own contextual builtin index', async () => {
    const node = tea`
      requested = request.security("X", "D", bar_index)
      plot(requested)
    `;
    node.bind(numericSource(10, 20, 30));
    node.bind({requested: numericSource(1, 2, 3)});
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([0, 1, 2]);
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
        numericSchema,
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
        open: new DataStream(
          new Schema([new Field('open', new Float64(), false)]),
          of(1),
          w,
          1,
        ),
      }),
    ).toThrow('bound DataStream clocks disagree');
    expect(node.module.manifest).toEqual(initial.manifest);
    expect(node.module.requests.map(request => request.manifest)).toEqual(
      initial.requests.map(request => request.manifest),
    );
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

  test.each([
    {
      availability: 'end',
      fill: 'carry',
      expected: [NaN, 100, 100, 200, 200, 300],
    },
    {
      availability: 'start',
      fill: 'carry',
      expected: [100, 100, 200, 200, 300, 300],
    },
    {
      availability: 'end',
      fill: 'sparse',
      expected: [NaN, 100, NaN, 200, NaN, 300],
    },
    {
      availability: 'start',
      fill: 'sparse',
      expected: [100, NaN, 200, NaN, 300, NaN],
    },
  ] as const)(
    'synchronizes timed scalar requests with $availability availability and $fill fill',
    async ({availability, fill, expected}) => {
      const node = tea`
        requested = request.security(
          "X",
          "2",
          close,
          availability = "${availability}",
          fill = "${fill}"
        )
        plot(requested)
      `;
      node.bind(
        intervalNumericSource(
          {time: 0n, time_close: 1n, close: 0},
          {time: 1n, time_close: 2n, close: 0},
          {time: 2n, time_close: 3n, close: 0},
          {time: 3n, time_close: 4n, close: 0},
          {time: 4n, time_close: 5n, close: 0},
          {time: 5n, time_close: 6n, close: 0},
        ),
      );
      node.bind({
        requested: intervalNumericSource(
          {time: 0n, time_close: 2n, close: 100},
          {time: 2n, time_close: 4n, close: 200},
          {time: 4n, time_close: 6n, close: 300},
        ),
      });
      const sink = new StepSink();

      node.to(sink);
      await sink.completion;

      expect(values(sink)).toEqual(expected);
    },
  );

  test('falls back to positional scalar matching without complete interval times', async () => {
    const execute = async (
      main: DataStream<unknown>,
      child: DataStream<unknown>,
    ) => {
      const node = tea`
        requested = request.security("X", "2", close)
        plot(requested)
      `;
      node.bind(main);
      node.bind({requested: child});
      const sink = new StepSink();
      node.to(sink);
      await sink.completion;
      return values(sink);
    };
    const interval = () =>
      intervalNumericSource(
        {time: 0n, time_close: 1n, close: 1},
        {time: 1n, time_close: 2n, close: 2},
      );
    const timed = () =>
      timedNumericSource({time: 0n, close: 10}, {time: 1n, close: 20});
    const closeOnly = () =>
      new DataStream(
        new Schema([
          new Field('time_close', new Int64(), false),
          ...numericSchema.fields,
        ]),
        of({time_close: 1n, close: 10}, {time_close: 2n, close: 20}),
      );

    expect(await execute(interval(), timed())).toEqual([10, 20]);
    expect(await execute(timed(), interval())).toEqual([1, 2]);
    expect(await execute(timed(), timed())).toEqual([10, 20]);
    expect(await execute(closeOnly(), closeOnly())).toEqual([10, 20]);
  });

  test('drops scalar child intervals that arrive after their parent boundary', async () => {
    const mainRows = new Subject<IntervalNumericDatum>();
    const childRows = new Subject<IntervalNumericDatum>();
    const node = tea`
      requested = request.security("X", "2", close)
      plot(requested)
    `;
    node.bind(intervalNumericSubject(mainRows));
    node.bind({requested: intervalNumericSubject(childRows)});
    const sink = new StepSink();
    node.to(sink);

    mainRows.next({time: 0n, time_close: 10n, close: 0});
    await sink.waitFor(1);
    childRows.next({time: 0n, time_close: 5n, close: 100});
    mainRows.next({time: 10n, time_close: 20n, close: 0});
    await sink.waitFor(2);
    childRows.complete();
    mainRows.complete();
    await sink.completion;

    expect(values(sink)).toEqual([NaN, NaN]);
  });

  test('drops repeated late child intervals after retaining a current value', async () => {
    const mainRows = new Subject<IntervalNumericDatum>();
    const childRows = new Subject<IntervalNumericDatum>();
    const node = tea`
      requested = request.security("X", "2", close)
      plot(requested)
    `;
    node.bind(intervalNumericSubject(mainRows));
    node.bind({requested: intervalNumericSubject(childRows)});
    const sink = new StepSink();
    node.to(sink);

    childRows.next({time: 0n, time_close: 5n, close: 100});
    mainRows.next({time: 0n, time_close: 10n, close: 0});
    await sink.waitFor(1);
    childRows.next({time: 5n, time_close: 7n, close: 200});
    childRows.next({time: 7n, time_close: 8n, close: 300});
    mainRows.next({time: 10n, time_close: 20n, close: 0});
    mainRows.next({time: 20n, time_close: 30n, close: 0});
    await sink.waitFor(3);
    childRows.complete();
    mainRows.complete();
    await sink.completion;

    expect(values(sink)).toEqual([100, 100, 100]);
  });

  test('rejects an invalid input-bound request policy before execution', () => {
    const node = tea`
      policy = input.string("end")
      requested = request.security("X", "2", close, availability=policy)
      plot(requested)
    `;

    expect(() => node.bind({policy: 'middle'})).toThrow(
      'request 0 has invalid concrete context',
    );

    const fillNode = tea`
      policy = input.string("carry")
      requested = request.security("X", "2", close, fill=policy)
      plot(requested)
    `;
    expect(() => fillNode.bind({policy: 'forward'})).toThrow(
      'request 0 has invalid concrete context',
    );
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

  test('prefers exact interval containment over an unphased clock ratio', async () => {
    const twoMinutes = (2n * m) as Clock;
    const node = tea`
      lower = request.security_lower_tf("X", "1", close)
      plot(close)
      plot(lower.size())
      plot(lower.first())
      plot(lower.last())
    `;
    node.bind({
      close: clockedIntervalNumericSource(
        twoMinutes,
        {time: 0n, time_close: 120_000n, close: 1},
        {time: 120_000n, time_close: 240_000n, close: 2},
      ),
      lower: clockedIntervalNumericSource(
        m,
        {time: 60_000n, time_close: 120_000n, close: 10},
        {time: 120_000n, time_close: 180_000n, close: 20},
        {time: 180_000n, time_close: 240_000n, close: 30},
        {time: 240_000n, time_close: 300_000n, close: 40},
      ),
    });
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(outputValues(sink)).toEqual([
      [1, 1, 10, 10],
      [2, 2, 20, 30],
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

  test('uses typed empty for an explicitly empty timed request stream', async () => {
    const node = tea`
      requested = request.security("X", "D", 42)
      plot(requested)
    `;
    node.bind(
      intervalNumericSource(
        {time: 0n, time_close: 1n, close: 1},
        {time: 1n, time_close: 2n, close: 2},
      ),
    );
    node.bind({
      requested: new DataStream(intervalNumericSchema, of(), i, 0),
    });
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([NaN, NaN]);
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
    expect(node.module.manifest).toEqual(initial.manifest);
    expect(node.module.requests.map(request => request.manifest)).toEqual(
      initial.requests.map(request => request.manifest),
    );
    expect(node.ready()).toBe(false);
    expect(node.bind({x: source, y: source})).toBe(node);
    expect(node.ready()).toBe(true);
  });

  test('keeps request bindings atomic when a later child schema is invalid', () => {
    const node = tea`
      x = request.security("X", "D", close)
      y = request.security("Y", "D", close)
      plot(x + y)
    `;
    const initial = node.module;
    const invalid = new DataStream(
      new Schema([new Field('close', new Utf8(), false)]),
      of({close: 'bad'}),
    );
    expect(() => node.bind({x: numericSource(1), y: invalid})).toThrow(/close/);
    expect(node.module.requests.map(request => request.manifest)).toEqual(
      initial.requests.map(request => request.manifest),
    );
    expect(node.ready()).toBe(false);
  });

  test('fans out one execution and gives late sinks only future results', async () => {
    const rows = new Subject<{close: number}>();
    let sourceSubscriptions = 0;
    const source = new DataStream(
      numericSchema,
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
    expect(first.values[0]).toBe(second.values[0]);
    expect(sourceSubscriptions).toBe(1);
    expect(firstSubscription.closed).toBe(true);
    expect(secondSubscription.closed).toBe(true);
    expect(lateSubscription.closed).toBe(true);
  });

  test('rejects binding after execution starts', async () => {
    const rows = new Subject<{close: number}>();
    const source = new DataStream(numericSchema, rows);
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
      numericSchema,
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
  return sink.values.map(
    result => (result.output0 as {series: unknown} | null)?.series,
  );
}

function outputValues(sink: StepSink): readonly (readonly unknown[])[] {
  return sink.values.map(result =>
    Object.keys(result)
      .filter(name => /^output\d+$/.test(name))
      .sort((left, right) => Number(left.slice(6)) - Number(right.slice(6)))
      .map(name => (result[name] as {series: unknown} | null)?.series),
  );
}

function numericSource(...values: readonly number[]): DataStream<{
  close: number;
}> {
  return new DataStream(
    numericSchema,
    of(...values.map(close => ({close}))),
    i,
    values.length,
  );
}

function clockedNumericSource(
  clock: Clock,
  ...values: readonly number[]
): DataStream<{close: number}> {
  return new DataStream(
    numericSchema,
    of(...values.map(close => ({close}))),
    clock,
    values.length,
  );
}

interface TimedNumericDatum {
  readonly time: bigint;
  readonly close: number;
}

type IntervalNumericDatum = TimedNumericDatum & {
  readonly time_close: bigint;
};

const timedNumericSchema = new Schema([
  new Field('time', new Int64(), false),
  ...numericSchema.fields,
]);
const intervalNumericSchema = new Schema([
  ...timedNumericSchema.fields,
  new Field('time_close', new Int64(), false),
]);

function timedNumericSource(
  ...values: readonly TimedNumericDatum[]
): DataStream<TimedNumericDatum> {
  return new DataStream(timedNumericSchema, of(...values), i, values.length);
}

function timedNumericSubject(
  source: Subject<TimedNumericDatum>,
): DataStream<TimedNumericDatum> {
  return new DataStream(timedNumericSchema, source);
}

function intervalNumericSource(
  ...values: readonly IntervalNumericDatum[]
): DataStream<IntervalNumericDatum> {
  return new DataStream(intervalNumericSchema, of(...values), i, values.length);
}

function clockedIntervalNumericSource(
  clock: Clock,
  ...values: readonly IntervalNumericDatum[]
): DataStream<IntervalNumericDatum> {
  return new DataStream(
    intervalNumericSchema,
    of(...values),
    clock,
    values.length,
  );
}

function intervalNumericSubject(
  source: Subject<IntervalNumericDatum>,
): DataStream<IntervalNumericDatum> {
  return new DataStream(intervalNumericSchema, source);
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
