// Purpose: Aggregate state/history, provisional commit, request-Heap isolation,
// host-boundary, ABI, and disposal integration tests for the step runtime.

import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {
  BindError,
  type BindInputs,
  type DataProvider,
  ExecutionError,
  type OutputSink,
  type ProviderContext,
  type TimeAxis,
  type Value,
} from './abi';
import {bindFixedHistory as bindRuntime} from './fixed-history';
import {RUNTIME_ABI_VERSION, type JSModule} from './module-abi';
import {staticModuleBinding, testModule} from './testing';
import type {ValueLayout} from './value-layout';

const TEST_TIME_NOW = 1_800_000_000_000;

function bind(
  module: JSModule,
  inputs: Omit<BindInputs, 'timeNow'> & {readonly timeNow?: number},
) {
  return bindRuntime(module, {
    ...inputs,
    timeNow: inputs.timeNow ?? TEST_TIME_NOW,
  });
}

const INT = 0;
const ARRAY = 1;
const HOLDER = 2;
const COUNTER = 3;
const INT_PAIR = 4;
const LAYOUTS = [
  {kind: 'number', numeric: 'int'},
  {kind: 'array', element: INT},
  {
    kind: 'struct',
    name: 'Holder',
    fields: [{name: 'values', layout: ARRAY}],
  },
  {
    kind: 'struct',
    name: 'Counter',
    fields: [{name: 'value', layout: INT}],
  },
  {kind: 'tuple', elements: [INT, INT]},
] as const satisfies readonly ValueLayout[];

class Sink implements OutputSink {
  readonly values: {
    row: number;
    values: readonly Value[];
    provisional: boolean;
  }[] = [];

  declare(): void {}

  publish(publication: Parameters<OutputSink['publish']>[0]): void {
    for (const output of publication.outputs) {
      this.values.push({
        row: publication.row,
        values: [...output.channels],
        provisional: publication.provisional,
      });
    }
  }
}

function context(
  rows = 2,
  values: readonly number[] = [1, 2],
): ProviderContext {
  return {
    rows,
    axis: null,
    series: id =>
      id === 'close' ? {length: rows, at: row => values[row]} : null,
    builtinValue: () => undefined,
  };
}

function provider(value: ProviderContext = context()): DataProvider {
  return {resolveContext: () => Promise.resolve(value)};
}

const OUTPUT = {
  effect: 'probe',
  staticArgs: [],
  channels: [{name: 'value', type: 'int', transport: {kind: 'int'}}],
} as const;

function arrayStateModule(): JSModule {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
    layout: LAYOUTS,
    manifest: {
      series: [{id: 'close', depth: {kind: 'none'}}],
      builtin: [],
      params: [],
      outputs: [
        {
          ...OUTPUT,
          channels: [
            {name: 'var', type: 'int', transport: {kind: 'int'}},
            {name: 'varip', type: 'int', transport: {kind: 'int'}},
          ],
        },
      ],
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
    evaluateBinding() {
      return staticModuleBinding(this);
    },
    funcs: {},
    main(ctx, fr) {
      if (ctx.needsInit(fr, 0)) {
        ctx.initialize(fr, 0, ctx.callCollection('array.from', ARRAY, [0]));
      }
      if (ctx.needsInit(fr, 1)) {
        ctx.initialize(fr, 1, ctx.callCollection('array.from', ARRAY, [0]));
      }
      for (let slot = 0; slot < 2; slot += 1) {
        const mutation = ctx.mutateCollection(
          'array.push',
          ARRAY,
          ctx.read(fr, slot, 0),
          [ctx.series(0, 0)],
        );
        ctx.write(fr, slot, mutation.replacement);
        ctx.emit(
          0,
          slot,
          ctx.callCollection('array.size', INT, [mutation.replacement]),
        );
      }
    },
  });
}

describe('aggregate state and commit integration', () => {
  test('a first-row var struct keeps its reference while its body accumulates across ticks', async () => {
    const sink = new Sink();
    let fail = false;
    const module = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: LAYOUTS,
      manifest: {
        series: [],
        builtin: [],
        params: [],
        outputs: [OUTPUT],
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
      main(ctx, fr) {
        if (ctx.needsInit(fr, 0)) {
          ctx.initialize(fr, 0, ctx.newStruct(COUNTER, [0]));
        }
        const counter = ctx.requireStruct(ctx.read(fr, 0, 0), COUNTER);
        const next = (ctx.structField(counter, COUNTER, 0) as number) + 1;
        ctx.storeStructField(counter, COUNTER, 0, next);
        if (fail) throw new Error('tick failed');
        ctx.emit(0, 0, next);
      },
    });
    const bound = await bind(module, {
      params: {},
      provider: provider(context(1)),
      sink,
    });

    bound.executeRow(0, true);
    fail = true;
    expect(() => bound.executeRow(0, true)).toThrow('tick failed');
    fail = false;
    bound.executeRow(0, true);
    bound.executeRow(0, false);
    bound.commitRow(0);

    expect(sink.values.map(entry => entry.values[0])).toEqual([1, 2, 3]);
  });

  test('provisional var rolls back while varip retains its immutable header', async () => {
    const sink = new Sink();
    const bound = await bind(arrayStateModule(), {
      params: {},
      provider: provider(),
      sink,
    });

    bound.executeRow(0, true);
    bound.executeRow(0, false);
    bound.commitRow(0);
    bound.executeRow(1, false);
    bound.commitRow(1);

    expect(sink.values.map(entry => entry.values)).toEqual([
      [2, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(sink.values.map(entry => entry.provisional)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test('a provisional sink failure makes the binding terminal', async () => {
    const recorded = new Sink();
    let failed = false;
    const sink: OutputSink = {
      declare() {},
      publish(publication) {
        if (publication.provisional && !failed) {
          failed = true;
          throw new Error('sink failed');
        }
        recorded.publish(publication);
      },
    };
    const bound = await bind(arrayStateModule(), {
      params: {},
      provider: provider(),
      sink,
    });

    expect(() => bound.executeRow(0, true)).toThrow('sink failed');
    expect(() => bound.executeRow(0, false)).toThrow('sink failed');
    expect(recorded.values).toEqual([]);
  });

  test('an aborted ordinary transaction restores the last completed varip header', async () => {
    const sink = new Sink();
    let fail = false;
    const base = arrayStateModule();
    const module = testModule({
      ...base,
      main(ctx, fr) {
        base.main(ctx, fr);
        if (fail) {
          throw new Error('transaction failed');
        }
      },
    });
    const bound = await bind(module, {
      params: {},
      provider: provider(),
      sink,
    });

    bound.executeRow(0, true);
    fail = true;
    expect(() => bound.executeRow(0, false)).toThrow('transaction failed');
    fail = false;
    bound.executeRow(0, false);
    bound.commitRow(0);

    expect(sink.values.map(entry => entry.values)).toEqual([
      [2, 2],
      [2, 3],
    ]);
  });

  test('an aborted first transaction reruns aggregate varip initialization', async () => {
    const sink = new Sink();
    let fail = true;
    const base = arrayStateModule();
    const module = testModule({
      ...base,
      main(ctx, fr) {
        base.main(ctx, fr);
        if (fail) {
          throw new Error('first transaction failed');
        }
      },
    });
    const bound = await bind(module, {
      params: {},
      provider: provider(),
      sink,
    });

    expect(() => bound.executeRow(0, false)).toThrow(
      'first transaction failed',
    );
    fail = false;
    bound.executeRow(0, false);
    bound.commitRow(0);
    expect(sink.values[0].values).toEqual([2, 2]);
  });

  test('a failed replacement allocation leaves its retained root unchanged', async () => {
    const sink = new Sink();
    const failures: {
      code: string;
      rootIdentityPreserved: boolean;
    }[] = [];
    const module = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: LAYOUTS,
      manifest: {
        series: [],
        builtin: [
          {
            source: {domain: 'bar', field: 'bar_index'},
            layout: INT,
            depth: {kind: 'none'},
          },
        ],
        params: [],
        outputs: [
          {
            ...OUTPUT,
            channels: [
              {name: 'size', type: 'int', transport: {kind: 'int'}},
              {name: 'first', type: 'int', transport: {kind: 'int'}},
            ],
          },
        ],
        effects: [],
        requests: [],
        frames: [
          {
            locals: [
              {storage: Storage.Var, depth: {kind: 'none'}, layout: ARRAY},
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
        if (ctx.needsInit(fr, 0)) {
          ctx.initialize(fr, 0, ctx.callCollection('array.from', ARRAY, [7]));
        }
        if (ctx.builtin(0, 0) === 1) {
          const before = ctx.read(fr, 0, 0);
          let failedCode: string | null = null;
          try {
            ctx.mutateCollection('array.push', ARRAY, before, [8]);
          } catch (error) {
            if (!(error instanceof ExecutionError)) {
              throw error;
            }
            failedCode = error.code;
          }
          if (failedCode !== null) {
            failures.push({
              code: failedCode,
              rootIdentityPreserved: ctx.read(fr, 0, 0) === before,
            });
          }
        }
        const current = ctx.read(fr, 0, 0);
        ctx.emit(0, 0, ctx.callCollection('array.size', INT, [current]));
        ctx.emit(0, 1, ctx.callCollection('array.get', INT, [current, 0]));
      },
    });
    const bound = await bind(module, {
      params: {},
      provider: provider(context(2)),
      sink,
      // The one-element initializer is 24 bytes; its two-element replacement
      // is 32 and must fail before it can replace the caller's retained root.
      maxHeapTransientLogicalBytes: 24,
    });

    await bound.runAll();
    expect(failures).toEqual([
      {code: 'HEAP_LIMIT_EXCEEDED', rootIdentityPreserved: true},
    ]);
    expect(sink.values.map(entry => entry.values)).toEqual([
      [1, 7],
      [1, 7],
    ]);
    bound.dispose();
  });

  test('a final sink failure occurs after Tea state commits', async () => {
    let throws = true;
    const sink: OutputSink = {
      declare() {},
      publish() {
        if (throws) {
          throws = false;
          throw new Error('delivery failed');
        }
      },
    };
    const bound = await bind(arrayStateModule(), {
      params: {},
      provider: provider(),
      sink,
    });
    bound.executeRow(0, false);
    expect(() => bound.commitRow(0)).toThrow('delivery failed');
    // Row 0 is committed, but delivery failure terminally closes execution so
    // the runtime can never retry or duplicate externally visible work.
    expect(() => bound.executeRow(1, false)).toThrow('delivery failed');
  });

  test('struct history stores live references rather than body snapshots', async () => {
    const sink = new Sink();
    const module = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: LAYOUTS,
      manifest: {
        series: [],
        builtin: [
          {
            source: {domain: 'bar', field: 'bar_index'},
            layout: INT,
            depth: {kind: 'none'},
          },
        ],
        params: [],
        outputs: [
          {
            ...OUTPUT,
            channels: [
              {name: 'current', type: 'int', transport: {kind: 'int'}},
              {name: 'prior', type: 'int', transport: {kind: 'int'}},
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
                depth: {kind: 'const', bars: 1},
                layout: HOLDER,
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
        if (ctx.needsInit(fr, 0)) {
          ctx.initialize(
            fr,
            0,
            ctx.newStruct(HOLDER, [
              ctx.callCollection('array.from', ARRAY, [0]),
            ]),
          );
        }
        const current = ctx.read(fr, 0, 0);
        const values = ctx.structField(current, HOLDER, 0);
        const mutation = ctx.mutateCollection('array.push', ARRAY, values, [
          (ctx.builtin(0, 0) as number) + 1,
        ]);
        ctx.storeStructField(current, HOLDER, 0, mutation.replacement);
        ctx.emit(
          0,
          0,
          ctx.callCollection('array.size', INT, [mutation.replacement]),
        );
        if ((ctx.builtin(0, 0) as number) > 0) {
          const prior = ctx.structField(ctx.read(fr, 0, 1), HOLDER, 0);
          ctx.emit(0, 1, ctx.callCollection('array.size', INT, [prior]));
        } else {
          ctx.emit(0, 1, NaN);
        }
      },
    });
    const bound = await bind(module, {
      params: {},
      provider: provider(context(2)),
      sink,
    });
    await bound.runAll();
    expect(sink.values.map(entry => entry.values)).toEqual([
      [2, NaN],
      [3, 3],
    ]);
  });
});

describe('request Heap isolation', () => {
  test('runtime rejects a Heap-backed result from a hand-authored module', async () => {
    const axis: TimeAxis = {
      time: () => 0,
      closeTime: () => 60,
    };
    const primary: ProviderContext = {
      rows: 1,
      axis,
      series: () => null,
      builtinValue: () => undefined,
    };
    const contexts: DataProvider = {
      resolveContext: symbol => {
        if (symbol === '' || symbol === 'MID' || symbol === 'LEAF') {
          return Promise.resolve(primary);
        }
        return Promise.resolve({
          error: 'unknownSymbol' as const,
          detail: `no context '${symbol}'`,
        });
      },
    };
    const leaf = testModule({
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
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: ARRAY},
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
        ctx.write(fr, 0, ctx.callCollection('array.from', ARRAY, [41]));
      },
    });
    const middle = testModule({
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
            merge: {
              mode: 'sample',
            },
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: ARRAY,
            dynamic: false,
          },
        ],
        frames: [
          {
            locals: [
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: ARRAY},
            ],
            subs: [],
          },
        ],
      },
      requests: [leaf],
      evaluateBinding() {
        return staticModuleBinding(this, {
          requests: [
            {
              symbol: 'LEAF',
              timeframe: '',
              gaps: false,
              lookahead: false,
              ignoreInvalidSymbol: false,
              calcBarsCount: 0,
            },
          ],
        });
      },
      funcs: {},
      main(ctx, fr) {
        ctx.write(fr, 0, ctx.request(0, 0));
      },
    });
    const root = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: LAYOUTS,
      manifest: {
        series: [],
        builtin: [],
        params: [],
        outputs: [OUTPUT],
        effects: [],
        requests: [
          {
            merge: {
              mode: 'sample',
            },
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: ARRAY,
            dynamic: false,
          },
        ],
        frames: [{locals: [], subs: []}],
      },
      requests: [middle],
      evaluateBinding() {
        return staticModuleBinding(this, {
          requests: [
            {
              symbol: 'MID',
              timeframe: '',
              gaps: false,
              lookahead: false,
              ignoreInvalidSymbol: false,
              calcBarsCount: 0,
            },
          ],
        });
      },
      funcs: {},
      main(ctx) {
        ctx.emit(
          0,
          0,
          ctx.callCollection('array.first', INT, [ctx.request(0, 0)]),
        );
      },
    });
    await expect(
      bind(root, {
        params: {},
        provider: contexts,
        sink: new Sink(),
      }),
    ).rejects.toThrow('cannot cross a runtime Heap boundary');
  });

  test('scalar tuples cross the child boundary as frozen copies', async () => {
    const axis: TimeAxis = {time: () => 0, closeTime: () => 60};
    const context: ProviderContext = {
      rows: 1,
      axis,
      series: () => null,
      builtinValue: () => undefined,
    };
    let childTuple: Value = null;
    let copied = false;
    let frozen = false;
    const child = testModule({
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
              {
                storage: Storage.PerBar,
                depth: {kind: 'none'},
                layout: INT_PAIR,
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
        const value = [41, 42] as const;
        childTuple = value;
        ctx.write(fr, 0, value);
      },
    });
    const root = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: LAYOUTS,
      manifest: {
        series: [],
        builtin: [],
        params: [],
        outputs: [
          {
            ...OUTPUT,
            channels: [
              {name: 'left', type: 'int', transport: {kind: 'int'}},
              {name: 'right', type: 'int', transport: {kind: 'int'}},
            ],
          },
        ],
        effects: [],
        requests: [
          {
            merge: {mode: 'sample'},
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: INT_PAIR,
            dynamic: false,
          },
        ],
        frames: [{locals: [], subs: []}],
      },
      requests: [child],
      evaluateBinding() {
        return staticModuleBinding(this, {
          requests: [
            {
              symbol: 'X',
              timeframe: '',
              gaps: false,
              lookahead: false,
              ignoreInvalidSymbol: false,
              calcBarsCount: 0,
            },
          ],
        });
      },
      funcs: {},
      main(ctx) {
        const result = ctx.request(0, 0);
        if (!Array.isArray(result)) throw new Error('expected tuple result');
        copied = result !== childTuple;
        frozen = Object.isFrozen(result);
        ctx.emit(0, 0, result[0]);
        ctx.emit(0, 1, result[1]);
      },
    });
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: {resolveContext: () => Promise.resolve(context)},
      sink,
    });
    await bound.runAll();
    expect(sink.values[0].values).toEqual([41, 42]);
    expect(copied).toBe(true);
    expect(frozen).toBe(true);
    bound.dispose();
  });

  test('keep-zero scalar result columns outlive released child workspace', async () => {
    const axis: TimeAxis = {
      time: row => row * 60,
      closeTime: row => (row + 1) * 60,
    };
    const primary: ProviderContext = {
      rows: 2,
      axis,
      series: () => null,
      builtinValue: () => undefined,
    };
    const childContext: ProviderContext = {
      rows: 2,
      axis,
      series: id => (id === 'close' ? {length: 2, at: row => row + 10} : null),
      builtinValue: () => undefined,
    };
    const contexts: DataProvider = {
      resolveContext: symbol =>
        Promise.resolve(symbol === 'X' ? childContext : primary),
    };
    const child = testModule({
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
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: INT},
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
      },
    });
    const root = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: LAYOUTS,
      manifest: {
        series: [],
        builtin: [],
        params: [],
        outputs: [
          {
            ...OUTPUT,
            channels: [
              {name: 'first', type: 'int', transport: {kind: 'int'}},
              {name: 'second', type: 'int', transport: {kind: 'int'}},
            ],
          },
        ],
        frames: [{locals: [], subs: []}],
        effects: [],
        requests: [
          {
            merge: {
              mode: 'sample',
            },
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: INT,
            dynamic: false,
          },
          {
            merge: {
              mode: 'sample',
            },
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: INT,
            dynamic: false,
          },
        ],
      },
      requests: [child, child],
      evaluateBinding() {
        const request = {
          symbol: 'X',
          timeframe: '',
          gaps: false,
          lookahead: false,
          ignoreInvalidSymbol: false,
          calcBarsCount: 0,
        } as const;
        return staticModuleBinding(this, {requests: [request, request]});
      },
      funcs: {},
      main(ctx) {
        ctx.emit(0, 0, ctx.request(0, 0));
        ctx.emit(0, 1, ctx.request(1, 0));
      },
    });
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: contexts,
      sink,
      // Peak: the first 64-byte result column remains while the second child
      // uses 32 bytes of workspace and builds its own 64-byte result column.
      maxFixedValueLogicalBytes: 160,
    });
    await bound.runAll();
    expect(sink.values.map(entry => entry.values)).toEqual([
      [10, 10],
      [11, 11],
    ]);
    bound.dispose();
  });

  test('parent and child enforce one-cell Heap limits independently', async () => {
    const axis: TimeAxis = {
      time: () => 0,
      closeTime: () => 60,
    };
    const primary: ProviderContext = {
      rows: 1,
      axis,
      series: () => null,
      builtinValue: () => undefined,
    };
    const childContext: ProviderContext = {
      rows: 1,
      axis,
      series: id => (id === 'close' ? {length: 1, at: () => 10} : null),
      builtinValue: () => undefined,
    };
    const contexts: DataProvider = {
      resolveContext: symbol =>
        Promise.resolve(symbol === 'X' ? childContext : primary),
    };
    const child = testModule({
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
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: INT},
              {storage: Storage.Var, depth: {kind: 'none'}, layout: ARRAY},
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
        if (ctx.needsInit(fr, 1)) {
          ctx.initialize(fr, 1, ctx.callCollection('array.from', ARRAY, [99]));
        }
        ctx.write(fr, 0, ctx.series(0, 0));
        const mutation = ctx.mutateCollection(
          'array.push',
          ARRAY,
          ctx.read(fr, 1, 0),
          [ctx.series(0, 0)],
        );
        ctx.write(fr, 1, mutation.replacement);
      },
    });
    const root = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: LAYOUTS,
      manifest: {
        series: [],
        builtin: [],
        params: [],
        outputs: [OUTPUT],
        effects: [],
        requests: [
          {
            merge: {
              mode: 'sample',
            },
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: INT,
            dynamic: false,
          },
        ],
        frames: [
          {
            locals: [
              {
                storage: Storage.PerBar,
                depth: {kind: 'const', bars: 1},
                layout: ARRAY,
              },
            ],
            subs: [],
          },
        ],
      },
      requests: [child],
      evaluateBinding() {
        return staticModuleBinding(this, {
          requests: [
            {
              symbol: 'X',
              timeframe: '',
              gaps: false,
              lookahead: false,
              ignoreInvalidSymbol: false,
              calcBarsCount: 0,
            },
          ],
        });
      },
      funcs: {},
      main(ctx, fr) {
        ctx.write(fr, 0, ctx.callCollection('array.from', ARRAY, [7]));
        ctx.emit(0, 0, ctx.request(0, 0));
      },
    });
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: contexts,
      sink,
      // Parent and child each own an independent one-cell Heap budget.
      maxHeapStorageCells: 1,
    });

    await bound.runAll();
    expect(sink.values[0].values).toEqual([10]);
    bound.dispose();
  });
});

describe('runtime boundaries', () => {
  test('all host budgets reject invalid limits at the bind boundary', async () => {
    const names = [
      'maxRequestContexts',
      'maxCollectionElements',
      'maxHeapStorageCells',
      'maxHeapLogicalBytes',
      'maxHeapTransientStorageCells',
      'maxHeapTransientLogicalBytes',
      'maxFixedValueLogicalBytes',
    ] as const satisfies readonly (keyof BindInputs)[];
    for (const name of names) {
      for (const invalid of [-1, 1.5, NaN, Infinity]) {
        await expect(
          bind(arrayStateModule(), {
            params: {},
            provider: provider(),
            sink: new Sink(),
            [name]: invalid,
          }),
        ).rejects.toThrow(`${name} must be a non-negative safe integer`);
      }
    }
  });

  test('fixed state workspace reserves exact shallow-layout bytes at bind', async () => {
    const exact = await bind(arrayStateModule(), {
      params: {},
      provider: provider(),
      sink: new Sink(),
      // Two persistent array locals reserve a current/scratch pair each:
      // 2 * 2 * shallowBytes(array=32) = 128 bytes. The depth-none input is
      // supplied directly to each step and needs no retained state cell.
      maxFixedValueLogicalBytes: 128,
    });
    exact.dispose();

    await expect(
      bind(arrayStateModule(), {
        params: {},
        provider: provider(),
        sink: new Sink(),
        maxFixedValueLogicalBytes: 127,
      }),
    ).rejects.toThrow('FIXED_VALUE_STORAGE_LIMIT_EXCEEDED');
  });

  test('all reachable frame workspace is reserved before the first step', async () => {
    let requestLargeFrame = true;
    const module = testModule({
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
          {locals: [], subs: [{fid: 1}, {fid: 2}]},
          {
            locals: [
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: ARRAY},
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: ARRAY},
            ],
            subs: [],
          },
          {
            locals: [
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: ARRAY},
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
        ctx.frame(fr, requestLargeFrame ? 0 : 1);
      },
    });
    const bound = await bind(module, {
      params: {},
      provider: provider(),
      sink: new Sink(),
      // All three per-bar array cells are part of the bounded state shape,
      // regardless of which subframe the first row enters.
      maxFixedValueLogicalBytes: 96,
    });

    bound.executeRow(0, false);
    bound.commitRow(0);
    bound.dispose();

    requestLargeFrame = false;
    await expect(
      bind(module, {
        params: {},
        provider: provider(),
        sink: new Sink(),
        maxFixedValueLogicalBytes: 95,
      }),
    ).rejects.toThrow('FIXED_VALUE_STORAGE_LIMIT_EXCEEDED');
  });

  test('a non-current ABI is rejected before binding evaluation', async () => {
    let evaluated = false;
    const current = arrayStateModule();
    const oldAbi = RUNTIME_ABI_VERSION - 1;
    const old = Object.create(current, {
      abi: {value: oldAbi, enumerable: true},
      evaluateBinding: {
        enumerable: true,
        get() {
          evaluated = true;
          return current.evaluateBinding;
        },
      },
    });
    await expect(
      bind(old, {params: {}, provider: provider(), sink: new Sink()}),
    ).rejects.toThrow(
      `unsupported module ABI ${oldAbi}; expected ${RUNTIME_ABI_VERSION}`,
    );
    expect(evaluated).toBe(false);
  });

  test('dispose aborts a pending final row and is idempotent', async () => {
    const bound = await bind(arrayStateModule(), {
      params: {},
      provider: provider(),
      sink: new Sink(),
    });
    bound.executeRow(0, false);
    bound.dispose();
    bound.dispose();
    expect(() => bound.commitRow(0)).toThrow('runtime is disposed');
    expect(() => bound.executeRow(0, false)).toThrow('runtime is disposed');
  });
});
