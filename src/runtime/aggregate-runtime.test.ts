// Purpose: JSRuntime aggregate integration tests for Ring history, var/varip provisional policy, sink boundaries, request rooting, ABI gating, and disposal.

import {describe, expect, test} from 'bun:test';
import {InternalError} from '../base/print';
import {Storage} from '../ir/node';
import {
  BindError,
  type AggregateLayoutManifest,
  type BindInputs,
  type DataProvider,
  ExecutionError,
  type ModuleCode,
  type OutputSink,
  type ProviderContext,
  RUNTIME_ABI_VERSION,
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

const INT = 0;
const ARRAY = 1;
const HOLDER = 2;
const LAYOUTS = {
  layouts: [
    {kind: 'number', numeric: 'int'},
    {kind: 'array', element: INT},
    {
      kind: 'user-type',
      name: 'Holder',
      fields: [{name: 'values', layout: ARRAY}],
    },
  ],
} as const satisfies AggregateLayoutManifest;

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

function arrayStateModule(): TeaModule {
  return {
    abi: RUNTIME_ABI_VERSION,
    aggregateLayouts: LAYOUTS,
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
    init() {},
    bind() {},
    funcs: {},
    main(rt, fr) {
      if (rt.needsInit(fr, 0)) {
        rt.initialize(fr, 0, rt.callCollection('array.from', ARRAY, [0]));
      }
      if (rt.needsInit(fr, 1)) {
        rt.initialize(fr, 1, rt.callCollection('array.from', ARRAY, [0]));
      }
      for (let slot = 0; slot < 2; slot += 1) {
        const mutation = rt.mutateCollection(
          'array.push',
          ARRAY,
          rt.read(fr, slot, 0),
          [rt.series(0, 0)],
        );
        rt.write(fr, slot, mutation.replacement);
        rt.emit(
          0,
          slot,
          rt.callCollection('array.size', INT, [mutation.replacement]),
        );
      }
    },
  };
}

describe('aggregate Ring and commit integration', () => {
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

  test('an aborted ordinary attempt restores the last completed varip header', async () => {
    const sink = new Sink();
    let fail = false;
    const base = arrayStateModule();
    const module: TeaModule = {
      ...base,
      main(rt, fr) {
        base.main(rt, fr);
        if (fail) {
          throw new Error('attempt failed');
        }
      },
    };
    const bound = await bind(module, {
      params: {},
      provider: provider(),
      sink,
    });

    bound.executeRow(0, true);
    fail = true;
    expect(() => bound.executeRow(0, false)).toThrow('attempt failed');
    fail = false;
    bound.executeRow(0, false);
    bound.commitRow(0);

    expect(sink.values.map(entry => entry.values)).toEqual([
      [2, 2],
      [2, 3],
    ]);
  });

  test('an aborted first attempt reruns aggregate varip initialization', async () => {
    const sink = new Sink();
    let fail = true;
    const base = arrayStateModule();
    const module: TeaModule = {
      ...base,
      main(rt, fr) {
        base.main(rt, fr);
        if (fail) {
          throw new Error('first attempt failed');
        }
      },
    };
    const bound = await bind(module, {
      params: {},
      provider: provider(),
      sink,
    });

    expect(() => bound.executeRow(0, false)).toThrow('first attempt failed');
    fail = false;
    bound.executeRow(0, false);
    bound.commitRow(0);
    expect(sink.values[0].values).toEqual([2, 2]);
  });

  test('a failed replacement allocation leaves its caller Ring root unchanged', async () => {
    const sink = new Sink();
    const failures: {
      code: string;
      rootIdentityPreserved: boolean;
    }[] = [];
    const module: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        if (rt.needsInit(fr, 0)) {
          rt.initialize(fr, 0, rt.callCollection('array.from', ARRAY, [7]));
        }
        if (rt.builtin(0, 0) === 1) {
          const before = rt.read(fr, 0, 0);
          let failedCode: string | null = null;
          try {
            rt.mutateCollection('array.push', ARRAY, before, [8]);
          } catch (error) {
            if (!(error instanceof ExecutionError)) {
              throw error;
            }
            failedCode = error.code;
          }
          if (failedCode !== null) {
            failures.push({
              code: failedCode,
              rootIdentityPreserved: rt.read(fr, 0, 0) === before,
            });
          }
        }
        const current = rt.read(fr, 0, 0);
        rt.emit(0, 0, rt.callCollection('array.size', INT, [current]));
        rt.emit(0, 1, rt.callCollection('array.get', INT, [current, 0]));
      },
    };
    const bound = await bind(module, {
      params: {},
      provider: provider(context(2)),
      sink,
      // The one-element initializer is 24 bytes; its two-element replacement
      // is 32 and must fail before it can replace the caller's Ring root.
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

  test('user-value history holds old collection headers', async () => {
    const sink = new Sink();
    const module: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        if (rt.needsInit(fr, 0)) {
          rt.initialize(
            fr,
            0,
            rt.newUser(HOLDER, [rt.callCollection('array.from', ARRAY, [0])]),
          );
        }
        const current = rt.read(fr, 0, 0);
        const values = rt.userField(current, HOLDER, 0);
        const mutation = rt.mutateCollection('array.push', ARRAY, values, [
          (rt.builtin(0, 0) as number) + 1,
        ]);
        const replacement = rt.rebuildUserPath(
          current,
          HOLDER,
          [0],
          mutation.replacement,
        );
        rt.write(fr, 0, replacement);
        rt.emit(
          0,
          0,
          rt.callCollection('array.size', INT, [mutation.replacement]),
        );
        if ((rt.builtin(0, 0) as number) > 0) {
          const prior = rt.userField(rt.read(fr, 0, 1), HOLDER, 0);
          rt.emit(0, 1, rt.callCollection('array.size', INT, [prior]));
        } else {
          rt.emit(0, 1, NaN);
        }
      },
    };
    const bound = await bind(module, {
      params: {},
      provider: provider(context(2)),
      sink,
    });
    await bound.runAll();
    expect(sink.values.map(entry => entry.values)).toEqual([
      [2, NaN],
      [3, 2],
    ]);
  });
});

describe('aggregate request ownership', () => {
  test('one aggregate survives a recursive request tree in the shared arena', async () => {
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
    const leaf: ModuleCode = {
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
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        rt.write(fr, 0, rt.callCollection('array.from', ARRAY, [41]));
      },
    };
    const middle: ModuleCode = {
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
      init() {},
      bind(rt) {
        rt.bindRequestOptions(0, false, false, false, 0);
        rt.bindRequest(0, 'LEAF', '');
      },
      funcs: {},
      main(rt, fr) {
        rt.write(fr, 0, rt.request(0, 0));
      },
    };
    const root: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
      init() {},
      bind(rt) {
        rt.bindRequestOptions(0, false, false, false, 0);
        rt.bindRequest(0, 'MID', '');
      },
      funcs: {},
      main(rt) {
        rt.emit(
          0,
          0,
          rt.callCollection('array.first', INT, [rt.request(0, 0)]),
        );
      },
    };
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: contexts,
      sink,
      // The leaf allocates the only Heap cell. At the fixed-value peak, the
      // leaf result view, middle result Ring, and middle builder each own one
      // shallow array slot (3 * 32 bytes).
      maxHeapStorageCells: 1,
      maxHeapLogicalBytes: 24,
      maxHeapTransientStorageCells: 1,
      maxHeapTransientLogicalBytes: 24,
      maxFixedValueLogicalBytes: 96,
    });

    await bound.runAll();
    expect(sink.values.map(entry => entry.values)).toEqual([[41]]);
    bound.dispose();
  });

  test('dynamic aggregate pair views retain cached roots with a keep-zero result Ring', async () => {
    const parentAxis: TimeAxis = {
      time: row => row * 60,
      closeTime: row => (row + 1) * 60,
    };
    const childAxis: TimeAxis = {
      time: () => 0,
      closeTime: () => 60,
    };
    const primary: ProviderContext = {
      rows: 3,
      axis: parentAxis,
      series: () => null,
      builtinValue: () => undefined,
    };
    const pair = (value: number): ProviderContext => ({
      rows: 1,
      axis: childAxis,
      series: id => (id === 'close' ? {length: 1, at: () => value} : null),
      builtinValue: () => undefined,
    });
    const contexts: DataProvider = {
      resolveContext: symbol => {
        if (symbol === '') {
          return Promise.resolve(primary);
        }
        if (symbol === 'X') {
          return Promise.resolve(pair(11));
        }
        if (symbol === 'Y') {
          return Promise.resolve(pair(22));
        }
        return Promise.resolve({
          error: 'unknownSymbol' as const,
          detail: `no context '${symbol}'`,
        });
      },
    };
    const child: ModuleCode = {
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
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: ARRAY},
            ],
            subs: [],
          },
        ],
      },
      requests: [],
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        rt.write(
          fr,
          0,
          rt.callCollection('array.from', ARRAY, [rt.series(0, 0)]),
        );
      },
    };
    const root: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
            dynamic: true,
          },
        ],
        frames: [{locals: [], subs: []}],
      },
      requests: [child],
      init() {},
      bind(rt) {
        rt.bindRequestOptions(0, false, false, false, 0);
      },
      funcs: {},
      main(rt) {
        const symbol = rt.builtin(0, 0) === 1 ? 'Y' : 'X';
        const result = rt.requestFor(0, symbol, '');
        rt.emit(0, 0, rt.callCollection('array.first', INT, [result]));
      },
    };
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: contexts,
      sink,
      // X and Y own exactly one 24-byte backing cell each. Resolving Y peaks
      // at four shallow array slots: root result Ring, cached X view, child
      // Ring, and Y's registered result builder.
      maxHeapStorageCells: 2,
      maxHeapLogicalBytes: 48,
      maxHeapTransientStorageCells: 1,
      maxHeapTransientLogicalBytes: 24,
      maxFixedValueLogicalBytes: 128,
    });

    await bound.runAll();
    expect(sink.values.map(entry => entry.values)).toEqual([[11], [22], [11]]);
    bound.dispose();
  });

  test('tentative aggregate writes vanish across dynamic suspension retries', async () => {
    const axis: TimeAxis = {
      time: row => row * 60,
      closeTime: row => (row + 1) * 60,
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
      series: id => (id === 'close' ? {length: 1, at: () => 1} : null),
      builtinValue: () => undefined,
    };
    const contexts: DataProvider = {
      resolveContext: symbol =>
        Promise.resolve(symbol === '' ? primary : childContext),
    };
    const child: ModuleCode = {
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
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        rt.write(fr, 0, rt.series(0, 0));
      },
    };
    let requestedSymbol = 'Y';
    let marker = 11;
    const root: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
      manifest: {
        series: [],
        builtin: [],
        params: [],
        outputs: [
          {
            ...OUTPUT,
            channels: [
              {name: 'size', type: 'int', transport: {kind: 'int'}},
              {name: 'last', type: 'int', transport: {kind: 'int'}},
            ],
          },
        ],
        effects: [],
        requests: [
          {
            merge: {
              mode: 'sample',
            },
            depth: {kind: 'none'},
            resultSlot: 0,
            layout: INT,
            dynamic: true,
          },
        ],
        frames: [
          {
            locals: [
              {storage: Storage.Varip, depth: {kind: 'none'}, layout: ARRAY},
            ],
            subs: [],
          },
        ],
      },
      requests: [child],
      init() {},
      bind(rt) {
        rt.bindRequestOptions(0, false, false, false, 0);
      },
      funcs: {},
      main(rt, fr) {
        if (rt.needsInit(fr, 0)) {
          rt.initialize(fr, 0, rt.callCollection('array.from', ARRAY, [0]));
        }
        const mutation = rt.mutateCollection(
          'array.push',
          ARRAY,
          rt.read(fr, 0, 0),
          [marker],
        );
        rt.write(fr, 0, mutation.replacement);
        // The replacement above is tentative when this first encounters a
        // pair. Suspension must abort that storage and restore the exact
        // pre-attempt varip header before retrying the whole row.
        rt.requestFor(0, requestedSymbol, '');
        rt.emit(
          0,
          0,
          rt.callCollection('array.size', INT, [mutation.replacement]),
        );
        rt.emit(
          0,
          1,
          rt.callCollection('array.last', INT, [mutation.replacement]),
        );
      },
    };
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: contexts,
      sink,
    });

    expect(() => bound.executeRow(0, true)).toThrow('unresolved request');
    await bound.resolvePending();
    bound.executeRow(0, true);

    // A second unresolved pair starts from the completed first tick's
    // candidate. Its failed append must disappear, while that pre-attempt
    // candidate survives for the retry.
    requestedSymbol = 'X';
    marker = 22;
    expect(() => bound.executeRow(0, true)).toThrow('unresolved request');
    await bound.resolvePending();
    bound.executeRow(0, true);

    marker = 33;
    bound.executeRow(0, false);
    bound.commitRow(0);
    expect(sink.values.map(entry => entry.values)).toEqual([
      [2, 11],
      [3, 22],
      [4, 33],
    ]);
    expect(sink.values.map(entry => entry.provisional)).toEqual([
      true,
      true,
      false,
    ]);
    bound.dispose();
  });

  test('keep-zero result leases transfer to views and child Rings release', async () => {
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
    const child: ModuleCode = {
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
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: ARRAY},
            ],
            subs: [],
          },
        ],
      },
      requests: [],
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        rt.write(
          fr,
          0,
          rt.callCollection('array.from', ARRAY, [rt.series(0, 0)]),
        );
      },
    };
    const root: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
            layout: ARRAY,
            dynamic: false,
          },
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
      },
      requests: [child, child],
      init() {},
      bind(rt) {
        rt.bindRequestOptions(0, false, false, false, 0);
        rt.bindRequestOptions(1, false, false, false, 0);
        rt.bindRequest(0, 'X', '');
        rt.bindRequest(1, 'X', '');
      },
      funcs: {},
      main(rt) {
        rt.emit(0, 0, rt.callCollection('array.size', INT, [rt.request(0, 0)]));
        rt.emit(0, 1, rt.callCollection('array.size', INT, [rt.request(1, 0)]));
      },
    };
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: contexts,
      sink,
      // Peak: first view 64 + second child Ring 32 + result column 64.
      maxFixedValueLogicalBytes: 160,
    });
    await bound.runAll();
    expect(sink.values.map(entry => entry.values)).toEqual([
      [1, 1],
      [1, 1],
    ]);
    bound.dispose();
  });

  test('a post-child merge failure releases the builder, child, and fixed lease', async () => {
    const stableAxis: TimeAxis = {
      time: () => 0,
      closeTime: () => 60,
    };
    const primary: ProviderContext = {
      rows: 1,
      axis: stableAxis,
      series: () => null,
      builtinValue: () => undefined,
    };
    let childResolutions = 0;
    const contexts: DataProvider = {
      resolveContext: symbol => {
        if (symbol !== 'X') {
          return Promise.resolve(primary);
        }
        childResolutions += 1;
        let closeReads = 0;
        const axis: TimeAxis =
          childResolutions === 1
            ? {
                time: () => 0,
                closeTime: () => {
                  closeReads += 1;
                  if (closeReads > 1) {
                    throw new Error('post-child axis failure');
                  }
                  return 60;
                },
              }
            : stableAxis;
        return Promise.resolve({
          rows: 1,
          axis,
          series: () => null,
          builtinValue: () => undefined,
        });
      },
    };
    const child: ModuleCode = {
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
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        rt.write(fr, 0, rt.callCollection('array.from', ARRAY, [7]));
      },
    };
    const root: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
            dynamic: true,
          },
        ],
        frames: [{locals: [], subs: []}],
      },
      requests: [child],
      init() {},
      bind(rt) {
        rt.bindRequestOptions(0, false, false, false, 0);
      },
      funcs: {},
      main(rt) {
        rt.emit(
          0,
          0,
          rt.callCollection('array.size', INT, [rt.requestFor(0, 'X', '')]),
        );
      },
    };
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: contexts,
      sink,
      // Root request Ring 32 + one child Ring 32 + one result column 32.
      maxFixedValueLogicalBytes: 96,
    });

    expect(() => bound.executeRow(0, false)).toThrow('unresolved request');
    await expect(bound.resolvePending()).rejects.toThrow(
      'post-child axis failure',
    );
    expect(() => bound.executeRow(0, false)).toThrow('unresolved request');
    await bound.resolvePending();
    bound.executeRow(0, false);
    bound.commitRow(0);
    expect(sink.values[0].values).toEqual([1]);
    bound.dispose();
  });

  test('completed children stop retaining unrelated frame storage', async () => {
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
    const child: ModuleCode = {
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
              {storage: Storage.PerBar, depth: {kind: 'none'}, layout: ARRAY},
              {storage: Storage.Var, depth: {kind: 'none'}, layout: ARRAY},
            ],
            subs: [],
          },
        ],
      },
      requests: [],
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        if (rt.needsInit(fr, 1)) {
          rt.initialize(fr, 1, rt.callCollection('array.from', ARRAY, [99]));
        }
        rt.write(
          fr,
          0,
          rt.callCollection('array.from', ARRAY, [rt.series(0, 0)]),
        );
        const mutation = rt.mutateCollection(
          'array.push',
          ARRAY,
          rt.read(fr, 1, 0),
          [rt.series(0, 0)],
        );
        rt.write(fr, 1, mutation.replacement);
      },
    };
    const root: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
      init() {},
      bind(rt) {
        rt.bindRequestOptions(0, false, false, false, 0);
        rt.bindRequest(0, 'X', '');
      },
      funcs: {},
      main(rt, fr) {
        rt.write(fr, 0, rt.callCollection('array.from', ARRAY, [7]));
        rt.emit(0, 0, rt.callCollection('array.size', INT, [rt.request(0, 0)]));
      },
    };
    const sink = new Sink();
    const bound = await bind(root, {
      params: {},
      provider: contexts,
      sink,
      maxHeapStorageCells: 2,
    });

    await bound.runAll();
    expect(sink.values[0].values).toEqual([1]);
    bound.dispose();
  });
});

describe('runtime boundaries', () => {
  test('bind-time aggregate storage is abort-only and cannot remain retained', async () => {
    let escaped: Value | undefined;
    let rejection = '';
    const module: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
              {storage: Storage.Var, depth: {kind: 'none'}, layout: ARRAY},
            ],
            subs: [],
          },
        ],
      },
      requests: [],
      init() {},
      bind(rt, fr) {
        escaped = rt.callCollection('array.from', ARRAY, [7]);
        rt.write(fr, 0, escaped);
      },
      funcs: {},
      main(rt, fr) {
        if (escaped === undefined) {
          throw new Error('bind did not execute');
        }
        try {
          rt.callCollection('array.first', INT, [escaped]);
        } catch (error) {
          if (!(error instanceof InternalError)) {
            throw error;
          }
          rejection = error.message;
        }
        const live = rt.callCollection('array.from', ARRAY, [8]);
        rt.write(fr, 0, live);
        rt.emit(0, 0, rt.callCollection('array.first', INT, [live]));
      },
    };
    const sink = new Sink();
    const bound = await bind(module, {
      params: {},
      provider: provider(context(1)),
      sink,
      // Both bind and execution may allocate one cell in their own attempt;
      // only execution's cell may remain retained afterward.
      maxHeapStorageCells: 1,
      maxHeapLogicalBytes: 24,
      maxHeapTransientStorageCells: 1,
      maxHeapTransientLogicalBytes: 24,
      maxFixedValueLogicalBytes: 64,
    });

    await bound.runAll();
    expect(rejection).toContain('stale StorageRef');
    expect(sink.values.map(entry => entry.values)).toEqual([[8]]);
    bound.dispose();
  });

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

  test('fixed Ring cells reserve exact shallow-layout bytes before allocation', async () => {
    const exact = await bind(arrayStateModule(), {
      params: {},
      provider: provider(),
      sink: new Sink(),
      // Provisional bind Rings release before these two final var Rings.
      maxFixedValueLogicalBytes: 128,
    });
    exact.dispose();

    await expect(
      bind(arrayStateModule(), {
        params: {},
        provider: provider(),
        sink: new Sink(),
        // Two array var Rings each reserve scratch + one committed cell:
        // 2 * 2 * shallowBytes(array=32) = 128.
        maxFixedValueLogicalBytes: 127,
      }),
    ).rejects.toThrow('FIXED_VALUE_STORAGE_LIMIT_EXCEEDED');
  });

  test('a partially allocated lazy frame rolls its Ring leases back', async () => {
    let requestLargeFrame = true;
    const module: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
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
      init() {},
      bind() {},
      funcs: {},
      main(rt, fr) {
        rt.frame(fr, requestLargeFrame ? 0 : 1);
      },
    };
    const bound = await bind(module, {
      params: {},
      provider: provider(),
      sink: new Sink(),
      // One array scratch Ring fits (32); two do not.
      maxFixedValueLogicalBytes: 48,
    });

    expect(() => bound.executeRow(0, false)).toThrow(
      'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED',
    );
    requestLargeFrame = false;
    bound.executeRow(0, false);
    bound.commitRow(0);
    bound.dispose();
  });

  test('a non-current ABI is rejected before init or bind code runs', async () => {
    let initialized = false;
    const old = {
      ...arrayStateModule(),
      abi: 2,
      init() {
        initialized = true;
      },
    } as unknown as TeaModule;
    await expect(
      bind(old, {params: {}, provider: provider(), sink: new Sink()}),
    ).rejects.toThrow('unsupported module ABI 2; expected 1');
    expect(initialized).toBe(false);
  });

  test('dispose aborts a prepared row and is idempotent', async () => {
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
