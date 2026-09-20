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
  test('compiles an indented template into a generated Module', () => {
    const fastWindow = 14;
    let node = tea`
      //@version=1

      fast_window = input.int(${fastWindow}, "Fast window")
      slow_window = input.int(28, "Slow window")
      fast_ema = ta.ema(close, fast_window)
      slow_ema = ta.ema(close, slow_window)
      crossed = ta.crossover(fast_ema, slow_ema)

      emit "output0" fast_ema
      emit "output1" slow_ema
      emit "output2" crossed
    `;

    expect(node.module.parameters.map(param => param.name)).toEqual([
      'fast_window',
      'slow_window',
    ]);
    expect(
      node.module.outputs.schema.fields
        .filter(field => field.metadata.has('tea:write'))
        .map(field => field.name),
    ).toEqual(['output0', 'output1', 'output2']);
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

  test('binding derives Nodes without changing retained configurations or readiness', () => {
    const node = tea`
      length = input.int(14)
      emit "output0" close + length
    `;
    const source = new DataStream(numericSchema, of({close: 1}));
    const withSource = node.bind(source);
    const ready = withSource.bind({length: 20});
    expect(withSource).not.toBe(node);
    expect(ready).not.toBe(withSource);
    expect(node.module.parameters[0]!.value).toBe(14);
    expect(withSource.module.parameters[0]!.value).toBe(14);
    expect(ready.module.parameters[0]!.value).toBe(20);
    expect(node.ready()).toBe(false);
    expect(withSource.ready()).toBe(true);
    expect(ready.ready()).toBe(true);
    expect(node.ready()).toBe(false);
  });

  test('rejects duplicate named streams without changing module configuration', () => {
    let node = tea`emit "output0" close`;
    node = node.bind({close: numericSource(1)});
    const before = node.module;
    expect(() => node.bind({close: numericSource(2)})).toThrow(
      "series 'close' is already bound",
    );
    expect(node.module.inputs).toEqual(before.inputs);
    expect(node.ready()).toBe(true);
  });

  test('a selected source invalidates only the derived Node connections', async () => {
    const node = tea`
      source = input.source(close)
      emit "output0" source
    `.bind(numericSource(10));
    const selected = node.bind({source: 'open'});
    expect(node.ready()).toBe(true);
    expect(selected.ready()).toBe(false);
    const ready = selected.bind(
      new DataStream(
        new Schema([new Field('open', new Float64(), false)]),
        of({open: 20}),
      ),
    );
    const sink = new StepSink();
    ready.to(sink);
    await sink.completion;
    expect(values(sink)).toEqual([20]);
    expect(node.module.parameters[0]!.value).toBe('close');
    expect(node.ready()).toBe(true);
  });

  test('is ready at creation when the Program has no binding requirements', () => {
    let node = tea`emit "output0" 1`;

    expect(node.module.ready()).toBe(true);
    expect(node.module.remaining()).toEqual([]);
    expect(node.ready()).toBe(true);
  });

  test('drives one state-owning runtime from the bound source Observable', async () => {
    const source = new DataStream(numericSchema, of({close: 1}, {close: 2}));
    let node = tea`
      length = input.int(14)
      emit "output0" close + length
    `;
    node = node.bind(source);
    node = node.bind({length: 20});
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([21, 22]);
  });

  test('publishes lossless outputs with Node index and source time', async () => {
    let node = tea`emit "output0" close[1]`;
    node = node.bind(
      timedNumericSource({time: 100n, close: 10}, {time: 200n, close: 20}),
    );
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(sink.values).toEqual([
      {
        index: 0,
        time: 100,
        output0: Number.NaN,
        timed: true,
        provisional: false,
      },
      {
        index: 1,
        time: 200,
        output0: 10,
        timed: true,
        provisional: false,
      },
    ]);
    expect(Object.isFrozen(sink.values[0])).toBe(true);
    expect(Object.isFrozen(sink.values[0]!.output0)).toBe(true);
  });

  test('rejects inexact event time before executing a step', async () => {
    let node = tea`emit "output0" close`;
    node = node.bind(
      timedNumericSource({time: 9_007_199_254_740_993n, close: 10}),
    );
    const sink = new StepSink();

    node.to(sink);

    await expect(sink.completion).rejects.toThrow(
      'DataStream time must be an exact epoch-ms integer',
    );
    expect(sink.values).toEqual([]);
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
    let node = tea`emit "output0" close`;
    node = node.bind(source);
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
    let node = tea`emit "output0" close`;
    node = node.bind(new DataStream(schema, of({close: 1}, {close: 2})));
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
      let node = tea`emit "output0" close`;
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
    let node = tea`emit "output0" close`;
    const schema = new Schema([
      new Field('time', new TimestampMillisecond(), false),
      new Field('close', new Int32(), false),
    ]);
    node = node.bind(
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
    let node = tea`emit "output0" close`;
    const schema = new Schema([
      new Field('time', new TimestampMillisecond(), true),
      ...numericSchema.fields,
    ]);
    node = node.bind(
      new DataStream(schema, of({close: 1}, {time: null, close: 2})),
    );
    const sink = new StepSink();
    node.to(sink);
    await sink.completion;
    expect(Object.hasOwn(sink.values[0]!, 'time')).toBe(false);
    expect(sink.values[0]!.timed).toBe(false);
    expect(sink.values[1]!.time).toBe(null);
    expect(sink.values[1]!.timed).toBe(true);
  });

  test('captures execution schemas independently from earlier binding branches', async () => {
    const supplied = tea`emit "output0" close`.module;
    supplied.inputs.schema.fields[0]!.metadata.set('test:owner', 'original');
    supplied.outputs.schema.fields
      .find(field => field.name === 'output0')!
      .metadata.set('test:owner', 'original');
    let node = createNode(supplied);
    const rows = new Subject<{close: number}>();
    node = node.bind(new DataStream(numericSchema, rows));
    supplied.inputs.schema.fields[0]!.metadata.set('test:owner', 'caller');
    supplied.outputs.schema.fields
      .find(field => field.name === 'output0')!
      .metadata.set('test:owner', 'caller');
    const sink = new StepSink();
    node.to(sink);
    rows.next({close: 10});
    const exposed = node.module;
    exposed.inputs.schema.fields[0]!.metadata.set('test:owner', 'reader');
    exposed.outputs.schema.fields
      .find(field => field.name === 'output0')!
      .metadata.set('test:owner', 'reader');
    exposed.inputs.schema.metadata.set('test:owner', 'reader');
    exposed.outputs.schema.metadata.set('test:owner', 'reader');
    exposed.outputs.schema.fields
      .find(field => field.name === 'output0')!
      .metadata.delete('tea:write');
    expect(exposed).not.toBe(supplied);
    expect(supplied.inputs.schema.fields[0]!.metadata.get('test:owner')).toBe(
      'caller',
    );
    rows.next({close: 20});
    rows.complete();
    await sink.completion;
    expect(values(sink)).toEqual([10, 20]);
    expect(
      node.module.inputs.schema.fields[0]!.metadata.get('test:owner'),
    ).toBe('reader');
    const output = node.module.outputs.schema.fields.find(
      field => field.name === 'output0',
    )!;
    expect(DataType.isFloat(output.type)).toBe(true);
    expect(output.metadata.get('test:owner')).toBe('reader');
  });

  test('does not treat Pine contextual builtins as a third binding kind', () => {
    let node = tea`emit "output0" bar_index`;

    expect(() => node.bind({bar_index: numericSource(0)})).toThrow(
      "no bind-known root series or static request child matches 'bar_index'",
    );
  });

  test('supplies root contextual builtins from Node construction', async () => {
    let node = tea`emit "output0" bar_index`;
    node = node.bind(numericSource(10, 20, 30));
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(outputValues(sink)).toEqual([[0], [1], [2]]);
  });

  test('gives every request child its own contextual builtin index', async () => {
    let node = tea`
      requested = request.security("X", "D", bar_index)
      emit "output0" requested
    `;
    node = node.bind(numericSource(10, 20, 30));
    node = node.bind({requested: numericSource(1, 2, 3)});
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([0, 1, 2]);
  });

  test('binds request streams by declaration name, not requested symbol', async () => {
    let node = tea`
      daily = request.security("X", "D", close)
      weekly = request.security("X", "W", close)
      emit "output0" daily + weekly
    `;

    expect(node.module.requests.map(request => request.name)).toEqual([
      'daily',
      'weekly',
    ]);
    expect(() => node.bind({X: numericSource(1)})).toThrow(
      "no bind-known root series or static request child matches 'X'",
    );
    expect(
      (node = node.bind({
        daily: clockedNumericSource(d, 1),
        weekly: clockedNumericSource(w, 10),
      })),
    ).toBe(node);
    expect(node.ready()).toBe(true);

    const sink = new StepSink();
    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([11]);
  });

  test('allows correcting a request clock after startup fails before subscribing', () => {
    let subscriptions = 0;
    let node = tea`
      period = input.timeframe("D")
      requested = request.security("X", period, close)
      emit "output0" requested
    `;
    node = node.bind({
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
    node = node.bind({period: '1'});
    const sink = new StepSink();
    node.to(sink);
    expect(subscriptions).toBe(1);
    expect(values(sink)).toEqual([1]);
  });

  test('rejects conflicting root clocks before changing binding state', () => {
    let node = tea`emit "output0" close + open`;
    const initial = node.module;

    expect(
      () =>
        (node = node.bind({
          close: clockedNumericSource(d, 1),
          open: new DataStream(
            new Schema([new Field('open', new Float64(), false)]),
            of(1),
            w,
          ),
        })),
    ).toThrow('bound DataStream clocks disagree');
    expect(node.module.inputs).toEqual(initial.inputs);
    expect(node.module.parameters).toEqual(initial.parameters);
    expect(node.module.requests.map(request => request.module.inputs)).toEqual(
      initial.requests.map(request => request.module.inputs),
    );
  });

  test('rejects a count-window ratio outside JavaScript safe integers', () => {
    let node = tea`
      lower = request.security_lower_tf("X", "", close)
      emit "output0" close + lower.size()
    `;
    node = node.bind({
      close: clockedNumericSource(y, 10),
      lower: clockedNumericSource(ns, 1),
    });

    expect(() => node.to(new StepSink())).toThrow('clock ratio is too large');
  });

  test('keeps a request stream bound when its symbol parameter changes', () => {
    let node = tea`
      symbol = input.symbol("X")
      requested = request.security(symbol, "D", close)
      emit "output0" requested
    `;
    node = node.bind({symbol: 'X'});

    node = node.bind({requested: numericSource(1)});
    const oldModule = node.module;
    expect(node.ready()).toBe(true);

    node = node.bind({symbol: 'Y'});
    expect(node.module).not.toBe(oldModule);
    expect(oldModule.requests[0]?.context?.symbol).toBe('X');
    expect(node.module.requests[0]?.context?.symbol).toBe('Y');
    expect(node.ready()).toBe(true);
  });

  test('binds request parameters and streams independently by declaration path', () => {
    let node = tea`
      length = input.int(3)
      requested = request.security("X", "D", close[length])
      emit "output0" requested
    `;
    node = node.bind({length: 6});
    expect(node.module.requests[0]?.module.parameters[0]!.value).toBe(3);
    node = node.bind({length: 8}, ['requested']);
    node = node.bind(numericSource(1), ['requested']);
    expect(node.module.parameters[0]!.value).toBe(6);

    expect(node.ready()).toBe(true);
    expect(
      node.module.requests[0]?.module.parameters.map(param => param.value),
    ).toEqual([8]);
    expect(node.module.requests[0]?.module.inputs.series[0]?.depth).toEqual({
      kind: 'const',
      bars: 8,
    });
  });

  test('rejects inline, function-owned, and nested request calls', () => {
    const inline = () => tea`
      emit "output0" request.security("X", "D", close)
    `;
    const inFunction = () => tea`
      fetch() => request.security("X", "D", close)
      requested = fetch()
      emit "output0" requested
    `;
    const nested = () => tea`
      requested = request.security(
        "X",
        "D",
        request.security("Y", "W", close)
      )
      emit "output0" requested
    `;

    for (const compile of [inline, inFunction, nested]) {
      expect(compile).toThrow(
        'request call must directly initialize one plain top-level variable',
      );
    }
  });

  test('executes scalar requests one-to-one', async () => {
    let node = tea`
      requested = request.security("X", "D", close)
      emit "output0" close + requested
    `;
    node = node.bind({
      close: numericSource(10, 20),
      requested: numericSource(1, 2),
    });
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([11, 22]);
  });

  test.each([
    {fill: 'carry', expected: [100, 100, 200, 200, 300, 300]},
    {fill: 'sparse', expected: [100, NaN, 200, NaN, 300, NaN]},
  ] as const)(
    'synchronizes timed scalar requests with $fill fill',
    async ({fill, expected}) => {
      let node = tea`
        requested = request.security("X", "2", close, fill = "${fill}")
        emit "output0" requested
      `;
      node = node.bind(
        timedNumericSource(
          {time: 0n, close: 0},
          {time: 1n, close: 0},
          {time: 2n, close: 0},
          {time: 3n, close: 0},
          {time: 4n, close: 0},
          {time: 5n, close: 0},
        ),
      );
      node = node.bind({
        requested: timedNumericSource(
          {time: 0n, close: 100},
          {time: 2n, close: 200},
          {time: 4n, close: 300},
        ),
      });
      const sink = new StepSink();

      node.to(sink);
      await sink.completion;

      expect(values(sink)).toEqual(expected);
    },
  );

  test('falls back to positional scalar matching without event times', async () => {
    const execute = async (
      main: DataStream<unknown>,
      child: DataStream<unknown>,
    ) => {
      let node = tea`
        requested = request.security("X", "2", close)
        emit "output0" requested
      `;
      node = node.bind(main);
      node = node.bind({requested: child});
      const sink = new StepSink();
      node.to(sink);
      await sink.completion;
      return values(sink);
    };
    const timed = () =>
      timedNumericSource({time: 0n, close: 10}, {time: 1n, close: 20});
    const untimed = () => numericSource(1, 2);

    expect(await execute(timed(), untimed())).toEqual([1, 2]);
    expect(await execute(untimed(), timed())).toEqual([10, 20]);
    expect(await execute(untimed(), untimed())).toEqual([1, 2]);
  });

  test('rejects scalar children that open before an already served main time', async () => {
    const mainRows = new Subject<TimedNumericDatum>();
    const childRows = new Subject<TimedNumericDatum>();
    let node = tea`
      requested = request.security("X", "2", close)
      emit "output0" requested
    `;
    node = node.bind(timedNumericSubject(mainRows));
    node = node.bind({requested: timedNumericSubject(childRows)});
    const sink = new StepSink();
    node.to(sink);

    mainRows.next({time: 10n, close: 0});
    await sink.waitFor(1);
    childRows.next({time: 5n, close: 100});
    await expect(sink.completion).rejects.toThrow(
      'after its parent interval finalized',
    );
    expect(values(sink)).toEqual([NaN]);
  });

  test('rejects a new late child after retaining a current value', async () => {
    const mainRows = new Subject<TimedNumericDatum>();
    const childRows = new Subject<TimedNumericDatum>();
    let node = tea`
      requested = request.security("X", "2", close)
      emit "output0" requested
    `;
    node = node.bind(timedNumericSubject(mainRows));
    node = node.bind({requested: timedNumericSubject(childRows)});
    const sink = new StepSink();
    node.to(sink);

    childRows.next({time: 5n, close: 100});
    mainRows.next({time: 10n, close: 0});
    await sink.waitFor(1);
    childRows.next({time: 6n, close: 200});
    await expect(sink.completion).rejects.toThrow(
      'after its parent interval finalized',
    );
    expect(values(sink)).toEqual([100]);
  });

  test('rejects an invalid input-bound request policy before execution', () => {
    const fillNode = tea`
      policy = input.string("carry")
      requested = request.security("X", "2", close, fill=policy)
      emit "output0" requested
    `;
    expect(() => fillNode.bind({policy: 'forward'})).toThrow(
      'request 0 has invalid concrete context',
    );
  });

  test('collects lower-timeframe values by regular clock count', async () => {
    const twoMinutes = (2n * m) as Clock;
    let node = tea`
      lower = request.security_lower_tf("X", "1", close)
      emit "output0" close
      emit "output1" lower.size()
      emit "output2" lower.first()
      emit "output3" lower.last()
    `;
    node = node.bind({
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
    let node = tea`
      lower = request.security_lower_tf("X", "", close)
      emit "output0" close
      emit "output1" lower.size()
    `;
    node = node.bind({
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
    let node = tea`
      requested = request.security("X", "D", 42)
      emit "output0" requested
    `;
    node = node.bind(
      timedNumericSource({time: 0n, close: 1}, {time: 1n, close: 2}),
    );
    node = node.bind({
      requested: new DataStream(timedNumericSchema, of(), i),
    });
    const sink = new StepSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([NaN, NaN]);
  });

  test('rejects lower-timeframe values that arrive after their window', async () => {
    const mainRows = new Subject<TimedNumericDatum>();
    const childRows = new Subject<TimedNumericDatum>();
    let node = tea`
      lower = request.security_lower_tf("X", "", close)
      emit "output0" close
      emit "output1" lower.size()
      emit "output2" lower.first()
    `;
    node = node.bind({
      close: timedNumericSubject(mainRows),
      lower: timedNumericSubject(childRows),
    });
    const sink = new StepSink();
    node.to(sink);

    childRows.next({time: 5n, close: 1});
    mainRows.next({time: 10n, close: 10});
    await sink.waitFor(1);

    childRows.next({time: 8n, close: 99});
    await expect(sink.completion).rejects.toThrow(
      'after its parent interval finalized',
    );
    expect(outputValues(sink)).toEqual([[10, 1, 1]]);
  });

  test('falls back to one-to-one arrays without clocks or event time', async () => {
    let node = tea`
      lower = request.security_lower_tf("X", "D", close)
      emit "output0" close
      emit "output1" lower.size()
      emit "output2" lower.first()
    `;
    node = node.bind({
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
    let node = tea`
      x = request.security("X", "D", close)
      y = request.security("Y", "D", close)
      emit "output0" x + y
    `;
    const initial = node.module;
    const source = numericSource(1);

    expect(() => node.bind({x: source, missing: source})).toThrow(
      "no bind-known root series or static request child matches 'missing'",
    );
    expect(node.module.inputs).toEqual(initial.inputs);
    expect(node.module.parameters).toEqual(initial.parameters);
    expect(node.module.requests.map(request => request.module.inputs)).toEqual(
      initial.requests.map(request => request.module.inputs),
    );
    expect(node.ready()).toBe(false);
    const bound = node.bind({x: source, y: source});
    expect(bound).not.toBe(node);
    expect(bound.ready()).toBe(true);
    expect(node.ready()).toBe(false);
  });

  test('keeps request bindings atomic when a later child schema is invalid', () => {
    let node = tea`
      x = request.security("X", "D", close)
      y = request.security("Y", "D", close)
      emit "output0" x + y
    `;
    const initial = node.module;
    const invalid = new DataStream(
      new Schema([new Field('close', new Utf8(), false)]),
      of({close: 'bad'}),
    );
    expect(() => node.bind({x: numericSource(1), y: invalid})).toThrow(/close/);
    expect(node.module.requests.map(request => request.module.inputs)).toEqual(
      initial.requests.map(request => request.module.inputs),
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
    let node = tea`emit "output0" close`;
    node = node.bind(source);
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

  test('derived executions have independent state and timestamp ordering', async () => {
    const template = tea`
      scale = input.int(1)
      var float total = 0.0
      total := total + close * scale
      emit "output0" total
    `.bind(timedNumericSource({time: 1n, close: 2}, {time: 2n, close: 3}));
    const first = template.bind({scale: 2});
    const one = new StepSink();
    first.to(one);
    await one.completion;
    // The first source already reached time 2; this independent subscription starts at time 1.
    const second = first.bind({scale: 3});
    const two = new StepSink();
    second.to(two);
    await two.completion;
    expect(values(one)).toEqual([4, 10]);
    expect(values(two)).toEqual([6, 15]);
    expect(template.module.parameters[0]!.value).toBe(1);
    expect(first.module.parameters[0]!.value).toBe(2);
    first.dispose();
    second.dispose();
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
    let node = tea`emit "output0" close`;
    node = node.bind(source);
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

  test('disposing one derived execution leaves its sibling connected', async () => {
    const rows = new Subject<{close: number}>();
    const template = tea`
      scale = input.int(1)
      emit "output0" close * scale
    `.bind(new DataStream(numericSchema, rows));
    const first = template.bind({scale: 2});
    const second = template.bind({scale: 3});
    const one = new StepSink();
    const two = new StepSink();
    first.to(one);
    second.to(two);
    rows.next({close: 1});
    first.dispose();
    rows.next({close: 2});
    rows.complete();
    await Promise.all([one.completion, two.completion]);
    expect(values(one)).toEqual([2]);
    expect(values(two)).toEqual([3, 6]);
    expect(template.module.parameters[0]!.value).toBe(1);
    second.dispose();
  });
});

function values(sink: StepSink): readonly unknown[] {
  return sink.values.map(result => result.output0);
}

function outputValues(sink: StepSink): readonly (readonly unknown[])[] {
  return sink.values.map(result =>
    Object.keys(result)
      .filter(name => /^output\d+$/.test(name))
      .sort((left, right) => Number(left.slice(6)) - Number(right.slice(6)))
      .map(name => result[name]),
  );
}

function numericSource(...values: readonly number[]): DataStream<{
  close: number;
}> {
  return new DataStream(
    numericSchema,
    of(...values.map(close => ({close}))),
    i,
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
  );
}

interface TimedNumericDatum {
  readonly time: bigint;
  readonly close: number;
}

const timedNumericSchema = new Schema([
  new Field('time', new Int64(), false),
  ...numericSchema.fields,
]);

function timedNumericSource(
  ...values: readonly TimedNumericDatum[]
): DataStream<TimedNumericDatum> {
  return new DataStream(timedNumericSchema, of(...values), i);
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
