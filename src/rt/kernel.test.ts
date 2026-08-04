// Purpose: Kernel tests — hand-lowered modules (the exact shape codegen will emit) drive bind, frames, rings, and the provisional/commit protocol end to end.

import {describe, expect, test} from 'bun:test';
import {Storage} from '../ir/node';
import {
  BindError,
  type DataProvider,
  type OutputSink,
  type SeriesData,
  type TeaModule,
  type Value,
} from './abi';
import {bind} from './kernel';

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

function provider(series: Record<string, ArraySeries>): DataProvider {
  return {series: (id: string) => series[id] ?? null};
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
    frames: [
      {
        locals: [{storage: Storage.Var, depth: {kind: 'none'}, ref: false}],
        subs: [],
      },
    ],
  },
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
  test('var state carries across committed rows', () => {
    const sink = new RecordingSink();
    const bound = bind(EMA_MODULE, {
      params: {},
      provider: provider({close: new ArraySeries([10, 20, 30])}),
      sink,
    });
    expect(bound.rows).toBe(3);
    bound.runAll();
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
    frames: [
      {locals: [], subs: [{fid: 1}, {fid: 1}]},
      {
        locals: [{storage: Storage.Var, depth: {kind: 'none'}, ref: false}],
        subs: [],
      },
    ],
  },
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
  test('call sites share the compiled body but own separate state', () => {
    const sink = new RecordingSink();
    const bound = bind(COUNTER_MODULE, {
      params: {},
      provider: provider({close: new ArraySeries([1, 1, 1])}),
      sink,
    });
    bound.runAll();
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
  init() {},
  inits: {},
  funcs: {},
  main(rt, fr) {
    rt.write(fr, 0, rt.series(0, 0));
    rt.emit(0, 0, rt.read(fr, 0, 2));
  },
};

describe('rings', () => {
  test('history offsets see committed cells; early rows read na', () => {
    const sink = new RecordingSink();
    const bound = bind(HISTORY_MODULE, {
      params: {},
      provider: provider({close: new ArraySeries([1, 2, 3, 4])}),
      sink,
    });
    bound.runAll();
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
  test('ticks re-execute from committed state; varip alone accumulates', () => {
    const sink = new RecordingSink();
    const close = new ArraySeries([10, 5]);
    const bound = bind(TICK_MODULE, {
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

  test('for var and perBar, ticks then commit equals never having ticked', () => {
    const run = (withTicks: boolean) => {
      const sink = new RecordingSink();
      const close = new ArraySeries([12, 5]);
      const bound = bind(TICK_MODULE, {
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
    const ticked = run(true);
    const clean = run(false);
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
    frames: [
      {
        locals: [{storage: Storage.PerBar, depth: {kind: 'bound'}, ref: false}],
        subs: [],
      },
    ],
  },
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
  test('init evaluates bind-time args and bound depths', () => {
    const sink = new RecordingSink();
    const bound = bind(BIND_MODULE, {
      params: {level: 105, len: 2},
      provider: provider({close: new ArraySeries([1, 2, 3, 4])}),
      sink,
    });
    expect(sink.declared[0].boundArgs).toEqual([{name: 'price', value: 105}]);
    bound.runAll();
    const values = sink.emits.map(e => e.channels[0]);
    expect(Number.isNaN(num(values[1]))).toBe(true);
    expect(values[2]).toBe(1);
    expect(values[3]).toBe(2);
  });

  test('bind failures are user-facing errors', () => {
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
  });
});
