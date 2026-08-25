// Purpose: Differential coverage for the first StateUpdate slice: external
// input history, local history, dense outputs, and scalar effects.

import {Effect} from 'effect';
import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {
  RUNTIME_ABI_VERSION,
  type AggregateLayoutManifest,
  type DataProvider,
  type OutputSink,
  type ProviderContext,
  type TeaModule,
  type Value,
} from './abi';
import {HeapArena} from './heap';
import {bindStateMachine as bind} from './state-machine-binding';
import {stateMachine} from './state-update';
import {ValueLayoutRegistry} from './value-layout';

const NUMBER = 0;
const ARRAY = 1;
const MATRIX = 2;
const MAP = 3;
const COUNTER = 4;
const LAYOUTS = {
  layouts: [
    {kind: 'number', numeric: 'int'},
    {kind: 'array', element: NUMBER},
    {kind: 'matrix', element: NUMBER},
    {kind: 'map', key: NUMBER, value: NUMBER},
    {
      kind: 'struct',
      name: 'Counter',
      fields: [{name: 'value', layout: NUMBER}],
    },
  ],
} as const satisfies AggregateLayoutManifest;

const MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'const', bars: 1}}],
    builtin: [],
    params: [],
    outputs: [
      {
        effect: 'plot',
        staticArgs: [],
        channels: [
          {name: 'current', type: 'float', transport: {kind: 'float'}},
          {name: 'previous-input', type: 'float', transport: {kind: 'float'}},
          {
            name: 'two-local-values-back',
            type: 'float',
            transport: {kind: 'float'},
          },
        ],
      },
    ],
    effects: [
      {
        layout: NUMBER,
        declaration: {payload: {kind: 'int'}},
      },
    ],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
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
    const current = rt.series(0, 0);
    rt.write(root, 0, current);
    rt.emit(0, 0, current);
    rt.emit(0, 1, rt.series(0, 1));
    rt.emit(0, 2, rt.read(root, 0, 2));
    rt.emitEffect(0, current);
  },
};

const PROVISIONAL_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    builtin: [],
    params: [],
    outputs: [
      {
        effect: 'plot',
        staticArgs: [],
        channels: [
          {name: 'var', type: 'float', transport: {kind: 'float'}},
          {name: 'varip', type: 'float', transport: {kind: 'float'}},
          {name: 'per-bar', type: 'float', transport: {kind: 'float'}},
        ],
      },
    ],
    effects: [
      {
        layout: NUMBER,
        declaration: {payload: {kind: 'int'}},
      },
    ],
    requests: [],
    frames: [
      {
        locals: [
          {storage: Storage.Var, depth: {kind: 'none'}, layout: NUMBER},
          {storage: Storage.Varip, depth: {kind: 'none'}, layout: NUMBER},
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
    if (rt.needsInit(root, 0)) rt.initialize(root, 0, 0);
    if (rt.needsInit(root, 1)) rt.initialize(root, 1, 0);
    const close = rt.series(0, 0);
    rt.write(root, 0, Number(rt.read(root, 0, 0)) + close);
    rt.write(root, 1, Number(rt.read(root, 1, 0)) + 1);
    rt.write(root, 2, close);
    rt.emit(0, 0, rt.read(root, 0, 0));
    rt.emit(0, 1, rt.read(root, 1, 0));
    rt.emit(0, 2, rt.read(root, 2, 0));
    rt.emitEffect(0, close);
  },
};

function structModule(shouldFail: () => boolean): TeaModule {
  return {
    abi: RUNTIME_ABI_VERSION,
    aggregateLayouts: LAYOUTS,
    manifest: {
      series: [],
      builtin: [],
      params: [],
      outputs: [
        {
          effect: 'probe',
          staticArgs: [],
          channels: [{name: 'value', type: 'int', transport: {kind: 'int'}}],
        },
      ],
      effects: [],
      requests: [],
      frames: [
        {
          locals: [
            {storage: Storage.Var, depth: {kind: 'none'}, layout: COUNTER},
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
      if (rt.needsInit(root, 0)) {
        rt.initialize(root, 0, rt.newStruct(COUNTER, [0]));
      }
      const counter = rt.requireStruct(rt.read(root, 0, 0), COUNTER);
      const value = Number(rt.structField(counter, COUNTER, 0)) + 1;
      rt.storeStructField(counter, COUNTER, 0, value);
      if (shouldFail()) throw new Error('struct update failed');
      rt.emit(0, 0, value);
    },
  };
}

const COLLECTION_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: LAYOUTS,
  manifest: {
    series: [{id: 'close', depth: {kind: 'none'}}],
    builtin: [],
    params: [],
    outputs: [
      {
        effect: 'probe',
        staticArgs: [],
        channels: [
          {name: 'array-size', type: 'int', transport: {kind: 'int'}},
          {name: 'matrix-value', type: 'int', transport: {kind: 'int'}},
          {name: 'map-size', type: 'int', transport: {kind: 'int'}},
          {name: 'array-entries', type: 'int', transport: {kind: 'int'}},
        ],
      },
    ],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {storage: Storage.Varip, depth: {kind: 'none'}, layout: ARRAY},
          {storage: Storage.Varip, depth: {kind: 'none'}, layout: MATRIX},
          {storage: Storage.Varip, depth: {kind: 'none'}, layout: MAP},
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
    if (rt.needsInit(root, 0)) {
      rt.initialize(root, 0, rt.callCollection('array.from', ARRAY, [0]));
    }
    if (rt.needsInit(root, 1)) {
      rt.initialize(
        root,
        1,
        rt.callCollection('matrix.new', MATRIX, [1, 1, 0]),
      );
    }
    if (rt.needsInit(root, 2)) {
      rt.initialize(root, 2, rt.callCollection('map.new', MAP, []));
    }

    const close = rt.series(0, 0);
    const array = rt.mutateCollection(
      'array.push',
      ARRAY,
      rt.read(root, 0, 0),
      [close],
    ).replacement;
    const matrix = rt.mutateCollection(
      'matrix.set',
      MATRIX,
      rt.read(root, 1, 0),
      [0, 0, close],
    ).replacement;
    const map = rt.mutateCollection('map.put', MAP, rt.read(root, 2, 0), [
      close,
      close + 10,
    ]).replacement;
    rt.write(root, 0, array);
    rt.write(root, 1, matrix);
    rt.write(root, 2, map);

    rt.emit(0, 0, rt.callCollection('array.size', NUMBER, [array]));
    rt.emit(0, 1, rt.callCollection('matrix.get', NUMBER, [matrix, 0, 0]));
    rt.emit(0, 2, rt.callCollection('map.size', NUMBER, [map]));
    rt.emit(0, 3, rt.collectionEntries(array).length);
  },
};

class ArraySeries {
  constructor(readonly values: number[]) {}
  get length(): number {
    return this.values.length;
  }
  at(index: number): number {
    return this.values[index]!;
  }
}

function provider(values: readonly number[] | ArraySeries): DataProvider {
  const series =
    values instanceof ArraySeries ? values : new ArraySeries([...values]);
  const context: ProviderContext = {
    rows: series.length,
    axis: null,
    series: id => (id === 'close' ? series : null),
    builtinValue: () => undefined,
  };
  return {resolveContext: () => Promise.resolve(context)};
}

class Sink implements OutputSink {
  readonly outputs: Value[][] = [];
  readonly effects: Value[] = [];
  readonly executions: {
    readonly outputs: readonly Value[][];
    readonly effects: readonly Value[];
    readonly provisional: boolean;
  }[] = [];
  declare() {}
  publish(value: Parameters<OutputSink['publish']>[0]) {
    const outputs = value.outputs.map(output => [...output.channels]);
    const effects = value.effects.map(effect => effect.payload as Value);
    this.outputs.push(...outputs);
    this.effects.push(...effects);
    this.executions.push({outputs, effects, provisional: value.provisional});
  }
}

describe('StateUpdate', () => {
  test('matches JSRuntime input/local history, outputs, and scalar effects', async () => {
    const values = [1, 2, 3, 4];
    const sink = new Sink();
    const execution = await bind(MODULE, {
      params: {},
      provider: provider(values),
      sink,
      timeNow: 0,
    });
    await execution.runAll();

    const heap = new HeapArena();
    const machine = stateMachine(
      MODULE,
      [],
      new ValueLayoutRegistry(LAYOUTS),
      heap,
    );
    let state = machine.initialState;
    let intermediate = machine.initialIntermediate;
    const outputs: Value[][] = [];
    const effects: Value[] = [];

    for (const value of values) {
      const result = Effect.runSync(
        machine.update(state, intermediate, {
          series: [value],
          builtins: [],
          requests: [],
        }),
      );
      state = result.state;
      intermediate = result.intermediate;
      outputs.push(...result.output.map(output => [...output.channels]));
      effects.push(...result.effects.map(effect => effect.payload as Value));
    }

    expect(outputs).toEqual(sink.outputs);
    expect(effects).toEqual(sink.effects);
    expect(outputs).toEqual([
      [1, NaN, NaN],
      [2, 1, NaN],
      [3, 2, 1],
      [4, 3, 2],
    ]);
    expect(effects).toEqual(values);
    expect(state.root.series[0]?.values).toEqual([4]);
    expect(state.root.locals[0]?.ring.values).toEqual([4, 3]);

    execution.dispose();
    heap.dispose();
  });

  test('separates committed State from provisional Intermediate', async () => {
    const close = new ArraySeries([10, 5]);
    const sink = new Sink();
    const execution = await bind(PROVISIONAL_MODULE, {
      params: {},
      provider: provider(close),
      sink,
      timeNow: 0,
    });

    execution.executeRow(0, true);
    close.values[0] = 11;
    execution.executeRow(0, true);
    close.values[0] = 12;
    execution.executeRow(0, false);
    execution.commitRow(0);
    execution.executeRow(1, false);
    execution.commitRow(1);

    const heap = new HeapArena();
    const machine = stateMachine(
      PROVISIONAL_MODULE,
      [],
      new ValueLayoutRegistry(LAYOUTS),
      heap,
    );
    let state = machine.initialState;
    let intermediate = machine.initialIntermediate;
    const initialState = state;
    const outputs: Value[][] = [];
    const effects: Value[] = [];

    const execute = (value: number, commit: boolean) => {
      const result = Effect.runSync(
        machine.update(state, intermediate, {
          series: [value],
          builtins: [],
          requests: [],
        }),
      );
      intermediate = result.intermediate;
      if (commit) state = result.state;
      outputs.push(...result.output.map(output => [...output.channels]));
      effects.push(...result.effects.map(effect => effect.payload as Value));
    };

    execute(10, false);
    expect(state).toBe(initialState);
    expect(intermediate.root.locals[1]?.value).toBe(1);
    execute(11, false);
    expect(state).toBe(initialState);
    expect(intermediate.root.locals[1]?.value).toBe(2);
    execute(12, true);
    execute(5, true);

    expect(outputs).toEqual(sink.outputs);
    expect(effects).toEqual(sink.effects);
    expect(outputs).toEqual([
      [10, 1, 10],
      [11, 2, 11],
      [12, 3, 12],
      [17, 4, 5],
    ]);
    expect(effects).toEqual([10, 11, 12, 5]);
    expect(sink.executions.map(value => value.provisional)).toEqual([
      true,
      true,
      false,
      false,
    ]);

    execution.dispose();
    heap.dispose();
  });

  test('commits successful struct edits and aborts failed edits', async () => {
    let oldFailure = false;
    const oldSink = new Sink();
    const oldExecution = await bind(
      structModule(() => oldFailure),
      {
        params: {},
        provider: provider([0]),
        sink: oldSink,
        timeNow: 0,
      },
    );
    oldExecution.executeRow(0, true);
    oldFailure = true;
    expect(() => oldExecution.executeRow(0, true)).toThrow(
      'struct update failed',
    );
    oldFailure = false;
    oldExecution.executeRow(0, true);
    oldExecution.executeRow(0, false);
    oldExecution.commitRow(0);

    let failure = false;
    const heap = new HeapArena();
    const machine = stateMachine(
      structModule(() => failure),
      [],
      new ValueLayoutRegistry(LAYOUTS),
      heap,
    );
    let state = machine.initialState;
    let intermediate = machine.initialIntermediate;
    const outputs: Value[][] = [];

    const execute = (commit: boolean) => {
      const result = Effect.runSync(
        machine.update(state, intermediate, {
          series: [],
          builtins: [],
          requests: [],
        }),
      );
      intermediate = result.intermediate;
      if (commit) state = result.state;
      outputs.push(...result.output.map(output => [...output.channels]));
    };

    execute(false);
    failure = true;
    expect(() => execute(false)).toThrow('struct update failed');
    expect(heap.stats().tentativeCells).toBe(0);
    failure = false;
    execute(false);
    execute(true);

    expect(outputs).toEqual(oldSink.outputs);
    expect(outputs).toEqual([[1], [2], [3]]);

    oldExecution.dispose();
    heap.dispose();
  });

  test('matches array, matrix, and map replacement semantics', async () => {
    const close = new ArraySeries([1, 2]);
    const oldSink = new Sink();
    const oldExecution = await bind(COLLECTION_MODULE, {
      params: {},
      provider: provider(close),
      sink: oldSink,
      timeNow: 0,
    });
    oldExecution.executeRow(0, true);
    oldExecution.executeRow(0, false);
    oldExecution.commitRow(0);
    oldExecution.executeRow(1, false);
    oldExecution.commitRow(1);

    const heap = new HeapArena();
    const machine = stateMachine(
      COLLECTION_MODULE,
      [],
      new ValueLayoutRegistry(LAYOUTS),
      heap,
    );
    let state = machine.initialState;
    let intermediate = machine.initialIntermediate;
    const outputs: Value[][] = [];

    const execute = (value: number, commit: boolean) => {
      const result = Effect.runSync(
        machine.update(state, intermediate, {
          series: [value],
          builtins: [],
          requests: [],
        }),
      );
      intermediate = result.intermediate;
      if (commit) state = result.state;
      outputs.push(...result.output.map(output => [...output.channels]));
    };

    execute(1, false);
    execute(1, true);
    execute(2, true);

    expect(outputs).toEqual(oldSink.outputs);
    expect(outputs).toEqual([
      [2, 1, 1, 2],
      [3, 1, 1, 3],
      [4, 2, 2, 4],
    ]);

    oldExecution.dispose();
    heap.dispose();
  });
});
