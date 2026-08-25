// Purpose: Core behavioral parity coverage for the state-owning step runtime:
// call-site frames, typed history, provisional/final state, and aggregate
// reference/value semantics.

import {Effect} from 'effect';
import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {
  RUNTIME_ABI_VERSION,
  type AggregateLayoutManifest,
  type Frame,
  type Runtime,
  type TeaModule,
  type Value,
} from './abi';
import {JSRuntime, type StepInput, type StepResult} from './js-runtime';
import {ValueLayoutRegistry} from './value-layout';

const NUMBER = 0;
const BOOLEAN = 1;
const STRING = 2;
const ARRAY = 3;
const HOLDER = 4;
const LAYOUTS = {
  layouts: [
    {kind: 'number', numeric: 'int'},
    {kind: 'boolean'},
    {kind: 'nullable-scalar', scalar: 'string'},
    {kind: 'array', element: NUMBER},
    {
      kind: 'struct',
      name: 'Holder',
      fields: [{name: 'values', layout: ARRAY}],
    },
  ],
} as const satisfies AggregateLayoutManifest;

function runtime(module: TeaModule): JSRuntime {
  return new JSRuntime(module, [], new ValueLayoutRegistry(LAYOUTS));
}

function input({
  series = [],
  builtins = [],
  provisional = false,
}: {
  readonly series?: readonly Value[];
  readonly builtins?: readonly Value[];
  readonly provisional?: boolean;
} = {}): StepInput {
  return {series, builtins, requests: [], provisional};
}

function run(target: JSRuntime, next: StepInput): StepResult {
  return Effect.runSync(target.step(next));
}

function channels(result: StepResult): readonly Value[] {
  return result.output[0]?.channels ?? [];
}

function counter(rt: Runtime, frame: Frame): Value {
  if (rt.needsInit(frame, 0)) rt.initialize(frame, 0, 0);
  rt.write(frame, 0, Number(rt.read(frame, 0, 0)) + 1);
  return rt.read(frame, 0, 0);
}

const COUNTER_MODULE: TeaModule = {
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
        locals: [{storage: Storage.Var, depth: {kind: 'none'}, layout: NUMBER}],
        subs: [],
      },
    ],
  },
  requests: [],
  init() {},
  bind() {},
  funcs: {1: counter},
  main(rt, root) {
    rt.emit(0, 0, counter(rt, rt.frame(root, 0)));
    rt.emit(0, 1, counter(rt, rt.frame(root, 1)));
  },
};

const TYPED_HISTORY_MODULE: TeaModule = {
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
        channels: [
          {name: 'number', type: 'int', transport: {kind: 'int'}},
          {name: 'boolean', type: 'bool', transport: {kind: 'bool'}},
          {name: 'string', type: 'string', transport: {kind: 'string'}},
        ],
      },
    ],
    effects: [],
    requests: [],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            layout: NUMBER,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            layout: BOOLEAN,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            layout: STRING,
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
    rt.write(root, 0, 7);
    rt.write(root, 1, true);
    rt.write(root, 2, 'present');
    rt.emit(0, 0, rt.read(root, 0, 2));
    rt.emit(0, 1, rt.read(root, 1, 2));
    rt.emit(0, 2, rt.read(root, 2, 2));
  },
};

const TICK_MODULE: TeaModule = {
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
          {name: 'var', type: 'int', transport: {kind: 'int'}},
          {name: 'varip', type: 'int', transport: {kind: 'int'}},
          {name: 'per-bar', type: 'int', transport: {kind: 'int'}},
        ],
      },
    ],
    effects: [],
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
  },
};

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
          effect: 'probe',
          staticArgs: [],
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
    main(rt, root) {
      if (rt.needsInit(root, 0)) {
        rt.initialize(root, 0, rt.callCollection('array.from', ARRAY, [0]));
      }
      if (rt.needsInit(root, 1)) {
        rt.initialize(root, 1, rt.callCollection('array.from', ARRAY, [0]));
      }
      for (let slot = 0; slot < 2; slot += 1) {
        const mutation = rt.mutateCollection(
          'array.push',
          ARRAY,
          rt.read(root, slot, 0),
          [rt.series(0, 0)],
        );
        rt.write(root, slot, mutation.replacement);
        rt.emit(
          0,
          slot,
          rt.callCollection('array.size', NUMBER, [mutation.replacement]),
        );
      }
    },
  };
}

describe('JSRuntime core parity', () => {
  test('written call sites own independent persistent state', () => {
    const target = runtime(COUNTER_MODULE);
    expect(channels(run(target, input()))).toEqual([1, 1]);
    expect(channels(run(target, input()))).toEqual([2, 2]);
    expect(channels(run(target, input()))).toEqual([3, 3]);
    target.dispose();
  });

  test('a failed first subframe activation disappears before retry', () => {
    let fail = true;
    const module: TeaModule = {
      ...COUNTER_MODULE,
      main(rt, root) {
        if (fail) {
          counter(rt, rt.frame(root, 0));
          throw new Error('after first call');
        }
        rt.emit(0, 0, counter(rt, rt.frame(root, 0)));
      },
    };
    const target = runtime(module);
    expect(() => run(target, input())).toThrow('after first call');
    fail = false;
    expect(channels(run(target, input()))[0]).toBe(1);
    target.dispose();
  });

  test('early local history returns each layout typed empty', () => {
    const target = runtime(TYPED_HISTORY_MODULE);
    const values = channels(run(target, input()));
    expect(Number.isNaN(values[0] as number)).toBe(true);
    expect(values.slice(1)).toEqual([false, null]);
    target.dispose();
  });

  test('ticked then-final execution matches a clean final for var and per-bar', () => {
    const ticked = runtime(TICK_MODULE);
    run(ticked, input({series: [10], provisional: true}));
    const tickedFinals = [
      channels(run(ticked, input({series: [12]}))),
      channels(run(ticked, input({series: [5]}))),
    ];

    const clean = runtime(TICK_MODULE);
    const cleanFinals = [
      channels(run(clean, input({series: [12]}))),
      channels(run(clean, input({series: [5]}))),
    ];

    expect(tickedFinals.map(value => [value[0], value[2]])).toEqual(
      cleanFinals.map(value => [value[0], value[2]]),
    );
    ticked.dispose();
    clean.dispose();
  });

  test('provisional subframe activation survives a final same-row skip', () => {
    let invoke = true;
    const module: TeaModule = {
      ...COUNTER_MODULE,
      manifest: {
        ...COUNTER_MODULE.manifest,
        outputs: [
          {
            effect: 'probe',
            staticArgs: [],
            channels: [{name: 'value', type: 'int', transport: {kind: 'int'}}],
          },
        ],
        frames: [
          {locals: [], subs: [{fid: 1}]},
          {
            locals: [
              {storage: Storage.Varip, depth: {kind: 'none'}, layout: NUMBER},
            ],
            subs: [],
          },
        ],
      },
      main(rt, root) {
        if (invoke) rt.emit(0, 0, counter(rt, rt.frame(root, 0)));
      },
    };
    const target = runtime(module);
    expect(channels(run(target, input({provisional: true})))).toEqual([1]);
    invoke = false;
    expect(run(target, input()).output).toEqual([]);
    invoke = true;
    expect(channels(run(target, input()))).toEqual([2]);
    target.dispose();
  });

  test('an active skipped subframe advances local history with typed empty', () => {
    let invoke = true;
    const module: TeaModule = {
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
              {name: 'previous', type: 'int', transport: {kind: 'int'}},
            ],
          },
        ],
        effects: [],
        requests: [],
        frames: [
          {locals: [], subs: [{fid: 1}]},
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
        if (!invoke) {
          rt.emit(0, 0, NaN);
          return;
        }
        const child = rt.frame(root, 0);
        rt.write(child, 0, rt.series(0, 0));
        rt.emit(0, 0, rt.read(child, 0, 1));
      },
    };
    const target = runtime(module);
    expect(
      Number.isNaN(channels(run(target, input({series: [10]})))[0] as number),
    ).toBe(true);
    invoke = false;
    expect(
      Number.isNaN(channels(run(target, input({series: [20]})))[0] as number),
    ).toBe(true);
    invoke = true;
    expect(
      Number.isNaN(channels(run(target, input({series: [30]})))[0] as number),
    ).toBe(true);
    expect(channels(run(target, input({series: [40]})))[0]).toBe(30);
    target.dispose();
  });

  test('struct history keeps a live reference rather than a body snapshot', () => {
    const module: TeaModule = {
      abi: RUNTIME_ABI_VERSION,
      aggregateLayouts: LAYOUTS,
      manifest: {
        series: [],
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
      main(rt, root) {
        if (rt.needsInit(root, 0)) {
          rt.initialize(
            root,
            0,
            rt.newStruct(HOLDER, [rt.callCollection('array.from', ARRAY, [0])]),
          );
        }
        const holder = rt.read(root, 0, 0);
        const current = rt.mutateCollection(
          'array.push',
          ARRAY,
          rt.structField(holder, HOLDER, 0),
          [Number(rt.builtin(0, 0)) + 1],
        ).replacement;
        rt.storeStructField(holder, HOLDER, 0, current);
        rt.emit(0, 0, rt.callCollection('array.size', NUMBER, [current]));
        if (Number(rt.builtin(0, 0)) === 0) {
          rt.emit(0, 1, NaN);
        } else {
          const prior = rt.structField(rt.read(root, 0, 1), HOLDER, 0);
          rt.emit(0, 1, rt.callCollection('array.size', NUMBER, [prior]));
        }
      },
    };
    const target = runtime(module);
    expect(channels(run(target, input({builtins: [0]})))).toEqual([2, NaN]);
    expect(channels(run(target, input({builtins: [1]})))).toEqual([3, 3]);
    target.dispose();
  });

  test('provisional var rolls back while varip retains collection replacement', () => {
    const target = runtime(arrayStateModule());
    expect(
      channels(run(target, input({series: [1], provisional: true}))),
    ).toEqual([2, 2]);
    expect(channels(run(target, input({series: [1]})))).toEqual([2, 3]);
    expect(channels(run(target, input({series: [2]})))).toEqual([3, 4]);
    target.dispose();
  });
});
