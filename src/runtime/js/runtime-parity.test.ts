// Purpose: Core behavioral parity coverage for the state-owning step runtime:
// call-site frames, typed history, provisional/final state, and collection
// reference/value semantics.

import {Effect} from 'effect';
import {describe, expect, test} from 'vitest';
import {Storage} from '../../ir/node';
import {type Value} from '../abi';
import {JSRuntime, type StepInput, type StepResult} from './runtime';
import {configureModule} from '../module-binding';
import {
  RUNTIME_ABI_VERSION,
  type Frame,
  type JSModule,
  type RuntimeContext,
} from '../module-abi';
import {testModule, scalar} from '../testing';
import type {ValueLayout} from '../value-layout';

const NUMBER = 0;
const BOOLEAN = 1;
const STRING = 2;
const ARRAY = 3;
const HOLDER = 4;
const LAYOUTS = [
  {kind: 'number', numeric: 'int'},
  {kind: 'boolean'},
  {kind: 'nullable-scalar', scalar: 'string'},
  {kind: 'array', element: NUMBER},
  {
    kind: 'struct',
    name: 'Holder',
    fields: [{name: 'values', layout: ARRAY}],
  },
] as const satisfies readonly ValueLayout[];

function runtime(module: JSModule): JSRuntime {
  return new JSRuntime(configureModule(module, []));
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

function run(target: JSRuntime, input: StepInput): StepResult {
  return Effect.runSync(target.step(input));
}

function channels(result: StepResult): readonly unknown[] {
  return result.outputs[0]?.channels ?? [];
}

function counter(ctx: RuntimeContext, frame: Frame): Value {
  if (ctx.needsInit(frame, 0)) ctx.initialize(frame, 0, 0);
  ctx.write(frame, 0, Number(ctx.read(frame, 0, 0)) + 1);
  return ctx.read(frame, 0, 0);
}

const COUNTER_MODULE: JSModule = testModule({
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
        channels: [scalar('a', 'int'), scalar('b', 'int')],
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
  funcs: {1: counter},
  main(ctx, root) {
    ctx.emit(0, 0, counter(ctx, ctx.frame(root, 0)));
    ctx.emit(0, 1, counter(ctx, ctx.frame(root, 1)));
  },
});

const TYPED_HISTORY_MODULE: JSModule = testModule({
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
        channels: [
          scalar('number', 'int'),
          scalar('boolean', 'bool'),
          scalar('string', 'string'),
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
  funcs: {},
  main(ctx, root) {
    ctx.write(root, 0, 7);
    ctx.write(root, 1, true);
    ctx.write(root, 2, 'present');
    ctx.emit(0, 0, ctx.read(root, 0, 2));
    ctx.emit(0, 1, ctx.read(root, 1, 2));
    ctx.emit(0, 2, ctx.read(root, 2, 2));
  },
});

const TICK_MODULE: JSModule = testModule({
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
          scalar('var', 'int'),
          scalar('varip', 'int'),
          scalar('per-bar', 'int'),
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
  },
});

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
          effect: 'probe',
          staticArgs: [],
          channels: [scalar('var', 'int'), scalar('varip', 'int')],
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
    funcs: {},
    main(ctx, root) {
      if (ctx.needsInit(root, 0)) {
        ctx.initialize(root, 0, ctx.callCollection('array.from', ARRAY, [0]));
      }
      if (ctx.needsInit(root, 1)) {
        ctx.initialize(root, 1, ctx.callCollection('array.from', ARRAY, [0]));
      }
      for (let slot = 0; slot < 2; slot += 1) {
        const mutation = ctx.mutateCollection(
          'array.push',
          ARRAY,
          ctx.read(root, slot, 0),
          [ctx.series(0, 0)],
        );
        ctx.write(root, slot, mutation.replacement);
        ctx.emit(
          0,
          slot,
          ctx.callCollection('array.size', NUMBER, [mutation.replacement]),
        );
      }
    },
  });
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
    const module: JSModule = testModule({
      ...COUNTER_MODULE,
      main(ctx, root) {
        if (fail) {
          counter(ctx, ctx.frame(root, 0));
          throw new Error('after first call');
        }
        ctx.emit(0, 0, counter(ctx, ctx.frame(root, 0)));
      },
    });
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
    const module: JSModule = testModule({
      ...COUNTER_MODULE,
      manifest: {
        ...COUNTER_MODULE.manifest,
        outputs: [
          {
            effect: 'probe',
            staticArgs: [],
            channels: [scalar('value', 'int')],
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
      main(ctx, root) {
        if (invoke) ctx.emit(0, 0, counter(ctx, ctx.frame(root, 0)));
      },
    });
    const target = runtime(module);
    expect(channels(run(target, input({provisional: true})))).toEqual([1]);
    invoke = false;
    expect(run(target, input()).outputs).toEqual([]);
    invoke = true;
    expect(channels(run(target, input()))).toEqual([2]);
    target.dispose();
  });

  test('an active skipped subframe advances local history with typed empty', () => {
    let invoke = true;
    const module: JSModule = testModule({
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
            channels: [scalar('previous', 'int')],
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
      funcs: {},
      main(ctx, root) {
        if (!invoke) {
          ctx.emit(0, 0, NaN);
          return;
        }
        const child = ctx.frame(root, 0);
        ctx.write(child, 0, ctx.series(0, 0));
        ctx.emit(0, 0, ctx.read(child, 0, 1));
      },
    });
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
    const module: JSModule = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: LAYOUTS,
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
            channels: [scalar('current', 'int'), scalar('prior', 'int')],
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
      funcs: {},
      main(ctx, root) {
        if (ctx.needsInit(root, 0)) {
          ctx.initialize(
            root,
            0,
            ctx.newStruct(HOLDER, [
              ctx.callCollection('array.from', ARRAY, [0]),
            ]),
          );
        }
        const holder = ctx.read(root, 0, 0);
        const current = ctx.mutateCollection(
          'array.push',
          ARRAY,
          ctx.structField(holder, HOLDER, 0),
          [Number(ctx.builtin(0, 0)) + 1],
        ).replacement;
        ctx.storeStructField(holder, HOLDER, 0, current);
        ctx.emit(0, 0, ctx.callCollection('array.size', NUMBER, [current]));
        if (Number(ctx.builtin(0, 0)) === 0) {
          ctx.emit(0, 1, NaN);
        } else {
          const prior = ctx.structField(ctx.read(root, 0, 1), HOLDER, 0);
          ctx.emit(0, 1, ctx.callCollection('array.size', NUMBER, [prior]));
        }
      },
    });
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
