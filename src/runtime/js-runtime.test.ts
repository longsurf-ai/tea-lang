// Purpose: Ownership, provisional/final, rollback, and GC-safe-point coverage
// for the state-owning JavaScript runtime.

import {Effect} from 'effect';
import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {JSRuntime, type StepInput, type StepResult} from './js-runtime';
import {configureModule} from './module-binding';
import {RUNTIME_ABI_VERSION, type JSModule} from './module-abi';
import {staticModuleBinding, testModule} from './testing';
import type {ValueLayout} from './value-layout';

const NUMBER = 0;
const ARRAY = 1;
const COUNTER = 2;
const ENVELOPE = 3;
const LAYOUTS = [
  {kind: 'number', numeric: 'int'},
  {kind: 'array', element: NUMBER},
  {
    kind: 'struct',
    name: 'Counter',
    typeId: 'test.Counter',
    fields: [{name: 'value', layout: NUMBER}],
  },
  {
    kind: 'struct',
    name: 'Envelope',
    typeId: 'test.Envelope',
    fields: [{name: 'counter', layout: COUNTER}],
  },
] as const satisfies readonly ValueLayout[];

function input(value: number, provisional: boolean): StepInput {
  return {series: [value], builtins: [], requests: [], provisional};
}

const PROVISIONAL_MODULE: JSModule = testModule({
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
          {storage: Storage.Var, depth: {kind: 'none'}, layout: NUMBER},
          {storage: Storage.Varip, depth: {kind: 'none'}, layout: NUMBER},
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
    ctx.write(root, 0, Number(ctx.read(root, 0, 0)) + ctx.series(0, 0));
    ctx.write(root, 1, Number(ctx.read(root, 1, 0)) + 1);
    ctx.emit(0, 0, ctx.read(root, 0, 0));
    ctx.emit(0, 1, ctx.read(root, 1, 0));
  },
});

function structModule(shouldFail: () => boolean): JSModule {
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
      if (shouldFail()) throw new Error('step failed');
      ctx.emit(0, 0, value);
    },
  });
}

function structEffectModule(shouldFail: () => boolean): JSModule {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
    layout: LAYOUTS,
    manifest: {
      series: [],
      builtin: [],
      params: [],
      outputs: [],
      effects: [
        {
          layout: ENVELOPE,
          declaration: {
            payload: {
              kind: 'struct',
              typeId: 'test.Envelope',
              displayName: 'Envelope',
              fields: [
                {
                  name: 'counter',
                  value: {
                    kind: 'struct',
                    typeId: 'test.Counter',
                    displayName: 'Counter',
                    fields: [{name: 'value', value: {kind: 'int'}}],
                  },
                },
              ],
            },
          },
        },
      ],
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
      const next = Number(ctx.structField(counter, COUNTER, 0)) + 1;
      ctx.storeStructField(counter, COUNTER, 0, next);
      const envelope = ctx.newStruct(ENVELOPE, [counter]);
      ctx.emitEffect(0, envelope);
      ctx.storeStructField(counter, COUNTER, 0, next + 100);
      if (shouldFail()) throw new Error('effect step failed');
    },
  });
}

const WRONG_NOMINAL_MODULE: JSModule = testModule({
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
          {storage: Storage.Var, depth: {kind: 'none'}, layout: ENVELOPE},
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
  },
});

const GC_MODULE: JSModule = testModule({
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
        channels: [{name: 'old-size', type: 'int', transport: {kind: 'int'}}],
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
            layout: ARRAY,
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
    const close = ctx.series(0, 0);
    ctx.write(root, 0, ctx.callCollection('array.from', ARRAY, [close]));
    ctx.emit(
      0,
      0,
      close < 3
        ? 0
        : ctx.callCollection('array.size', NUMBER, [ctx.read(root, 0, 2)]),
    );
  },
});

function channels(result: StepResult) {
  return result.output[0]?.channels;
}

describe('JSRuntime', () => {
  test('owns State and Intermediate across provisional and final steps', () => {
    const runtime = new JSRuntime(configureModule(PROVISIONAL_MODULE, []));

    expect(channels(Effect.runSync(runtime.step(input(10, true))))).toEqual([
      10, 1,
    ]);
    expect(channels(Effect.runSync(runtime.step(input(11, true))))).toEqual([
      11, 2,
    ]);
    expect(channels(Effect.runSync(runtime.step(input(12, false))))).toEqual([
      12, 3,
    ]);
    expect(channels(Effect.runSync(runtime.step(input(5, false))))).toEqual([
      17, 4,
    ]);

    runtime.dispose();
    expect(() => Effect.runSync(runtime.step(input(1, false)))).toThrow(
      'state-machine runtime is disposed',
    );
  });

  test('does not advance owned state or Heap writes after a failed step', () => {
    let fail = false;
    const runtime = new JSRuntime(
      configureModule(
        structModule(() => fail),
        [],
      ),
    );

    expect(channels(Effect.runSync(runtime.step(input(0, false))))).toEqual([
      1,
    ]);
    fail = true;
    expect(() => Effect.runSync(runtime.step(input(0, false)))).toThrow(
      'step failed',
    );
    fail = false;
    expect(channels(Effect.runSync(runtime.step(input(0, false))))).toEqual([
      2,
    ]);
    runtime.dispose();
  });

  test('snapshots nested struct effects at emit time and drops failed emissions', () => {
    let fail = true;
    const runtime = new JSRuntime(
      configureModule(
        structEffectModule(() => fail),
        [],
      ),
    );

    expect(() =>
      Effect.runSync(
        runtime.step({
          series: [],
          builtins: [],
          requests: [],
          provisional: false,
        }),
      ),
    ).toThrow('effect step failed');

    fail = false;
    const result = Effect.runSync(
      runtime.step({
        series: [],
        builtins: [],
        requests: [],
        provisional: false,
      }),
    );
    expect(result.effects).toEqual([
      {
        effectId: 0,
        payload: {
          kind: 'struct',
          fields: [{kind: 'struct', fields: [1]}],
        },
      },
    ]);
    runtime.dispose();
  });

  test('rejects nominally wrong struct values at State initialization', () => {
    const runtime = new JSRuntime(configureModule(WRONG_NOMINAL_MODULE, []));
    expect(() =>
      Effect.runSync(
        runtime.step({
          series: [],
          builtins: [],
          requests: [],
          provisional: false,
        }),
      ),
    ).toThrow("references 'Counter', expected 'Envelope'");
    runtime.dispose();
  });

  test('accepts provider NaN but fails closed when a read sees infinity', () => {
    const runtime = new JSRuntime(configureModule(PROVISIONAL_MODULE, []));
    const na = Effect.runSync(runtime.step(input(NaN, false)));
    expect(Number.isNaN(na.output[0]?.channels[0] as number)).toBe(true);
    expect(() => Effect.runSync(runtime.step(input(Infinity, false)))).toThrow(
      'provider series 0 returned a non-finite value',
    );
    runtime.dispose();
  });

  test('collects from retained owner state rather than a provisional candidate', () => {
    const runtime = new JSRuntime(configureModule(GC_MODULE, []));

    Effect.runSync(runtime.step(input(1, false)));
    Effect.runSync(runtime.step(input(2, false)));
    expect(channels(Effect.runSync(runtime.step(input(3, true))))).toEqual([1]);
    expect(channels(Effect.runSync(runtime.step(input(4, true))))).toEqual([1]);
    runtime.dispose();
  });
});
