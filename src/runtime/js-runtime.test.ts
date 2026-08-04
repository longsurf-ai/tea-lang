// Purpose: JSRuntime tests — hand-lowered modules (the exact shape codegen will emit) drive bind, frames, rings, and the provisional/commit protocol end to end.

import {describe, expect, test} from 'bun:test';
import {Storage} from '../ir/node';
import {
  BindError,
  type DataProvider,
  type OutputSink,
  type ProviderContext,
  type SeriesData,
  type TeaModule,
  type TimeAxis,
  type Value,
} from './abi';
import {bind} from './js-runtime';

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
  };
  return {resolveContext: () => Promise.resolve(context)};
}

class RecordingSink implements OutputSink {
  declared: Parameters<OutputSink['declare']>[0] = [];
  readonly emits: {
    row: number;
    oid: number;
    channels: readonly Value[];
    provisional: boolean;
  }[] = [];

  declare(outputs: Parameters<OutputSink['declare']>[0]): void {
    this.declared = outputs;
  }

  emit(
    row: number,
    oid: number,
    channels: readonly Value[],
    provisional: boolean,
  ): void {
    this.emits.push({row, oid, channels: [...channels], provisional});
  }
}

const PLOT_OUTPUT = {
  effect: 'plot',
  staticArgs: [],
  channels: [{name: 'series', type: 'float'}],
} as const;

function num(v: Value): number {
  return v as number;
}

// ---- an ema-shaped module ---------------------------------------------------
// var e = na
// e := na(e) ? close : 0.5 * close + 0.5 * e
// plot(e)

const EMA_MODULE: TeaModule = {
  abi: 1,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    params: [],
    outputs: [PLOT_OUTPUT],
    requests: [],
    frames: [
      {
        locals: [{storage: Storage.Var, depth: {kind: 'none'}, ref: false}],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
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
  abi: 1,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    params: [],
    outputs: [
      {
        effect: 'plot',
        staticArgs: [],
        channels: [
          {name: 'a', type: 'int'},
          {name: 'b', type: 'int'},
        ],
      },
    ],
    requests: [],
    frames: [
      {locals: [], subs: [{fid: 1}, {fid: 1}]},
      {
        locals: [{storage: Storage.Var, depth: {kind: 'none'}, ref: false}],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  inits: {'1:0': () => 0},
  funcs: {
    1(rt, fr) {
      rt.write(fr, 0, num(rt.read(fr, 0, 0)) + 1);
      return rt.read(fr, 0, 0);
    },
  },
  main(rt, fr) {
    const a = COUNTER_MODULE.funcs[1](rt, rt.frame(fr, 0));
    const b = COUNTER_MODULE.funcs[1](rt, rt.frame(fr, 1));
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
  abi: 1,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    params: [],
    outputs: [PLOT_OUTPUT],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            ref: false,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
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
  abi: 1,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    params: [],
    outputs: [
      {
        effect: 'plot',
        staticArgs: [],
        channels: [
          {name: 'v', type: 'float'},
          {name: 'p', type: 'int'},
          {name: 'x', type: 'float'},
        ],
      },
    ],
    requests: [],
    frames: [
      {
        locals: [
          {storage: Storage.Var, depth: {kind: 'none'}, ref: false},
          {storage: Storage.Varip, depth: {kind: 'none'}, ref: false},
          {storage: Storage.PerBar, depth: {kind: 'none'}, ref: false},
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
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
  abi: 1,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    params: [
      {
        name: 'level',
        title: null,
        type: 'float',
        defaultValue: 70,
        constraints: {minval: 0, maxval: null, options: null},
        seriesSid: null,
      },
      {
        name: 'len',
        title: null,
        type: 'int',
        defaultValue: 2,
        constraints: null,
        seriesSid: null,
      },
    ],
    outputs: [{effect: 'hline', staticArgs: [], channels: []}, PLOT_OUTPUT],
    requests: [],
    frames: [
      {
        locals: [{storage: Storage.PerBar, depth: {kind: 'bound'}, ref: false}],
        subs: [],
      },
    ],
  },
  requests: [],
  init(rt) {
    rt.bindOutput(0, 'price', rt.param(0));
    rt.bindDepth(0, 0, num(rt.param(1)));
  },
  inits: {},
  funcs: {},
  main(rt, fr) {
    rt.write(fr, 0, rt.series(0, 0));
    rt.emit(1, 0, rt.read(fr, 0, num(rt.param(1))));
  },
};

describe('binding', () => {
  test('init evaluates bind-time args and bound depths', async () => {
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
  return {rows, axis, series: (id: string) => series[id] ?? null};
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
    params: [],
    outputs: [],
    requests: [],
    frames: [
      {
        locals: [{storage: Storage.PerBar, depth: {kind: 'none'}, ref: false}],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  inits: {},
  funcs: {},
  main(
    rt: Parameters<TeaModule['main']>[0],
    fr: Parameters<TeaModule['main']>[1],
  ) {
    // Bind-time params are compilation-global: pid 0 is the PARENT's param.
    rt.write(fr, 0, rt.series(0, 0) * num(rt.param(0)));
  },
} satisfies Omit<TeaModule, 'abi'>;

function requestModule(merge: {
  gaps: boolean;
  lookahead: boolean;
  ignoreInvalidSymbol: boolean;
}): TeaModule {
  return {
    abi: 1,
    manifest: {
      series: [{id: 'close', depth: {kind: 'none'}}],
      params: [
        {
          name: 'scale',
          title: null,
          type: 'float',
          defaultValue: 10,
          constraints: null,
          seriesSid: null,
        },
      ],
      outputs: [
        {
          effect: 'plot',
          staticArgs: [],
          channels: [
            {name: 'r', type: 'float'},
            {name: 'prev', type: 'float'},
          ],
        },
      ],
      requests: [
        {
          merge: {mode: 'sample', ...merge},
          depth: {kind: 'const', bars: 1},
          resultSlot: 0,
          ref: false,
          dynamic: false,
        },
      ],
      frames: [{locals: [], subs: []}],
    },
    requests: [CHILD_MODULE],
    init(rt) {
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
    const bound = await bind(
      requestModule({
        gaps: false,
        lookahead: false,
        ignoreInvalidSymbol: false,
      }),
      {params: {}, provider: contexts({'': parent(), X: child()}), sink},
    );
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
    expect(() =>
      bind(
        requestModule({
          gaps: false,
          lookahead: false,
          ignoreInvalidSymbol: false,
        }),
        inputs,
      ),
    ).toThrow(BindError);

    const sink = new RecordingSink();
    const bound = await bind(
      requestModule({gaps: false, lookahead: false, ignoreInvalidSymbol: true}),
      {...inputs, sink},
    );
    await bound.runAll();
    expect(sink.emits.every(e => Number.isNaN(num(e.channels[0])))).toBe(true);
  });

  test('out-of-extent request reads (negative offsets included) are na', async () => {
    const module = requestModule({
      gaps: false,
      lookahead: false,
      ignoreInvalidSymbol: false,
    });
    const probing: TeaModule = {
      ...module,
      main(rt) {
        rt.emit(0, 0, rt.request(0, -100)); // index past the extent
        rt.emit(0, 1, rt.request(0, 100)); // index before history
      },
    };
    const sink = new RecordingSink();
    const bound = await bind(probing, {
      params: {},
      provider: contexts({'': parent(), X: child()}),
      sink,
    });
    bound.executeRow(0, false);
    expect(sink.emits[0].channels.every(v => Number.isNaN(num(v)))).toBe(true);
  });

  test('merge without a time axis on either context is a BindError', async () => {
    const noAxis = context({close: new ArraySeries([1, 2, 3])}, null);
    expect(() =>
      bind(
        requestModule({
          gaps: false,
          lookahead: false,
          ignoreInvalidSymbol: false,
        }),
        {
          params: {},
          provider: contexts({'': noAxis, X: child()}),
          sink: new RecordingSink(),
        },
      ),
    ).toThrow('time axis');
  });
});

// ---- dynamic requests (ABI protocol) ---------------------------------------
// sym = close > 3 ? 'X' : 'Y';  r = requestFor(...);  history via rt.request

const IDENTITY_CHILD = {
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    params: [],
    outputs: [],
    requests: [],
    frames: [
      {
        locals: [{storage: Storage.PerBar, depth: {kind: 'none'}, ref: false}],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  inits: {},
  funcs: {},
  main(
    rt: Parameters<TeaModule['main']>[0],
    fr: Parameters<TeaModule['main']>[1],
  ) {
    rt.write(fr, 0, rt.series(0, 0));
  },
} satisfies Omit<TeaModule, 'abi'>;

const DYNAMIC_MODULE: TeaModule = {
  abi: 1,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    params: [],
    outputs: [
      {
        effect: 'plot',
        staticArgs: [],
        channels: [
          {name: 'r', type: 'float'},
          {name: 'prev', type: 'float'},
        ],
      },
    ],
    requests: [
      {
        merge: {
          mode: 'sample',
          gaps: false,
          lookahead: false,
          ignoreInvalidSymbol: false,
        },
        depth: {kind: 'const', bars: 1},
        resultSlot: 0,
        ref: false,
        dynamic: true,
      },
    ],
    frames: [{locals: [], subs: []}],
  },
  requests: [IDENTITY_CHILD],
  init() {},
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
});

const VARIP_DYNAMIC_MODULE: TeaModule = {
  ...DYNAMIC_MODULE,
  manifest: {
    ...DYNAMIC_MODULE.manifest,
    frames: [
      {
        locals: [{storage: Storage.Varip, depth: {kind: 'none'}, ref: false}],
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
