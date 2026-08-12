// Purpose: JSRuntime tests — hand-lowered modules (the exact shape codegen will emit) drive bind, frames, rings, and the provisional/commit protocol end to end.

import {describe, expect, test} from 'bun:test';
import {Storage} from '../ir/node';
import {
  BindError,
  type AggregateLayoutManifest,
  type BindInputs,
  type DataProvider,
  type ExecutionSpec,
  type ModuleCode,
  type OutputSink,
  type ProviderContext,
  type RangeDemand,
  RUNTIME_ABI_VERSION,
  type SeriesData,
  type TeaModule,
  type TimeAxis,
  type Value,
} from './abi';
import {bind as bindRuntime} from './js-runtime';

const TEST_TIME_NOW = 1_800_000_000_000;

function bind(
  module: TeaModule,
  inputs: Omit<BindInputs, 'timeNow'> & {readonly timeNow?: number},
) {
  return bindRuntime(module, {
    ...inputs,
    timeNow: inputs.timeNow ?? TEST_TIME_NOW,
  });
}

const NUMBER_LAYOUT = 0;
const TEST_LAYOUTS = {
  layouts: [{kind: 'number', numeric: 'float'}],
} as const satisfies AggregateLayoutManifest;

// ---- test doubles -----------------------------------------------------------

class ArraySeries implements SeriesData {
  constructor(readonly values: number[]) {}
  get length(): number {
    return this.values.length;
  }
  at(index: number): number {
    return this.values[index];
  }
}

function provider(
  series: Record<string, ArraySeries>,
  axis: TimeAxis | null = null,
): DataProvider {
  const rows = Math.max(0, ...Object.values(series).map(s => s.length));
  const context: ProviderContext = {
    rows,
    axis,
    series: (id: string) => series[id] ?? null,
    builtinValue: () => undefined,
  };
  return {resolveContext: () => Promise.resolve(context)};
}

function providerFromContext(context: ProviderContext): DataProvider {
  return {resolveContext: () => Promise.resolve(context)};
}

class RecordingSink implements OutputSink {
  declared: Parameters<OutputSink['declare']>[0]['outputs'] = [];
  readonly emits: {
    row: number;
    oid: number;
    channels: readonly Value[];
    provisional: boolean;
  }[] = [];

  declare(declaration: Parameters<OutputSink['declare']>[0]): void {
    this.declared = declaration.outputs;
  }

  publish(publication: Parameters<OutputSink['publish']>[0]): void {
    for (const output of publication.outputs) {
      this.emits.push({
        row: publication.row,
        oid: output.outputId,
        channels: [...output.channels],
        provisional: publication.provisional,
      });
    }
  }
}

const PLOT_OUTPUT = {
  effect: 'plot',
  staticArgs: [],
  channels: [{name: 'series', type: 'float', transport: {kind: 'float'}}],
} as const;

function num(v: Value): number {
  return v as number;
}

// ---- an ema-shaped module ---------------------------------------------------
// var e = na
// e := na(e) ? close : 0.5 * close + 0.5 * e
// plot(e)

const EMA_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    execution: [],
    params: [],
    outputs: [PLOT_OUTPUT],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.Var,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  bind() {},
  inits: {'0:0': () => NaN},
  funcs: {},
  main(rt, fr) {
    const e = num(rt.read(fr, 0, 0));
    const close = rt.series(0, 0);
    rt.write(fr, 0, Number.isNaN(e) ? close : 0.5 * close + 0.5 * e);
    rt.emit(0, 0, rt.read(fr, 0, 0));
  },
};

describe('historical execution', () => {
  test('var state carries across committed rows', async () => {
    const sink = new RecordingSink();
    const bound = await bind(EMA_MODULE, {
      params: {},
      provider: provider({close: new ArraySeries([10, 20, 30])}),
      sink,
    });
    expect(bound.rows).toBe(3);
    await bound.runAll();
    expect(sink.emits.map(e => e.channels[0])).toEqual([10, 15, 22.5]);
    expect(sink.emits.every(e => !e.provisional)).toBe(true);
  });
});

// ---- two call sites, one func ----------------------------------------------
// counter() => var c = 0; c := c + 1; c

const COUNTER_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    execution: [],
    params: [],
    outputs: [
      {
        effect: 'plot',
        staticArgs: [],
        channels: [
          {name: 'a', type: 'int', transport: {kind: 'int'}},
          {name: 'b', type: 'int', transport: {kind: 'int'}},
        ],
      },
    ],
    effects: [],
    requests: [],
    frames: [
      {locals: [], subs: [{fid: 1}, {fid: 1}]},
      {
        locals: [
          {
            storage: Storage.Var,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  bind() {},
  inits: {'1:0': () => 0},
  funcs: {
    1(rt, fr) {
      rt.write(fr, 0, num(rt.read(fr, 0, 0)) + 1);
      return rt.read(fr, 0, 0);
    },
  },
  main(rt, fr) {
    const a = COUNTER_MODULE.funcs[1](rt, rt.frame(fr, 0)) as Value;
    const b = COUNTER_MODULE.funcs[1](rt, rt.frame(fr, 1)) as Value;
    rt.emit(0, 0, a);
    rt.emit(0, 1, b);
  },
};

describe('frames', () => {
  test('call sites share the compiled body but own separate state', async () => {
    const sink = new RecordingSink();
    const bound = await bind(COUNTER_MODULE, {
      params: {},
      provider: provider({close: new ArraySeries([1, 1, 1])}),
      sink,
    });
    await bound.runAll();
    expect(sink.emits.map(e => e.channels)).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });
});

// ---- name history -----------------------------------------------------------
// x = close; plot(x[2])

const HISTORY_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    execution: [],
    params: [],
    outputs: [PLOT_OUTPUT],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            layout: NUMBER_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  bind() {},
  inits: {},
  funcs: {},
  main(rt, fr) {
    rt.write(fr, 0, rt.series(0, 0));
    rt.emit(0, 0, rt.read(fr, 0, 2));
  },
};

describe('rings', () => {
  test('history offsets see committed cells; early rows read na', async () => {
    const sink = new RecordingSink();
    const bound = await bind(HISTORY_MODULE, {
      params: {},
      provider: provider({close: new ArraySeries([1, 2, 3, 4])}),
      sink,
    });
    await bound.runAll();
    const values = sink.emits.map(e => e.channels[0]);
    expect(Number.isNaN(num(values[0]))).toBe(true);
    expect(Number.isNaN(num(values[1]))).toBe(true);
    expect(values[2]).toBe(1);
    expect(values[3]).toBe(2);
  });
});

// ---- provisional protocol ---------------------------------------------------
// var v = 0;   v := v + close     (rolls back per tick)
// varip p = 0; p := p + 1         (accumulates across ticks)
// x = close                       (perBar)

const TICK_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    execution: [],
    params: [],
    outputs: [
      {
        effect: 'plot',
        staticArgs: [],
        channels: [
          {name: 'v', type: 'float', transport: {kind: 'float'}},
          {name: 'p', type: 'int', transport: {kind: 'int'}},
          {name: 'x', type: 'float', transport: {kind: 'float'}},
        ],
      },
    ],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.Var,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
          {
            storage: Storage.Varip,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  bind() {},
  inits: {'0:0': () => 0, '0:1': () => 0},
  funcs: {},
  main(rt, fr) {
    rt.write(fr, 0, num(rt.read(fr, 0, 0)) + rt.series(0, 0));
    rt.write(fr, 1, num(rt.read(fr, 1, 0)) + 1);
    rt.write(fr, 2, rt.series(0, 0));
    rt.emit(0, 0, rt.read(fr, 0, 0));
    rt.emit(0, 1, rt.read(fr, 1, 0));
    rt.emit(0, 2, rt.read(fr, 2, 0));
  },
};

describe('provisional protocol', () => {
  test('ticks re-execute from committed state; varip alone accumulates', async () => {
    const sink = new RecordingSink();
    const close = new ArraySeries([10, 5]);
    const bound = await bind(TICK_MODULE, {
      params: {},
      provider: provider({close}),
      sink,
    });

    // Row 0 lives: two provisional ticks with changing values, then close.
    bound.executeRow(0, true);
    close.values[0] = 11;
    bound.executeRow(0, true);
    close.values[0] = 12;
    bound.executeRow(0, false);
    bound.commitRow(0);
    // Row 1 straight to committed.
    bound.executeRow(1, false);
    bound.commitRow(1);

    const [tick1, tick2, commit0, commit1] = sink.emits;
    // var rolls back to its initializer until something commits.
    expect(tick1.channels[0]).toBe(10);
    expect(tick2.channels[0]).toBe(11);
    expect(commit0.channels[0]).toBe(12);
    expect(commit1.channels[0]).toBe(17); // 12 committed + 5
    // varip accumulates across the three executions of row 0.
    expect(tick1.channels[1]).toBe(1);
    expect(tick2.channels[1]).toBe(2);
    expect(commit0.channels[1]).toBe(3);
    expect(commit1.channels[1]).toBe(4);
    expect(tick1.provisional).toBe(true);
    expect(commit0.provisional).toBe(false);
  });

  test('for var and perBar, ticks then commit equals never having ticked', async () => {
    const run = async (withTicks: boolean) => {
      const sink = new RecordingSink();
      const close = new ArraySeries([12, 5]);
      const bound = await bind(TICK_MODULE, {
        params: {},
        provider: provider({close}),
        sink,
      });
      if (withTicks) {
        close.values[0] = 10;
        bound.executeRow(0, true);
        close.values[0] = 12;
      }
      bound.executeRow(0, false);
      bound.commitRow(0);
      bound.executeRow(1, false);
      bound.commitRow(1);
      return sink.emits.filter(e => !e.provisional);
    };
    const ticked = await run(true);
    const clean = await run(false);
    // var and perBar channels agree; varip legitimately differs.
    expect(ticked.map(e => [e.channels[0], e.channels[2]])).toEqual(
      clean.map(e => [e.channels[0], e.channels[2]]),
    );
  });
});

// ---- bind-time section ------------------------------------------------------
// level = input.float(70.0, minval=0)
// hline(level)  +  a bound-depth local read at offset len

const BIND_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    execution: [],
    params: [
      {
        name: 'level',
        title: null,
        type: 'float',
        control: 'auto',
        group: null,
        inline: null,
        tooltip: null,
        confirm: false,
        display: 'all',
        defaultValue: 70,
        constraints: {
          kind: 'range',
          minval: 0,
          maxval: null,
          step: null,
        },
        enumType: null,
        seriesSid: null,
      },
      {
        name: 'len',
        title: null,
        type: 'int',
        control: 'auto',
        group: null,
        inline: null,
        tooltip: null,
        confirm: false,
        display: 'all',
        defaultValue: 2,
        constraints: null,
        enumType: null,
        seriesSid: null,
      },
    ],
    outputs: [{effect: 'hline', staticArgs: [], channels: []}, PLOT_OUTPUT],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'bound'},
            layout: NUMBER_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init(rt) {
    rt.bindDepth(0, 0, num(rt.param(1)));
  },
  bind(rt) {
    rt.bindOutput(0, 'price', rt.param(0));
  },
  inits: {},
  funcs: {},
  main(rt, fr) {
    rt.write(fr, 0, rt.series(0, 0));
    rt.emit(1, 0, rt.read(fr, 0, num(rt.param(1))));
  },
};

describe('binding', () => {
  test('init and bind evaluate their owned binding expressions', async () => {
    const sink = new RecordingSink();
    const bound = await bind(BIND_MODULE, {
      params: {level: 105, len: 2},
      provider: provider({close: new ArraySeries([1, 2, 3, 4])}),
      sink,
    });
    expect(sink.declared[0].boundArgs).toEqual([{name: 'price', value: 105}]);
    await bound.runAll();
    const values = sink.emits.map(e => e.channels[0]);
    expect(Number.isNaN(num(values[1]))).toBe(true);
    expect(values[2]).toBe(1);
    expect(values[3]).toBe(2);
  });

  test('bind failures are user-facing errors', async () => {
    const inputs = {
      provider: provider({close: new ArraySeries([1])}),
      sink: new RecordingSink(),
    };
    expect(() => bind(BIND_MODULE, {...inputs, params: {level: -1}})).toThrow(
      BindError,
    );
    expect(() => bind(BIND_MODULE, {...inputs, params: {nope: 1}})).toThrow(
      "unknown parameter 'nope'",
    );
    expect(() =>
      bind(EMA_MODULE, {...inputs, params: {}, provider: provider({})}),
    ).toThrow("series 'close' is not provided");
    expect(() =>
      bind(TICK_MODULE, {
        ...inputs,
        params: {},
        provider: provider({close: new ArraySeries([1, 2])}),
      }),
    ).not.toThrow();
  });
});

describe('typed execution inputs', () => {
  const INT_LAYOUT = 0;
  const BOOL_LAYOUT = 1;
  const STRING_LAYOUT = 2;
  const layouts = {
    layouts: [
      {kind: 'number', numeric: 'int'},
      {kind: 'boolean'},
      {kind: 'nullable-scalar', scalar: 'string'},
    ],
  } as const satisfies AggregateLayoutManifest;
  const execution = [
    {
      source: {domain: 'time', field: 'time'},
      layout: INT_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'time', field: 'time_close'},
      layout: INT_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'time', field: 'timenow'},
      layout: INT_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'bar', field: 'bar_index'},
      layout: INT_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'bar', field: 'last_bar_index'},
      layout: INT_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'barstate', field: 'isfirst'},
      layout: BOOL_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'barstate', field: 'islast'},
      layout: BOOL_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'barstate', field: 'ishistory'},
      layout: BOOL_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'barstate', field: 'isrealtime'},
      layout: BOOL_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'barstate', field: 'isconfirmed'},
      layout: BOOL_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'barstate', field: 'isnew'},
      layout: BOOL_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'syminfo', field: 'tickerid'},
      layout: STRING_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
    {
      source: {domain: 'timeframe', field: 'period'},
      layout: STRING_LAYOUT,
      depth: {kind: 'const', bars: 1},
    },
  ] as const satisfies readonly ExecutionSpec[];

  function executionContext(
    builtinValue: ProviderContext['builtinValue'] = source =>
      source.domain === 'syminfo' && source.field === 'tickerid'
        ? 'NASDAQ:AAPL'
        : source.domain === 'timeframe' && source.field === 'period'
          ? 'D'
          : undefined,
  ): ProviderContext {
    return {
      rows: 3,
      axis: regularAxis(100, 10, 3),
      series: () => null,
      builtinValue,
    };
  }

  function executionModule(): TeaModule {
    return {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: layouts,
      manifest: {
        series: [],
        execution,
        params: [],
        outputs: [
          {
            effect: 'probe',
            staticArgs: [],
            channels: execution.map((_, index) => ({
              name: `value${index}`,
              type: 'value',
              transport:
                index < 5 || index === 13
                  ? ({kind: 'int'} as const)
                  : index < 12
                    ? ({kind: 'bool'} as const)
                    : ({kind: 'string'} as const),
            })),
          },
          {
            effect: 'history',
            staticArgs: [],
            channels: [
              {name: 'time', type: 'int', transport: {kind: 'int'}},
              {name: 'barstate', type: 'bool', transport: {kind: 'bool'}},
              {name: 'tickerid', type: 'string', transport: {kind: 'string'}},
              {name: 'timenow', type: 'int', transport: {kind: 'int'}},
            ],
          },
        ],
        effects: [],
        requests: [],
        frames: [{locals: [], subs: []}],
      },
      requests: [],
      init() {},
      bind() {},
      inits: {},
      funcs: {},
      main(rt) {
        execution.forEach((_, eid) => rt.emit(0, eid, rt.execution(eid, 0)));
        rt.emit(1, 0, rt.execution(0, 1));
        rt.emit(1, 1, rt.execution(7, 1));
        rt.emit(1, 2, rt.execution(11, 1));
        rt.emit(1, 3, rt.execution(2, 1));
      },
    };
  }

  test('resolves row, extent, context, and fixed-history values exactly', async () => {
    const sink = new RecordingSink();
    const bound = await bind(executionModule(), {
      params: {},
      provider: providerFromContext(executionContext()),
      sink,
      timeNow: 1_777_777_777_777,
    });
    await bound.runAll();
    const current = sink.emits.filter(event => event.oid === 0);
    expect(current.map(event => event.channels.slice(0, 5))).toEqual([
      [100, 110, 1_777_777_777_777, 0, 2],
      [110, 120, 1_777_777_777_777, 1, 2],
      [120, 130, 1_777_777_777_777, 2, 2],
    ]);
    expect(current.map(event => event.channels.slice(5, 11))).toEqual([
      [true, false, true, false, true, true],
      [false, false, true, false, true, true],
      [false, true, true, false, true, true],
    ]);
    expect(current.map(event => event.channels.slice(11))).toEqual([
      ['NASDAQ:AAPL', 'D'],
      ['NASDAQ:AAPL', 'D'],
      ['NASDAQ:AAPL', 'D'],
    ]);
    const history = sink.emits.filter(event => event.oid === 1);
    expect(history[0].channels[0]).toBeNaN();
    expect(history[0].channels.slice(1, 3)).toEqual([false, null]);
    expect(history[0].channels[3]).toBeNaN();
    expect(history.slice(1).map(event => event.channels)).toEqual([
      [100, true, 'NASDAQ:AAPL', 1_777_777_777_777],
      [110, true, 'NASDAQ:AAPL', 1_777_777_777_777],
    ]);
  });

  test('simple context metadata is available during bind', async () => {
    const seen: Value[] = [];
    const base = executionModule();
    const module: TeaModule = {
      ...base,
      bind(rt) {
        seen.push(rt.execution(11, 0), rt.execution(12, 0));
      },
    };
    await bind(module, {
      params: {},
      provider: providerFromContext(executionContext()),
      sink: new RecordingSink(),
      timeNow: 1_777_777_777_777,
    });
    expect(seen).toEqual(['NASDAQ:AAPL', 'D']);
  });

  test('series-qualified execution inputs fail loudly during bind', async () => {
    for (const eid of [0, 2, 3, 5]) {
      const base = executionModule();
      const module: TeaModule = {
        ...base,
        bind(rt) {
          rt.execution(eid, 0);
        },
      };
      await expect(
        bind(module, {
          params: {},
          provider: providerFromContext(executionContext()),
          sink: new RecordingSink(),
          timeNow: 1_777_777_777_777,
        }),
      ).rejects.toThrow('is not bind-visible');
    }
  });

  test('missing demanded metadata and a missing demanded axis fail at bind', async () => {
    await expect(
      bind(executionModule(), {
        params: {},
        provider: providerFromContext(executionContext(() => undefined)),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow("builtin 'syminfo.tickerid' is not provided");

    const withoutAxis = {...executionContext(), axis: null};
    await expect(
      bind(executionModule(), {
        params: {},
        provider: providerFromContext(withoutAxis),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow("builtin 'time' requires a time axis");
  });

  test('provider typed empty metadata is a value, not missing', async () => {
    const base = executionModule();
    const module: TeaModule = {
      ...base,
      manifest: {
        ...base.manifest,
        execution: [execution[11]],
        outputs: [
          {
            effect: 'probe',
            staticArgs: [],
            channels: [
              {name: 'tickerid', type: 'string', transport: {kind: 'string'}},
            ],
          },
        ],
      },
      main(rt) {
        rt.emit(0, 0, rt.execution(0, 0));
      },
    };
    const sink = new RecordingSink();
    const bound = await bind(module, {
      params: {},
      provider: providerFromContext(executionContext(() => null)),
      sink,
    });
    await bound.runAll();
    expect(sink.emits.map(event => event.channels[0])).toEqual([
      null,
      null,
      null,
    ]);
  });

  test('timeNow rejects na, infinities, fractions, and unsafe integers', async () => {
    for (const invalid of [
      undefined as unknown as number,
      NaN,
      Infinity,
      -Infinity,
      1.5,
      2 ** 53,
    ]) {
      await expect(
        bindRuntime(executionModule(), {
          params: {},
          provider: providerFromContext(executionContext()),
          sink: new RecordingSink(),
          timeNow: invalid,
        }),
      ).rejects.toThrow('timeNow must be a finite safe epoch-ms integer');
    }
  });
});

// ---- requests ---------------------------------------------------------------
// r = request.security("X", "", close * scale)   (child reads a parent param)
// plot(r), plot(r[1])

function regularAxis(start: number, span: number, rows: number) {
  void rows;
  return {
    time: (row: number) => start + row * span,
    closeTime: (row: number) => start + (row + 1) * span,
  };
}

function context(
  series: Record<string, ArraySeries>,
  axis: ReturnType<typeof regularAxis> | null,
): ProviderContext {
  const rows = Math.max(0, ...Object.values(series).map(s => s.length));
  return {
    rows,
    axis,
    series: (id: string) => series[id] ?? null,
    builtinValue: () => undefined,
  };
}

// Routes by symbol; unknown symbols are typed context errors.
function contexts(byId: Record<string, ProviderContext>): DataProvider {
  return {
    resolveContext: (symbol: string) =>
      Promise.resolve(
        byId[symbol] ?? {
          error: 'unknownSymbol' as const,
          detail: `no context '${symbol}'`,
        },
      ),
  };
}

const CHILD_MODULE = {
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    execution: [],
    params: [],
    outputs: [],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  bind() {},
  inits: {},
  funcs: {},
  main(
    rt: Parameters<TeaModule['main']>[0],
    fr: Parameters<TeaModule['main']>[1],
  ) {
    // Bind-time params are compilation-global: pid 0 is the PARENT's param.
    rt.write(fr, 0, rt.series(0, 0) * num(rt.param(0)));
  },
} satisfies ModuleCode;

function requestModule(
  overrides: Partial<{
    gaps: boolean;
    lookahead: boolean;
    ignoreInvalidSymbol: boolean;
    calcBarsCount: number;
  }>,
): TeaModule {
  const options = {
    gaps: false,
    lookahead: false,
    ignoreInvalidSymbol: false,
    calcBarsCount: 0,
    ...overrides,
  };
  return {
    abi: RUNTIME_ABI_VERSION,
    aggregateLayouts: TEST_LAYOUTS,
    manifest: {
      series: [{id: 'close', depth: {kind: 'none'}}],
      execution: [],
      params: [
        {
          name: 'scale',
          title: null,
          type: 'float',
          control: 'auto',
          group: null,
          inline: null,
          tooltip: null,
          confirm: false,
          display: 'all',
          defaultValue: 10,
          constraints: null,
          enumType: null,
          seriesSid: null,
        },
      ],
      outputs: [
        {
          effect: 'plot',
          staticArgs: [],
          channels: [
            {name: 'r', type: 'float', transport: {kind: 'float'}},
            {name: 'prev', type: 'float', transport: {kind: 'float'}},
          ],
        },
      ],
      effects: [],
      requests: [
        {
          merge: {mode: 'sample'},
          depth: {kind: 'const', bars: 1},
          resultSlot: 0,
          layout: NUMBER_LAYOUT,
          dynamic: false,
        },
      ],
      frames: [{locals: [], subs: []}],
    },
    requests: [CHILD_MODULE],
    init() {},
    bind(rt) {
      rt.bindRequestOptions(
        0,
        options.gaps,
        options.lookahead,
        options.ignoreInvalidSymbol,
        options.calcBarsCount,
      );
      rt.bindRequest(0, 'X', '');
    },
    inits: {},
    funcs: {},
    main(rt) {
      rt.emit(0, 0, rt.request(0, 0));
      rt.emit(0, 1, rt.request(0, 1));
    },
  };
}

describe('requests', () => {
  const parent = () =>
    context({close: new ArraySeries([1, 2, 3, 4, 5, 6])}, regularAxis(0, 1, 6));
  const child = () =>
    context({close: new ArraySeries([10, 20, 30])}, regularAxis(0, 2, 3));

  test('a child runs on its own context and merges committed results', async () => {
    const sink = new RecordingSink();
    const bound = await bind(requestModule({}), {
      params: {},
      provider: contexts({'': parent(), X: child()}),
      sink,
    });
    await bound.runAll();
    // Child values scale by the PARENT's param default (10): 100, 200, 300.
    // lookahead_off over 2-span child bars: closed at t=2,4,6.
    expect(sink.emits.map(e => e.channels[0])).toEqual([
      NaN,
      100,
      100,
      200,
      200,
      300,
    ]);
    // History reads the merged view one parent row back — never the child.
    expect(sink.emits.map(e => e.channels[1])).toEqual([
      NaN,
      NaN,
      100,
      100,
      200,
      200,
    ]);
  });

  test('calc_bars_count zero is full; positive is an exact defensively-clamped tail; oversized stays full', async () => {
    async function valuesFor(calcBarsCount: number): Promise<{
      readonly values: readonly Value[];
      readonly ranges: readonly RangeDemand[];
    }> {
      const ranges: RangeDemand[] = [];
      const byId = {'': parent(), X: child()};
      const provider: DataProvider = {
        resolveContext(symbol, _timeframe, range) {
          ranges.push(range);
          // Deliberately over-return every context. JSRuntime must still
          // expose the exact trailing child extent it requested.
          return Promise.resolve(
            byId[symbol as keyof typeof byId] ?? {
              error: 'unknownSymbol' as const,
              detail: `no context '${symbol}'`,
            },
          );
        },
      };
      const sink = new RecordingSink();
      const bound = await bind(requestModule({calcBarsCount}), {
        params: {},
        provider,
        sink,
      });
      await bound.runAll();
      return {
        values: sink.emits.map(event => event.channels[0]),
        ranges,
      };
    }

    const full = await valuesFor(0);
    expect(full.values).toEqual([NaN, 100, 100, 200, 200, 300]);
    expect(full.ranges).toEqual([{kind: 'full'}, {kind: 'full'}]);

    const trailing = await valuesFor(2);
    expect(trailing.values).toEqual([NaN, NaN, NaN, 200, 200, 300]);
    expect(trailing.ranges).toEqual([
      {kind: 'full'},
      {kind: 'trailing-bars', bars: 2},
    ]);

    const oversized = await valuesFor(10);
    expect(oversized.values).toEqual(full.values);
    expect(oversized.ranges).toEqual([
      {kind: 'full'},
      {kind: 'trailing-bars', bars: 10},
    ]);
  });

  test('request options are mandatory, exact, and reject invalid bound values before child resolution', async () => {
    const invalidCounts = [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 53];
    for (const calcBarsCount of invalidCounts) {
      const calls: string[] = [];
      const provider: DataProvider = {
        resolveContext(symbol) {
          calls.push(symbol);
          return Promise.resolve(symbol === '' ? parent() : child());
        },
      };
      await expect(
        bind(requestModule({calcBarsCount}), {
          params: {},
          provider,
          sink: new RecordingSink(),
        }),
      ).rejects.toThrow(
        'calc_bars_count must bind to a non-negative safe integer',
      );
      expect(calls).toEqual(['']);
    }

    const base = requestModule({});
    const missingOptions: TeaModule = {
      ...base,
      bind(rt) {
        rt.bindRequest(0, 'X', '');
      },
    };
    await expect(
      bind(missingOptions, {
        params: {},
        provider: contexts({'': parent(), X: child()}),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow('request 0 was never given bind options');

    const invalidBoolean: TeaModule = {
      ...base,
      bind(rt) {
        rt.bindRequestOptions(0, 'false', false, false, 0);
        rt.bindRequest(0, 'X', '');
      },
    };
    await expect(
      bind(invalidBoolean, {
        params: {},
        provider: contexts({'': parent(), X: child()}),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow(
      'gaps, lookahead, and ignore_invalid_symbol must bind to bool values',
    );
  });

  test('a bounded child restarts bar_index at zero inside the retained tail', async () => {
    const barIndexChild = {
      manifest: {
        series: [],
        execution: [
          {
            source: {domain: 'bar', field: 'bar_index'},
            layout: NUMBER_LAYOUT,
            depth: {kind: 'none'},
          },
        ],
        params: [],
        outputs: [],
        effects: [],
        requests: [],
        frames: [
          {
            locals: [
              {
                storage: Storage.PerBar,
                depth: {kind: 'none'},
                layout: NUMBER_LAYOUT,
              },
            ],
            subs: [],
          },
        ],
      },
      requests: [],
      init() {},
      bind() {},
      inits: {},
      funcs: {},
      main(
        rt: Parameters<TeaModule['main']>[0],
        fr: Parameters<TeaModule['main']>[1],
      ) {
        rt.write(fr, 0, rt.execution(0, 0));
      },
    } as const satisfies ModuleCode;
    const base = requestModule({calcBarsCount: 2});
    const module: TeaModule = {...base, requests: [barIndexChild]};
    const sink = new RecordingSink();
    const bound = await bind(module, {
      params: {},
      provider: contexts({'': parent(), X: child()}),
      sink,
    });
    await bound.runAll();
    expect(sink.emits.map(event => event.channels[0])).toEqual([
      NaN,
      NaN,
      NaN,
      0,
      0,
      1,
    ]);
  });

  test('gaps_on merges na except where a new child bar arrived', async () => {
    const sink = new RecordingSink();
    const bound = await bind(
      requestModule({gaps: true, lookahead: false, ignoreInvalidSymbol: false}),
      {params: {}, provider: contexts({'': parent(), X: child()}), sink},
    );
    await bound.runAll();
    expect(sink.emits.map(e => e.channels[0])).toEqual([
      NaN,
      100,
      NaN,
      200,
      NaN,
      300,
    ]);
  });

  test('an unknown symbol is a BindError unless ignore_invalid_symbol', async () => {
    const inputs = {
      params: {},
      provider: contexts({'': parent()}),
      sink: new RecordingSink(),
    };
    expect(() => bind(requestModule({}), inputs)).toThrow(BindError);

    const sink = new RecordingSink();
    const bound = await bind(
      requestModule({gaps: false, lookahead: false, ignoreInvalidSymbol: true}),
      {...inputs, sink},
    );
    await bound.runAll();
    expect(sink.emits.every(e => Number.isNaN(num(e.channels[0])))).toBe(true);
  });

  test('invalid request offsets cannot expose future or undefined values', async () => {
    const module = requestModule({});
    const probing: TeaModule = {
      ...module,
      main(rt) {
        rt.emit(0, 0, rt.request(0, -1));
        rt.emit(0, 1, rt.request(0, 100));
      },
    };
    const sink = new RecordingSink();
    const bound = await bind(probing, {
      params: {},
      provider: contexts({'': parent(), X: child()}),
      sink,
    });
    bound.executeRow(0, false);
    bound.commitRow(0);
    expect(sink.emits[0].channels.every(v => Number.isNaN(num(v)))).toBe(true);
  });

  test('merge without a time axis on either context is a BindError', async () => {
    const noAxis = context({close: new ArraySeries([1, 2, 3])}, null);
    expect(() =>
      bind(requestModule({}), {
        params: {},
        provider: contexts({'': noAxis, X: child()}),
        sink: new RecordingSink(),
      }),
    ).toThrow('time axis');
  });

  test('nested empty request args inherit the child provider-normalized identity', async () => {
    const innerChild = {
      manifest: {
        series: [{id: 'close', depth: {kind: 'none'}}],
        execution: [],
        params: [],
        outputs: [],
        effects: [],
        requests: [],
        frames: [
          {
            locals: [
              {
                storage: Storage.PerBar,
                depth: {kind: 'none'},
                layout: NUMBER_LAYOUT,
              },
            ],
            subs: [],
          },
        ],
      },
      requests: [],
      init() {},
      bind() {},
      inits: {},
      funcs: {},
      main(
        rt: Parameters<TeaModule['main']>[0],
        fr: Parameters<TeaModule['main']>[1],
      ) {
        rt.write(fr, 0, rt.series(0, 0));
      },
    } as const satisfies ModuleCode;
    const outerChild = {
      manifest: {
        series: [],
        execution: [],
        params: [],
        outputs: [],
        effects: [],
        requests: [
          {
            merge: {mode: 'sample'},
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: NUMBER_LAYOUT,
            dynamic: false,
          },
        ],
        frames: [
          {
            locals: [
              {
                storage: Storage.PerBar,
                depth: {kind: 'none'},
                layout: NUMBER_LAYOUT,
              },
            ],
            subs: [],
          },
        ],
      },
      requests: [innerChild],
      init() {},
      bind(rt: Parameters<TeaModule['bind']>[0]) {
        rt.bindRequestOptions(0, false, false, false, 0);
        rt.bindRequest(0, '', '');
      },
      inits: {},
      funcs: {},
      main(
        rt: Parameters<TeaModule['main']>[0],
        fr: Parameters<TeaModule['main']>[1],
      ) {
        rt.write(fr, 0, rt.request(0, 0));
      },
    } as const satisfies ModuleCode;
    const base = requestModule({});
    const module: TeaModule = {...base, requests: [outerChild]};
    const calls: string[] = [];
    const rootContext = context(
      {close: new ArraySeries([1])},
      regularAxis(0, 1, 1),
    );
    const outerContext: ProviderContext = {
      rows: 1,
      axis: regularAxis(0, 1, 1),
      series: () => null,
      builtinValue(source) {
        if (source.domain === 'syminfo' && source.field === 'tickerid') {
          return 'CANON:X';
        }
        if (source.domain === 'timeframe' && source.field === 'period') {
          return 'M';
        }
        return undefined;
      },
    };
    const innerContext = context(
      {close: new ArraySeries([7])},
      regularAxis(0, 1, 1),
    );
    const provider: DataProvider = {
      resolveContext(symbol, timeframe) {
        calls.push(`${symbol}|${timeframe}`);
        if (symbol === '') {
          return Promise.resolve(rootContext);
        }
        if (symbol === 'X' && timeframe === '') {
          return Promise.resolve(outerContext);
        }
        if (symbol === 'CANON:X' && timeframe === 'M') {
          return Promise.resolve(innerContext);
        }
        return Promise.resolve({
          error: 'unknownSymbol' as const,
          detail: `unexpected pair '${symbol}','${timeframe}'`,
        });
      },
    };
    const sink = new RecordingSink();
    const bound = await bind(module, {params: {}, provider, sink});
    await bound.runAll();
    expect(calls).toEqual(['|', 'X|', 'CANON:X|M']);
    expect(sink.emits.map(event => event.channels[0])).toEqual([7]);
  });
});

// ---- dynamic requests (ABI protocol) ---------------------------------------
// sym = close > 3 ? 'X' : 'Y';  r = requestFor(...);  history via rt.request

const IDENTITY_CHILD = {
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    execution: [],
    params: [],
    outputs: [],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  bind() {},
  inits: {},
  funcs: {},
  main(
    rt: Parameters<TeaModule['main']>[0],
    fr: Parameters<TeaModule['main']>[1],
  ) {
    rt.write(fr, 0, rt.series(0, 0));
  },
} satisfies ModuleCode;

const DYNAMIC_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    execution: [],
    params: [],
    outputs: [
      {
        effect: 'plot',
        staticArgs: [],
        channels: [
          {name: 'r', type: 'float', transport: {kind: 'float'}},
          {name: 'prev', type: 'float', transport: {kind: 'float'}},
        ],
      },
    ],
    effects: [],
    requests: [
      {
        merge: {
          mode: 'sample',
        },
        depth: {kind: 'const', bars: 1},
        resultSlot: 0,
        layout: NUMBER_LAYOUT,
        dynamic: true,
      },
    ],
    frames: [{locals: [], subs: []}],
  },
  requests: [IDENTITY_CHILD],
  init() {},
  bind(rt) {
    rt.bindRequestOptions(0, false, false, false, 0);
  },
  inits: {},
  funcs: {},
  main(rt) {
    const sym = rt.series(0, 0) > 3 ? 'X' : 'Y';
    rt.emit(0, 0, rt.requestFor(0, sym, ''));
    rt.emit(0, 1, rt.request(0, 1));
  },
};

describe('dynamic requests', () => {
  const parentSix = () =>
    context({close: new ArraySeries([1, 2, 3, 4, 5, 6])}, regularAxis(0, 1, 6));
  const twoSpan = (values: number[]) =>
    context({close: new ArraySeries(values)}, regularAxis(0, 2, values.length));

  test('pairs resolve on first encounter; the ring serves history', async () => {
    const sink = new RecordingSink();
    const bound = await bind(DYNAMIC_MODULE, {
      params: {},
      provider: contexts({
        '': parentSix(),
        X: twoSpan([10, 20, 30]),
        Y: twoSpan([100, 200, 300]),
      }),
      sink,
    });
    await bound.runAll();
    expect(sink.emits.map(e => e.channels[0])).toEqual([
      NaN,
      100,
      100,
      20,
      20,
      30,
    ]);
    expect(sink.emits.map(e => e.channels[1])).toEqual([
      NaN,
      NaN,
      100,
      100,
      20,
      20,
    ]);
  });

  test('the unique-context cap is a RequestError', async () => {
    const bound = await bind(DYNAMIC_MODULE, {
      params: {},
      provider: contexts({
        '': parentSix(),
        X: twoSpan([10, 20, 30]),
        Y: twoSpan([100, 200, 300]),
      }),
      sink: new RecordingSink(),
      maxRequestContexts: 1,
    });
    expect(bound.runAll()).rejects.toThrow('exceed the cap of 1');
  });

  test('ignored-invalid dynamic pairs still consume the unique-context budget', async () => {
    const invalidPairs: TeaModule = {
      ...DYNAMIC_MODULE,
      bind(rt) {
        rt.bindRequestOptions(0, false, false, true, 0);
      },
    };
    const bound = await bind(invalidPairs, {
      params: {},
      provider: contexts({'': parentSix()}),
      sink: new RecordingSink(),
      maxRequestContexts: 1,
    });
    await expect(bound.runAll()).rejects.toThrow('exceed the cap of 1');
  });
});

const VARIP_DYNAMIC_MODULE: TeaModule = {
  ...DYNAMIC_MODULE,
  manifest: {
    ...DYNAMIC_MODULE.manifest,
    frames: [
      {
        locals: [
          {
            storage: Storage.Varip,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
  },
  inits: {'0:0': () => 0},
  main(rt, fr) {
    // varip increments BEFORE the request read, so an aborted attempt
    // would contaminate it without the snapshot restore.
    rt.write(fr, 0, num(rt.read(fr, 0, 0)) + 1);
    const sym = rt.series(0, 0) > 3 ? 'X' : 'Y';
    rt.emit(0, 0, rt.requestFor(0, sym, ''));
    rt.emit(0, 1, rt.read(fr, 0, 0));
  },
};

describe('suspension protocol', () => {
  const parentSix = () =>
    context({close: new ArraySeries([1, 2, 3, 4, 5, 6])}, regularAxis(0, 1, 6));
  const twoSpan = (values: number[]) =>
    context({close: new ArraySeries(values)}, regularAxis(0, 2, values.length));

  test('commitRow after a suspended execution is protocol misuse', async () => {
    const bound = await bind(DYNAMIC_MODULE, {
      params: {},
      provider: contexts({'': parentSix(), X: twoSpan([1]), Y: twoSpan([2])}),
      sink: new RecordingSink(),
    });
    expect(() => bound.executeRow(0, false)).toThrow(
      'unresolved request context',
    );
    expect(() => bound.commitRow(0)).toThrow('after a suspended execution');
    // The documented recovery: resolve, re-execute, then commit.
    await bound.resolvePending();
    bound.executeRow(0, false);
    bound.commitRow(0);
  });

  test('varip survives completed ticks but not aborted attempts', async () => {
    const close = new ArraySeries([1, 2]);
    const sink = new RecordingSink();
    const bound = await bind(VARIP_DYNAMIC_MODULE, {
      params: {},
      provider: contexts({
        '': context({close}, regularAxis(0, 1, 2)),
        X: twoSpan([10]),
        Y: twoSpan([100]),
      }),
      sink,
    });
    // Tick 1 on row 0: pair Y unresolved — the attempt aborts, resolves,
    // and the retry completes with p=1 (the abort vanished).
    expect(() => bound.executeRow(0, true)).toThrow('unresolved');
    await bound.resolvePending();
    bound.executeRow(0, true);
    // Tick 2 flips the symbol to the unresolved pair X mid-row: the abort
    // must not eat tick 1's legitimate varip accumulation.
    close.values[0] = 5;
    expect(() => bound.executeRow(0, true)).toThrow('unresolved');
    await bound.resolvePending();
    bound.executeRow(0, true);
    const varips = sink.emits.map(e => e.channels[1]);
    // tick1 completes with p=1; tick2 completes with p=2.
    expect(varips).toEqual([1, 2]);
  });
});
