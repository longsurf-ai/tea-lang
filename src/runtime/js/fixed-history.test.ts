// Purpose: Fixed-history host-adapter coverage over JSRuntime.step.

import {describe, expect, test} from 'vitest';
import {Storage} from '../../ir/node';
import {MemorySink} from '../../providers/sinks/memory-sink';
import {type DataProvider, type ProviderContext} from '../abi';
import {bindFixedHistory} from './fixed-history';
import {RUNTIME_ABI_VERSION, type JSModule} from '../module-abi';
import {testModule} from '../testing';
import type {ValueLayout} from '../value-layout';

const NUMBER = 0;
const ARRAY = 1;
const LAYOUTS = [
  {kind: 'number', numeric: 'int'},
  {kind: 'array', element: NUMBER},
] as const satisfies readonly ValueLayout[];

class Series {
  constructor(readonly values: number[]) {}
  get length(): number {
    return this.values.length;
  }
  at(row: number): number {
    return this.values[row]!;
  }
}

function provider(series: Series): DataProvider {
  const context: ProviderContext = {
    rows: series.length,
    axis: null,
    series: id => (id === 'close' ? series : null),
    builtinValue: () => undefined,
  };
  return {resolveContext: () => Promise.resolve(context)};
}

function axis(span: number) {
  return {
    time: (row: number) => row * span,
    closeTime: (row: number) => (row + 1) * span,
  };
}

const MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'const', bars: 1}}],
    builtin: [
      {
        source: {domain: 'bar', field: 'bar_index'},
        layout: NUMBER,
        depth: {kind: 'none'},
      },
    ],
    params: [],
    outputs: [
      {
        effect: 'probe',
        staticArgs: [],
        channels: [
          {name: 'close', type: 'int', transport: {kind: 'int'}},
          {name: 'previous', type: 'int', transport: {kind: 'int'}},
          {name: 'bar', type: 'int', transport: {kind: 'int'}},
        ],
      },
    ],
    effects: [{layout: NUMBER, declaration: {payload: {kind: 'int'}}}],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 1},
            layout: NUMBER,
          },
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  funcs: {},
  main(ctx, root) {
    const close = ctx.series(0, 0);
    ctx.write(root, 0, close);
    ctx.emit(0, 0, close);
    ctx.emit(0, 1, ctx.series(0, 1));
    ctx.emit(0, 2, ctx.builtin(0, 0));
    ctx.emitEffect(0, close);
  },
});

const REQUEST_CHILD: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: LAYOUTS,
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
          {storage: Storage.PerBar, depth: {kind: 'none'}, layout: NUMBER},
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  funcs: {},
  main(ctx, root) {
    ctx.write(root, 0, ctx.series(0, 0));
  },
});

const NESTED_REQUEST_CHILD: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: LAYOUTS,
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
        layout: NUMBER,
        dynamic: false,
        context: {
          symbol: 'Y',
          timeframe: '2m',
          gaps: false,
          lookahead: false,
          ignoreInvalidSymbol: false,
          calcBarsCount: 0,
        },
      },
    ],
    frames: [
      {
        locals: [
          {storage: Storage.PerBar, depth: {kind: 'none'}, layout: NUMBER},
        ],
        subs: [],
      },
    ],
  },
  requests: [REQUEST_CHILD],
  funcs: {},
  main(ctx, root) {
    ctx.write(root, 0, ctx.request(0, 0));
  },
});

function requestModule(dynamic = false): JSModule {
  const module: JSModule = testModule({
    ...MODULE,
    manifest: {
      ...MODULE.manifest,
      series: [],
      builtin: [],
      effects: [],
      requests: [
        {
          merge: {mode: 'sample'},
          depth: {kind: 'const', bars: 1},
          resultSlot: 0,
          layout: NUMBER,
          dynamic,
          context: {
            symbol: 'X',
            timeframe: '2m',
            gaps: false,
            lookahead: false,
            ignoreInvalidSymbol: false,
            calcBarsCount: 0,
          },
        },
      ],
      frames: [{locals: [], subs: []}],
      outputs: [
        {
          effect: 'probe',
          staticArgs: [],
          channels: [
            {name: 'current', type: 'int', transport: {kind: 'int'}},
            {name: 'previous', type: 'int', transport: {kind: 'int'}},
          ],
        },
      ],
    },
    requests: [REQUEST_CHILD],
    main(ctx) {
      ctx.emit(0, 0, ctx.request(0, 0));
      ctx.emit(0, 1, ctx.request(0, 1));
    },
  });
  return module;
}

const ARRAY_WORKSPACE_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: LAYOUTS,
  manifest: {
    series: [],
    builtin: [],
    params: [],
    outputs: [],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {storage: Storage.Var, depth: {kind: 'none'}, layout: ARRAY},
          {storage: Storage.Varip, depth: {kind: 'none'}, layout: ARRAY},
        ],
        subs: [],
      },
    ],
  },
  requests: [],
  funcs: {},
  main() {},
});

describe('bindFixedHistory', () => {
  test('binds provider rows, declares the sink, and runs fixed history', async () => {
    const sink = new MemorySink();
    const execution = await bindFixedHistory(MODULE, {
      params: {},
      provider: provider(new Series([10, 20, 30])),
      sink,
      timeNow: 0,
    });

    await execution.runAll();
    expect(execution.rows).toBe(3);
    expect(sink.outputs).toHaveLength(1);
    expect(sink.emissions.map(value => value.channels)).toEqual([
      [10, NaN, 0],
      [20, 10, 1],
      [30, 20, 2],
    ]);
    expect(sink.effectEmissions.map(value => value.payload)).toEqual([
      10, 20, 30,
    ]);
    execution.dispose();
  });

  test('publishes provisional immediately and final only from commitRow', async () => {
    const values = new Series([10]);
    const sink = new MemorySink();
    const execution = await bindFixedHistory(MODULE, {
      params: {},
      provider: provider(values),
      sink,
      timeNow: 0,
    });

    execution.executeRow(0, true);
    values.values[0] = 12;
    execution.executeRow(0, false);
    expect(sink.publications.map(value => value.provisional)).toEqual([true]);
    execution.commitRow(0);
    expect(sink.publications.map(value => value.provisional)).toEqual([
      true,
      false,
    ]);
    expect(sink.emissions.map(value => value.channels[0])).toEqual([10, 12]);
    execution.dispose();
  });

  test('runs a static child in an independent context and sample-merges it', async () => {
    const parent: ProviderContext = {
      rows: 6,
      axis: axis(1),
      series: () => null,
      builtinValue: () => undefined,
    };
    const childValues = new Series([10, 20, 30]);
    const child: ProviderContext = {
      rows: 3,
      axis: axis(2),
      series: id => (id === 'close' ? childValues : null),
      builtinValue: () => undefined,
    };
    const sink = new MemorySink();
    const execution = await bindFixedHistory(requestModule(), {
      params: {},
      provider: {
        resolveContext: symbol =>
          Promise.resolve(symbol === '' ? parent : child),
      },
      sink,
      timeNow: 0,
    });
    await execution.runAll();
    expect(sink.emissions.map(value => value.channels)).toEqual([
      [NaN, NaN],
      [10, NaN],
      [10, 10],
      [20, 10],
      [20, 20],
      [30, 20],
    ]);
    execution.dispose();
  });

  test('keeps dynamic requests unsupported before provider resolution', async () => {
    const calls: string[] = [];
    await expect(
      bindFixedHistory(requestModule(true), {
        params: {},
        provider: {
          resolveContext: symbol => {
            calls.push(symbol);
            return Promise.resolve({
              rows: 0,
              axis: null,
              series: () => null,
              builtinValue: () => undefined,
            });
          },
        },
        sink: new MemorySink(),
        timeNow: 0,
      }),
    ).rejects.toThrow('dynamic request 0 is unsupported');
    expect(calls).toEqual([]);
  });

  test('rejects malformed provider-normalized context identity', async () => {
    await expect(
      bindFixedHistory(MODULE, {
        params: {},
        provider: {
          resolveContext: () =>
            Promise.resolve({
              rows: 1,
              axis: null,
              series: id => (id === 'close' ? {length: 1, at: () => 1} : null),
              builtinValue: source =>
                source.domain === 'syminfo' && source.field === 'tickerid'
                  ? 42
                  : undefined,
            }),
        },
        sink: new MemorySink(),
        timeNow: 0,
      }),
    ).rejects.toThrow(
      "provider builtin 'syminfo.tickerid' must be a string or typed empty",
    );
  });

  test('recursively executes nested static children before the parent', async () => {
    const module = testModule({
      ...requestModule(),
      requests: [NESTED_REQUEST_CHILD],
    });
    const parent: ProviderContext = {
      rows: 6,
      axis: axis(1),
      series: () => null,
      builtinValue: () => undefined,
    };
    const middle: ProviderContext = {
      rows: 3,
      axis: axis(2),
      series: () => null,
      builtinValue: () => undefined,
    };
    const leafValues = new Series([100, 200, 300]);
    const leaf: ProviderContext = {
      rows: 3,
      axis: axis(2),
      series: id => (id === 'close' ? leafValues : null),
      builtinValue: () => undefined,
    };
    const sink = new MemorySink();
    const execution = await bindFixedHistory(module, {
      params: {},
      provider: {
        resolveContext: symbol =>
          Promise.resolve(
            symbol === '' ? parent : symbol === 'X' ? middle : leaf,
          ),
      },
      sink,
      timeNow: 0,
    });
    await execution.runAll();
    expect(sink.emissions.map(value => value.channels[0])).toEqual([
      NaN,
      100,
      100,
      200,
      200,
      300,
    ]);
    execution.dispose();
  });

  test('accounts exact shallow bytes for explicit State/history workspace', async () => {
    const exact = await bindFixedHistory(ARRAY_WORKSPACE_MODULE, {
      params: {},
      provider: provider(new Series([1])),
      sink: new MemorySink(),
      timeNow: 0,
      // Two persistent array locals each own one retained and one workspace
      // carrier: 2 * 2 * shallowBytes(array=32) = 128.
      maxFixedValueLogicalBytes: 128,
    });
    exact.dispose();

    await expect(
      bindFixedHistory(ARRAY_WORKSPACE_MODULE, {
        params: {},
        provider: provider(new Series([1])),
        sink: new MemorySink(),
        timeNow: 0,
        maxFixedValueLogicalBytes: 127,
      }),
    ).rejects.toThrow('FIXED_VALUE_STORAGE_LIMIT_EXCEEDED');
  });

  test('shares request-column budget while releasing completed child workspace', async () => {
    const base = requestModule();
    const module: JSModule = testModule({
      ...base,
      manifest: {
        ...base.manifest,
        requests: [base.manifest.requests[0]!, base.manifest.requests[0]!],
        outputs: [
          {
            effect: 'probe',
            staticArgs: [],
            channels: [
              {name: 'first', type: 'int', transport: {kind: 'int'}},
              {name: 'second', type: 'int', transport: {kind: 'int'}},
            ],
          },
        ],
      },
      requests: [REQUEST_CHILD, REQUEST_CHILD],
      main(ctx) {
        ctx.emit(0, 0, ctx.request(0, 0));
        ctx.emit(0, 1, ctx.request(1, 0));
      },
    });
    const parent: ProviderContext = {
      rows: 6,
      axis: axis(1),
      series: () => null,
      builtinValue: () => undefined,
    };
    const values = new Series([10, 20, 30]);
    const child: ProviderContext = {
      rows: 3,
      axis: axis(2),
      series: id => (id === 'close' ? values : null),
      builtinValue: () => undefined,
    };
    const inputs = {
      params: {},
      provider: {
        resolveContext: (symbol: string) =>
          Promise.resolve(symbol === '' ? parent : child),
      },
      sink: new MemorySink(),
      timeNow: 0,
    };

    // Peak: root request history 16 + retained first column 24 + second child
    // local workspace 8 + second result column 24 = 72. The first child's
    // 8-byte workspace must already have been released.
    const exact = await bindFixedHistory(module, {
      ...inputs,
      maxFixedValueLogicalBytes: 72,
    });
    exact.dispose();
    await expect(
      bindFixedHistory(module, {
        ...inputs,
        sink: new MemorySink(),
        maxFixedValueLogicalBytes: 71,
      }),
    ).rejects.toThrow('FIXED_VALUE_STORAGE_LIMIT_EXCEEDED');
  });
});
