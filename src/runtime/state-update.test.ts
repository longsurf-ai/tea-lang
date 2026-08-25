// Purpose: Differential coverage for the first StateUpdate slice: external
// input history, local history, dense outputs, and scalar effects.

import {Effect} from 'effect';
import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {
  type DataProvider,
  type OutputSink,
  type ProviderContext,
  type Value,
} from './abi';
import {ArenaHeap} from './heap';
import {bindFixedHistory as bind} from './fixed-history';
import {RUNTIME_ABI_VERSION, type JSModule} from './module-abi';
import {stateMachine} from './state-update';
import {staticModuleBinding, testModule} from './testing';
import {ValueLayoutRegistry, type ValueLayout} from './value-layout';

const NUMBER = 0;
const ARRAY = 1;
const MATRIX = 2;
const MAP = 3;
const COUNTER = 4;
const LAYOUTS = [
  {kind: 'number', numeric: 'int'},
  {kind: 'array', element: NUMBER},
  {kind: 'matrix', element: NUMBER},
  {kind: 'map', key: NUMBER, value: NUMBER},
  {
    kind: 'struct',
    name: 'Counter',
    fields: [{name: 'value', layout: NUMBER}],
  },
] as const satisfies readonly ValueLayout[];

const MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: LAYOUTS,
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
  evaluateBinding() {
    return staticModuleBinding(this);
  },
  funcs: {},
  main(ctx, root) {
    const current = ctx.series(0, 0);
    ctx.write(root, 0, current);
    ctx.emit(0, 0, current);
    ctx.emit(0, 1, ctx.series(0, 1));
    ctx.emit(0, 2, ctx.read(root, 0, 2));
    ctx.emitEffect(0, current);
  },
});

const PROVISIONAL_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: LAYOUTS,
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
  evaluateBinding() {
    return staticModuleBinding(this);
  },
  funcs: {},
  main(ctx, root) {
    if (ctx.needsInit(root, 0)) ctx.initialize(root, 0, 0);
    if (ctx.needsInit(root, 1)) ctx.initialize(root, 1, 0);
    const close = ctx.series(0, 0);
    ctx.write(root, 0, Number(ctx.read(root, 0, 0)) + close);
    ctx.write(root, 1, Number(ctx.read(root, 1, 0)) + 1);
    ctx.write(root, 2, close);
    ctx.emit(0, 0, ctx.read(root, 0, 0));
    ctx.emit(0, 1, ctx.read(root, 1, 0));
    ctx.emit(0, 2, ctx.read(root, 2, 0));
    ctx.emitEffect(0, close);
  },
});

function structModule(shouldFail: () => boolean): JSModule {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
    layout: LAYOUTS,
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
    evaluateBinding() {
      return staticModuleBinding(this);
    },
    funcs: {},
    main(ctx, root) {
      if (ctx.needsInit(root, 0)) {
        ctx.initialize(root, 0, ctx.newStruct(COUNTER, [0]));
      }
      const counter = ctx.requireStruct(ctx.read(root, 0, 0), COUNTER);
      const value = Number(ctx.structField(counter, COUNTER, 0)) + 1;
      ctx.storeStructField(counter, COUNTER, 0, value);
      if (shouldFail()) throw new Error('struct update failed');
      ctx.emit(0, 0, value);
    },
  });
}

const COLLECTION_MODULE: JSModule = testModule({
  abi: RUNTIME_ABI_VERSION,
  layout: LAYOUTS,
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
  evaluateBinding() {
    return staticModuleBinding(this);
  },
  funcs: {},
  main(ctx, root) {
    if (ctx.needsInit(root, 0)) {
      ctx.initialize(root, 0, ctx.callCollection('array.from', ARRAY, [0]));
    }
    if (ctx.needsInit(root, 1)) {
      ctx.initialize(
        root,
        1,
        ctx.callCollection('matrix.new', MATRIX, [1, 1, 0]),
      );
    }
    if (ctx.needsInit(root, 2)) {
      ctx.initialize(root, 2, ctx.callCollection('map.new', MAP, []));
    }

    const close = ctx.series(0, 0);
    const array = ctx.mutateCollection(
      'array.push',
      ARRAY,
      ctx.read(root, 0, 0),
      [close],
    ).replacement;
    const matrix = ctx.mutateCollection(
      'matrix.set',
      MATRIX,
      ctx.read(root, 1, 0),
      [0, 0, close],
    ).replacement;
    const map = ctx.mutateCollection('map.put', MAP, ctx.read(root, 2, 0), [
      close,
      close + 10,
    ]).replacement;
    ctx.write(root, 0, array);
    ctx.write(root, 1, matrix);
    ctx.write(root, 2, map);

    ctx.emit(0, 0, ctx.callCollection('array.size', NUMBER, [array]));
    ctx.emit(0, 1, ctx.callCollection('matrix.get', NUMBER, [matrix, 0, 0]));
    ctx.emit(0, 2, ctx.callCollection('map.size', NUMBER, [map]));
    ctx.emit(0, 3, ctx.collectionEntries(array).length);
  },
});

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

    const heap = new ArenaHeap();
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
          provisional: false,
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
    expect(state.root.locals[0]?.history.values).toEqual([4, 3]);

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

    const heap = new ArenaHeap();
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
          provisional: !commit,
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
    const heap = new ArenaHeap();
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
          provisional: !commit,
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

    const heap = new ArenaHeap();
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
          provisional: !commit,
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
