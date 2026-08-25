// Purpose: Fixed-historical host coverage retained across the runtime rewrite:
// generated binding data, typed builtins, and static request execution.

import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {
  BindError,
  type BindInputs,
  type DataProvider,
  type OutputSink,
  type ProviderContext,
  type RangeDemand,
  type SeriesData,
  type TimeAxis,
  type Value,
} from './abi';
import {bindFixedHistory} from './fixed-history';
import {
  RUNTIME_ABI_VERSION,
  type BuiltinSpec,
  type JSModule,
  type JSModuleBinding,
} from './module-abi';
import {staticModuleBinding, testModule} from './testing';
import type {ValueLayout} from './value-layout';

const TEST_TIME_NOW = 1_800_000_000_000;

function bind(
  module: JSModule,
  inputs: Omit<BindInputs, 'timeNow'> & {readonly timeNow?: number},
) {
  return bindFixedHistory(module, {
    ...inputs,
    timeNow: inputs.timeNow ?? TEST_TIME_NOW,
  });
}

const NUMBER_LAYOUT = 0;
const TEST_LAYOUTS = [
  {kind: 'number', numeric: 'float'},
] as const satisfies readonly ValueLayout[];

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

const EMA_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    builtin: [],
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
  evaluateBinding() {
    return staticModuleBinding(this);
  },
  funcs: {},
  main(ctx, fr) {
    if (ctx.needsInit(fr, 0)) ctx.initialize(fr, 0, NaN);
    const e = num(ctx.read(fr, 0, 0));
    const close = ctx.series(0, 0);
    ctx.write(fr, 0, Number.isNaN(e) ? close : 0.5 * close + 0.5 * e);
    ctx.emit(0, 0, ctx.read(fr, 0, 0));
  },
});

// ---- two call sites, one func ----------------------------------------------
// counter() => var c = 0; c := c + 1; c

const COUNTER_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    builtin: [],
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
  evaluateBinding() {
    return staticModuleBinding(this);
  },
  funcs: {
    1(ctx, fr) {
      if (ctx.needsInit(fr, 0)) ctx.initialize(fr, 0, 0);
      ctx.write(fr, 0, num(ctx.read(fr, 0, 0)) + 1);
      return ctx.read(fr, 0, 0);
    },
  },
  main(ctx, fr) {
    const a = COUNTER_MODULE.funcs[1](ctx, ctx.frame(fr, 0)) as Value;
    const b = COUNTER_MODULE.funcs[1](ctx, ctx.frame(fr, 1)) as Value;
    ctx.emit(0, 0, a);
    ctx.emit(0, 1, b);
  },
});

// ---- name history -----------------------------------------------------------
// x = close; plot(x[2])

const HISTORY_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    builtin: [],
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
  evaluateBinding() {
    return staticModuleBinding(this);
  },
  funcs: {},
  main(ctx, fr) {
    ctx.write(fr, 0, ctx.series(0, 0));
    ctx.emit(0, 0, ctx.read(fr, 0, 2));
  },
});

// ---- provisional protocol ---------------------------------------------------
// var v = 0;   v := v + close     (rolls back per tick)
// varip p = 0; p := p + 1         (accumulates across ticks)
// x = close                       (perBar)

const TICK_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    builtin: [],
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
  evaluateBinding() {
    return staticModuleBinding(this);
  },
  funcs: {},
  main(ctx, fr) {
    if (ctx.needsInit(fr, 0)) ctx.initialize(fr, 0, 0);
    if (ctx.needsInit(fr, 1)) ctx.initialize(fr, 1, 0);
    ctx.write(fr, 0, num(ctx.read(fr, 0, 0)) + ctx.series(0, 0));
    ctx.write(fr, 1, num(ctx.read(fr, 1, 0)) + 1);
    ctx.write(fr, 2, ctx.series(0, 0));
    ctx.emit(0, 0, ctx.read(fr, 0, 0));
    ctx.emit(0, 1, ctx.read(fr, 1, 0));
    ctx.emit(0, 2, ctx.read(fr, 2, 0));
  },
});

// ---- bind-time section ------------------------------------------------------
// level = input.float(70.0, minval=0)
// hline(level)  +  a bound-depth local read at offset len

const BIND_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    builtin: [],
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
  evaluateBinding(values) {
    return {
      retention: {
        frames: [[num(values.params[1]!)]],
        series: [0],
        builtins: [],
        requests: [],
      },
      activeParams: [true, true],
      outputs: [[{name: 'price', value: values.params[0]!}], []],
      requests: [],
    };
  },
  funcs: {},
  main(ctx, fr) {
    ctx.write(fr, 0, ctx.series(0, 0));
    ctx.emit(1, 0, ctx.read(fr, 0, num(ctx.param(1))));
  },
});

describe('binding', () => {
  test('pure binding data configures depth and output arguments', async () => {
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
    await expect(
      bind(BIND_MODULE, {...inputs, params: {level: -1}}),
    ).rejects.toThrow(BindError);
    await expect(
      bind(BIND_MODULE, {...inputs, params: {nope: 1}}),
    ).rejects.toThrow("unknown parameter 'nope'");
    await expect(
      bind(EMA_MODULE, {...inputs, params: {}, provider: provider({})}),
    ).rejects.toThrow("series 'close' is not provided");
    const bound = await bind(TICK_MODULE, {
      ...inputs,
      params: {},
      provider: provider({close: new ArraySeries([1, 2])}),
    });
    bound.dispose();
  });
});

describe('typed builtins', () => {
  const INT_LAYOUT = 0;
  const BOOL_LAYOUT = 1;
  const STRING_LAYOUT = 2;
  const layouts = [
    {kind: 'number', numeric: 'int'},
    {kind: 'boolean'},
    {kind: 'nullable-scalar', scalar: 'string'},
  ] as const satisfies readonly ValueLayout[];
  const builtins = [
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
  ] as const satisfies readonly BuiltinSpec[];

  function builtinContext(
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

  function builtinModule(): JSModule {
    const module: JSModule = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: layouts,
      manifest: {
        series: [],
        builtin: builtins,
        params: [],
        outputs: [
          {
            effect: 'probe',
            staticArgs: [],
            channels: builtins.map((_, index) => ({
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
      evaluateBinding() {
        return staticModuleBinding(this);
      },
      funcs: {},
      main(ctx) {
        builtins.forEach((_, bid) => ctx.emit(0, bid, ctx.builtin(bid, 0)));
        ctx.emit(1, 0, ctx.builtin(0, 1));
        ctx.emit(1, 1, ctx.builtin(7, 1));
        ctx.emit(1, 2, ctx.builtin(11, 1));
        ctx.emit(1, 3, ctx.builtin(2, 1));
      },
    });
    return module;
  }

  test('resolves row, extent, context, and fixed-history values exactly', async () => {
    const sink = new RecordingSink();
    const bound = await bind(builtinModule(), {
      params: {},
      provider: providerFromContext(builtinContext()),
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

  test('bind-time builtin reads fail before provider resolution', async () => {
    const calls: string[] = [];
    const base = builtinModule();
    const module: JSModule = testModule({
      ...base,
      evaluateBinding(values) {
        if (values.builtins?.get(11) === undefined) {
          throw new Error("builtin 'syminfo.tickerid' is not bind-visible");
        }
        return staticModuleBinding(this);
      },
    });
    await expect(
      bind(module, {
        params: {},
        provider: {
          resolveContext: () => {
            calls.push('resolve');
            return Promise.resolve(builtinContext());
          },
        },
        sink: new RecordingSink(),
        timeNow: 1_777_777_777_777,
      }),
    ).rejects.toThrow("builtin 'syminfo.tickerid' is not bind-visible");
    expect(calls).toEqual([]);
  });

  test('missing demanded metadata and a missing demanded axis fail at bind', async () => {
    await expect(
      bind(builtinModule(), {
        params: {},
        provider: providerFromContext(builtinContext(() => undefined)),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow("builtin 'syminfo.tickerid' is not provided");

    const withoutAxis = {...builtinContext(), axis: null};
    await expect(
      bind(builtinModule(), {
        params: {},
        provider: providerFromContext(withoutAxis),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow("builtin 'time' requires a time axis");
  });

  test('provider typed empty metadata is a value, not missing', async () => {
    const base = builtinModule();
    const module: JSModule = testModule({
      ...base,
      manifest: {
        ...base.manifest,
        builtin: [builtins[11]],
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
      evaluateBinding() {
        return staticModuleBinding(this);
      },
      main(ctx) {
        ctx.emit(0, 0, ctx.builtin(0, 0));
      },
    });
    const sink = new RecordingSink();
    const bound = await bind(module, {
      params: {},
      provider: providerFromContext(builtinContext(() => null)),
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
        bindFixedHistory(builtinModule(), {
          params: {},
          provider: providerFromContext(builtinContext()),
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

const CHILD_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: TEST_LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    builtin: [],
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
  evaluateBinding() {
    return staticModuleBinding(this);
  },
  funcs: {},
  main(
    ctx: Parameters<JSModule['main']>[0],
    fr: Parameters<JSModule['main']>[1],
  ) {
    // Bind-time params are compilation-global: pid 0 is the PARENT's param.
    ctx.write(fr, 0, ctx.series(0, 0) * num(ctx.param(0)));
  },
});

function requestModule(
  overrides: Partial<{
    gaps: boolean;
    lookahead: boolean;
    ignoreInvalidSymbol: boolean;
    calcBarsCount: number;
  }>,
): JSModule {
  const options = {
    gaps: false,
    lookahead: false,
    ignoreInvalidSymbol: false,
    calcBarsCount: 0,
    ...overrides,
  };
  const module: JSModule = testModule({
    abi: RUNTIME_ABI_VERSION,
    layout: TEST_LAYOUTS,
    manifest: {
      series: [{id: 'close', depth: {kind: 'none'}}],
      builtin: [],
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
    evaluateBinding(_values) {
      return {
        retention: {
          frames: [[]],
          series: [0],
          builtins: [],
          requests: [1],
        },
        activeParams: [true],
        outputs: [[]],
        requests: [
          {
            symbol: 'X',
            timeframe: '',
            ...options,
          },
        ],
      };
    },
    funcs: {},
    main(ctx) {
      ctx.emit(0, 0, ctx.request(0, 0));
      ctx.emit(0, 1, ctx.request(0, 1));
    },
  });
  return module;
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
          // Deliberately over-return every context. The binding must still
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
      ).rejects.toThrow('request 0 has invalid binding data');
      expect(calls).toEqual([]);
    }

    const base = requestModule({});
    const missingOptions: JSModule = testModule({
      ...base,
      evaluateBinding(values) {
        return {
          ...base.evaluateBinding(values),
          requests: [{symbol: 'X', timeframe: ''}],
        } as unknown as JSModuleBinding;
      },
    });
    await expect(
      bind(missingOptions, {
        params: {},
        provider: contexts({'': parent(), X: child()}),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow('request 0 has invalid binding data');

    const invalidBoolean: JSModule = testModule({
      ...base,
      evaluateBinding(values) {
        const binding = base.evaluateBinding(values);
        return {
          ...binding,
          requests: [
            {
              ...binding.requests[0]!,
              gaps: 'false',
            },
          ],
        } as unknown as JSModuleBinding;
      },
    });
    await expect(
      bind(invalidBoolean, {
        params: {},
        provider: contexts({'': parent(), X: child()}),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow('request 0 has invalid binding data');
  });

  test('a bounded child restarts bar_index at zero inside the retained tail', async () => {
    const barIndexChild: JSModule = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: TEST_LAYOUTS,
      manifest: {
        series: [],
        builtin: [
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
      evaluateBinding() {
        return staticModuleBinding(this);
      },
      funcs: {},
      main(
        ctx: Parameters<JSModule['main']>[0],
        fr: Parameters<JSModule['main']>[1],
      ) {
        ctx.write(fr, 0, ctx.builtin(0, 0));
      },
    });
    const base = requestModule({calcBarsCount: 2});
    const module: JSModule = testModule({...base, requests: [barIndexChild]});
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
    await expect(bind(requestModule({}), inputs)).rejects.toThrow(BindError);

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
    const probing: JSModule = testModule({
      ...module,
      main(ctx) {
        ctx.emit(0, 0, ctx.request(0, -1));
        ctx.emit(0, 1, ctx.request(0, 100));
      },
    });
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
    await expect(
      bind(requestModule({}), {
        params: {},
        provider: contexts({'': noAxis, X: child()}),
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow('time axis');
  });

  test('nested empty request args inherit the child provider-normalized identity', async () => {
    const innerChild: JSModule = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: TEST_LAYOUTS,
      manifest: {
        series: [{id: 'close', depth: {kind: 'none'}}],
        builtin: [],
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
      evaluateBinding() {
        return staticModuleBinding(this);
      },
      funcs: {},
      main(
        ctx: Parameters<JSModule['main']>[0],
        fr: Parameters<JSModule['main']>[1],
      ) {
        ctx.write(fr, 0, ctx.series(0, 0));
      },
    });
    const outerChild = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: TEST_LAYOUTS,
      manifest: {
        series: [],
        builtin: [],
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
      evaluateBinding(_values: Parameters<JSModule['evaluateBinding']>[0]) {
        return {
          retention: {
            frames: [[0]],
            series: [],
            builtins: [],
            requests: [0],
          },
          activeParams: [],
          outputs: [],
          requests: [
            {
              symbol: '',
              timeframe: '',
              gaps: false,
              lookahead: false,
              ignoreInvalidSymbol: false,
              calcBarsCount: 0,
            },
          ],
        };
      },
      funcs: {},
      main(
        ctx: Parameters<JSModule['main']>[0],
        fr: Parameters<JSModule['main']>[1],
      ) {
        ctx.write(fr, 0, ctx.request(0, 0));
      },
    });
    const base = requestModule({});
    const module: JSModule = testModule({...base, requests: [outerChild]});
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
