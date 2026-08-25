// Purpose: Fixed-history compatibility coverage over StateMachineRuntime.step.

import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {MemorySink} from '../providers/sinks/memory-sink';
import {
  RUNTIME_ABI_VERSION,
  type AggregateLayoutManifest,
  type DataProvider,
  type ProviderContext,
  type ModuleCode,
  type TeaModule,
} from './abi';
import {bindStateMachine} from './state-machine-binding';

const NUMBER = 0;
const LAYOUTS = {
  layouts: [{kind: 'number', numeric: 'int'}],
} as const satisfies AggregateLayoutManifest;

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

const MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: LAYOUTS,
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
  init() {},
  bind() {},
  funcs: {},
  main(rt, root) {
    const close = rt.series(0, 0);
    rt.write(root, 0, close);
    rt.emit(0, 0, close);
    rt.emit(0, 1, rt.series(0, 1));
    rt.emit(0, 2, rt.builtin(0, 0));
    rt.emitEffect(0, close);
  },
};

const REQUEST_CHILD: ModuleCode = {
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
  init() {},
  bind() {},
  funcs: {},
  main(rt, root) {
    rt.write(root, 0, rt.series(0, 0));
  },
};

const NESTED_REQUEST_CHILD: ModuleCode = {
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
  init() {},
  bind(rt) {
    rt.bindRequestOptions(0, false, false, false, 0);
    rt.bindRequest(0, 'Y', '2m');
  },
  funcs: {},
  main(rt, root) {
    rt.write(root, 0, rt.request(0, 0));
  },
};

function requestModule(dynamic = false): TeaModule {
  return {
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
    bind(rt) {
      rt.bindRequestOptions(0, false, false, false, 0);
      if (!dynamic) rt.bindRequest(0, 'X', '2m');
    },
    main(rt) {
      rt.emit(0, 0, rt.request(0, 0));
      rt.emit(0, 1, rt.request(0, 1));
    },
  };
}

describe('bindStateMachine', () => {
  test('binds provider rows, declares the sink, and runs fixed history', async () => {
    const sink = new MemorySink();
    const execution = await bindStateMachine(MODULE, {
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
    const execution = await bindStateMachine(MODULE, {
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
    const execution = await bindStateMachine(requestModule(), {
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
      bindStateMachine(requestModule(true), {
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

  test('recursively executes nested static children before the parent', async () => {
    const module = {...requestModule(), requests: [NESTED_REQUEST_CHILD]};
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
    const execution = await bindStateMachine(module, {
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
});
