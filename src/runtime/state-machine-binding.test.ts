// Purpose: Fixed-history compatibility coverage over StateMachineRuntime.step.

import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {MemorySink} from '../providers/sinks/memory-sink';
import {
  RUNTIME_ABI_VERSION,
  type AggregateLayoutManifest,
  type DataProvider,
  type ProviderContext,
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

  test('fails closed before resolving a module with requests', async () => {
    const withRequest: TeaModule = {
      ...MODULE,
      manifest: {
        ...MODULE.manifest,
        requests: [
          {
            merge: {mode: 'sample'},
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: NUMBER,
            dynamic: false,
          },
        ],
      },
      requests: [MODULE],
    };
    await expect(
      bindStateMachine(withRequest, {
        params: {},
        provider: provider(new Series([1])),
        sink: new MemorySink(),
        timeNow: 0,
      }),
    ).rejects.toThrow('does not support requests');
  });
});
