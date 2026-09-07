import type {Module} from '../module-binding';
// Purpose: Core behavioral parity coverage for the state-owning step runtime:
// call-site frames, typed history, provisional/final state, and collection
// reference/value semantics.

import {describe, expect, test} from 'vitest';
import {Storage} from '../../ir/node';
import type {Stored} from '../value';
import {Context, type StepInput, type StepResult} from './context';

import {RUNTIME_ABI_VERSION} from '../module-abi';
import {testModule, scalar, output} from '../testing';
import {outputSchema} from '../output';
import type {Step, FrameState} from './state-update';
import {array, bool, int, struct, text, unwrap, Value} from './value';

// Step exposes raw payloads; fixture empties validate their domains at that boundary.
const NUMBER: Value<unknown> = int(NaN);
const BOOLEAN: Value<unknown> = bool(false);
const STRING: Value<unknown> = text(null);
const ARRAY: Value<unknown> = array(NUMBER).empty();
class Holder {
  values = ARRAY;
  constructor(fields?: {values: typeof ARRAY}) {
    Object.assign(this, fields);
  }
}
const HOLDER: Value<unknown> = struct(Holder, 'Holder', 48).empty();

function runtime(module: Module): Context {
  return new Context(module.clone().bind());
}

function input({
  series = [],
  builtins = [],
  provisional = false,
}: {
  readonly series?: readonly Stored[];
  readonly builtins?: readonly Stored[];
  readonly provisional?: boolean;
} = {}): StepInput {
  return {series, builtins, requests: [], provisional};
}

function run(target: Context, input: StepInput): StepResult {
  return target.step(input);
}

function channels(result: StepResult): readonly unknown[] {
  return result.outputs;
}

function counter(ctx: Step, frame: FrameState): Value<unknown> {
  if (ctx.needsInit(frame, 0)) ctx.initialize(frame, 0, int(0));
  ctx.write(frame, 0, int(Number(ctx.read(frame, 0, 0)) + 1));
  return NUMBER.withStored(ctx.read(frame, 0, 0));
}

const COUNTER_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    ctx.emit(0, counter(ctx, ctx.frame(root, 0)));
    ctx.emit(1, counter(ctx, ctx.frame(root, 1)));
  },
  inputs: {series: [], builtins: []},
  parameters: [],
  state: {
    frames: [
      {locals: [], subs: [{fid: 1}, {fid: 1}]},
      {
        locals: [{storage: Storage.Var, depth: {kind: 'none'}, empty: NUMBER}],
        subs: [],
      },
    ],
  },
  outputs: {
    schema: outputSchema([
      ...[scalar('a', 'int'), scalar('b', 'int')].map(field =>
        output(field.name, field),
      ),
    ]),
  },
  requests: [],
});

const TYPED_HISTORY_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    ctx.write(root, 0, int(7));
    ctx.write(root, 1, bool(true));
    ctx.write(root, 2, text('present'));
    ctx.emit(0, NUMBER.withStored(ctx.read(root, 0, 2)));
    ctx.emit(1, BOOLEAN.withStored(ctx.read(root, 1, 2)));
    ctx.emit(2, STRING.withStored(ctx.read(root, 2, 2)));
  },
  inputs: {series: [], builtins: []},
  parameters: [],
  state: {
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            empty: NUMBER,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            empty: BOOLEAN,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            empty: STRING,
          },
        ],
        subs: [],
      },
    ],
  },
  outputs: {
    schema: outputSchema([
      ...[
        scalar('number', 'int'),
        scalar('boolean', 'bool'),
        scalar('string', 'string'),
      ].map(field => output(field.name, field)),
    ]),
  },
  requests: [],
});

const TICK_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    if (ctx.needsInit(root, 0)) ctx.initialize(root, 0, int(0));
    if (ctx.needsInit(root, 1)) ctx.initialize(root, 1, int(0));
    const close = ctx.series(0, 0);
    ctx.write(root, 0, int(Number(ctx.read(root, 0, 0)) + close));
    ctx.write(root, 1, int(Number(ctx.read(root, 1, 0)) + 1));
    ctx.write(root, 2, int(close));
    ctx.emit(0, NUMBER.withStored(ctx.read(root, 0, 0)));
    ctx.emit(1, NUMBER.withStored(ctx.read(root, 1, 0)));
    ctx.emit(2, NUMBER.withStored(ctx.read(root, 2, 0)));
  },
  inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
  parameters: [],
  state: {
    frames: [
      {
        locals: [
          {storage: Storage.Var, depth: {kind: 'none'}, empty: NUMBER},
          {storage: Storage.Varip, depth: {kind: 'none'}, empty: NUMBER},
          {storage: Storage.PerBar, depth: {kind: 'none'}, empty: NUMBER},
        ],
        subs: [],
      },
    ],
  },
  outputs: {
    schema: outputSchema([
      ...[
        scalar('var', 'int'),
        scalar('varip', 'int'),
        scalar('per-bar', 'int'),
      ].map(field => output(field.name, field)),
    ]),
  },
  requests: [],
});

function arrayStateModule(): Module {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
    main(ctx, root) {
      if (ctx.needsInit(root, 0)) {
        ctx.initialize(
          root,
          0,
          ctx.callCollection('array.from', ARRAY, [int(0)]),
        );
      }
      if (ctx.needsInit(root, 1)) {
        ctx.initialize(
          root,
          1,
          ctx.callCollection('array.from', ARRAY, [int(0)]),
        );
      }
      for (let slot = 0; slot < 2; slot += 1) {
        const mutation = ctx.mutateCollection(
          'array.push',
          ARRAY.withStored(ctx.read(root, slot, 0)),
          [int(ctx.series(0, 0))],
        );
        ctx.write(root, slot, ARRAY.withStored(mutation.replacement));
        ctx.emit(
          slot,

          ctx.callCollection('array.size', NUMBER, [
            ARRAY.withStored(mutation.replacement),
          ]),
        );
      }
    },
    inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
    parameters: [],
    state: {
      frames: [
        {
          locals: [
            {storage: Storage.Var, depth: {kind: 'none'}, empty: ARRAY},
            {storage: Storage.Varip, depth: {kind: 'none'}, empty: ARRAY},
          ],
          subs: [],
        },
      ],
    },
    outputs: {
      schema: outputSchema([
        ...[scalar('var', 'int'), scalar('varip', 'int')].map(field =>
          output(field.name, field),
        ),
      ]),
    },
    requests: [],
  });
}

describe('Context core parity', () => {
  test('written call sites own independent persistent state', () => {
    const target = runtime(COUNTER_MODULE);
    expect(channels(run(target, input()))).toEqual([1, 1]);
    expect(channels(run(target, input()))).toEqual([2, 2]);
    expect(channels(run(target, input()))).toEqual([3, 3]);
    target.dispose();
  });

  test('a failed first subframe activation disappears before retry', () => {
    let fail = true;
    const module: Module = testModule({
      ...COUNTER_MODULE,
      main(ctx, root) {
        if (fail) {
          counter(ctx, ctx.frame(root, 0));
          throw new Error('after first call');
        }
        ctx.emit(0, counter(ctx, ctx.frame(root, 0)));
      },
    });
    const target = runtime(module);
    expect(() => run(target, input())).toThrow('after first call');
    fail = false;
    expect(channels(run(target, input()))[0]).toBe(1);
    target.dispose();
  });

  test("early local history returns each binding's declared empty", () => {
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
    const module: Module = testModule({
      ...COUNTER_MODULE,
      main(ctx, root) {
        if (invoke) ctx.emit(0, counter(ctx, ctx.frame(root, 0)));
      },
      state: {
        frames: [
          {locals: [], subs: [{fid: 1}]},
          {
            locals: [
              {storage: Storage.Varip, depth: {kind: 'none'}, empty: NUMBER},
            ],
            subs: [],
          },
        ],
      },
      outputs: {
        schema: outputSchema([
          ...[scalar('value', 'int')].map(field => output(field.name, field)),
        ]),
      },
    });
    const target = runtime(module);
    expect(channels(run(target, input({provisional: true})))).toEqual([1]);
    invoke = false;
    expect(run(target, input()).outputs).toEqual([null]);
    invoke = true;
    expect(channels(run(target, input()))).toEqual([2]);
    target.dispose();
  });

  test('an active skipped subframe advances local history with typed empty', () => {
    let invoke = true;
    const module: Module = testModule({
      abi: RUNTIME_ABI_VERSION,
      main(ctx, root) {
        if (!invoke) {
          ctx.emit(0, int(NaN));
          return;
        }
        const child = ctx.frame(root, 0);
        ctx.write(child, 0, int(ctx.series(0, 0)));
        ctx.emit(0, NUMBER.withStored(ctx.read(child, 0, 1)));
      },
      inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
      parameters: [],
      state: {
        frames: [
          {locals: [], subs: [{fid: 1}]},
          {
            locals: [
              {
                storage: Storage.PerBar,
                depth: {kind: 'const', bars: 1},
                empty: NUMBER,
              },
            ],
            subs: [],
          },
        ],
      },
      outputs: {
        schema: outputSchema([
          ...[scalar('previous', 'int')].map(field =>
            output(field.name, field),
          ),
        ]),
      },
      requests: [],
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
    const module: Module = testModule({
      abi: RUNTIME_ABI_VERSION,
      main(ctx, root) {
        if (ctx.needsInit(root, 0)) {
          ctx.initialize(
            root,
            0,
            HOLDER.withStored(
              ctx.newStruct(
                new Holder({
                  values: ARRAY.withStored(
                    unwrap(ctx.callCollection('array.from', ARRAY, [int(0)])),
                  ),
                }),
                48,
              ),
            ),
          );
        }
        const holder = ctx.read(root, 0, 0);
        const current = ctx.mutateCollection(
          'array.push',
          ctx.structField(holder, Holder, 'values', ARRAY),
          [int(Number(ctx.builtin(0, 0)) + 1)],
        ).replacement;
        ctx.storeStructField(
          holder,
          Holder,
          'values',
          ARRAY.withStored(current),
        );
        ctx.emit(
          0,

          ctx.callCollection('array.size', NUMBER, [ARRAY.withStored(current)]),
        );
        if (Number(ctx.builtin(0, 0)) === 0) {
          ctx.emit(1, int(NaN));
        } else {
          const prior = ctx.structField(
            ctx.read(root, 0, 1),
            Holder,
            'values',
            ARRAY,
          );
          ctx.emit(1, ctx.callCollection('array.size', NUMBER, [prior]));
        }
      },
      inputs: {
        series: [],
        builtins: [
          {
            source: {domain: 'bar', field: 'bar_index'},
            empty: NUMBER,
            depth: {kind: 'none'},
          },
        ],
      },
      parameters: [],
      state: {
        frames: [
          {
            locals: [
              {
                storage: Storage.Var,
                depth: {kind: 'const', bars: 1},
                empty: HOLDER,
              },
            ],
            subs: [],
          },
        ],
      },
      outputs: {
        schema: outputSchema([
          ...[scalar('current', 'int'), scalar('prior', 'int')].map(field =>
            output(field.name, field),
          ),
        ]),
      },
      requests: [],
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

  test('nested skipped calls retain only accepted counters and final array histories', () => {
    let selected = -1;
    let fail = false;
    const module = testModule({
      abi: RUNTIME_ABI_VERSION,
      main(step, root) {
        if (selected < 0) return;
        const inner = step.frame(step.frame(root, selected), 0);
        if (step.needsInit(inner, 0)) step.initialize(inner, 0, int(0));
        if (step.needsInit(inner, 1)) step.initialize(inner, 1, int(0));
        const value = step.series(0, 0);
        step.write(inner, 0, int(Number(step.read(inner, 0, 0)) + value));
        step.write(inner, 1, int(Number(step.read(inner, 1, 0)) + 1));
        step.write(
          inner,
          2,
          step.callCollection('array.from', ARRAY, [int(value)]),
        );
        const previous = step.read(inner, 2, 1);
        step.emit(0, NUMBER.withStored(step.read(inner, 0, 0)));
        step.emit(1, NUMBER.withStored(step.read(inner, 1, 0)));
        step.emit(
          2,
          previous === null
            ? NUMBER
            : step.callCollection('array.first', NUMBER, [
                ARRAY.withStored(previous),
              ]),
        );
        if (fail) throw new Error('nested attempt failed');
      },
      inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
      parameters: [],
      requests: [],
      outputs: {
        schema: outputSchema(
          ['total', 'ticks', 'previous'].map(name =>
            output(name, scalar(name, 'int')),
          ),
        ),
      },
      state: {
        frames: [
          {locals: [], subs: [{fid: 1}, {fid: 1}]},
          {locals: [], subs: [{fid: 2}]},
          {
            locals: [
              {storage: Storage.Var, depth: {kind: 'none'}, empty: NUMBER},
              {storage: Storage.Varip, depth: {kind: 'none'}, empty: NUMBER},
              {
                storage: Storage.PerBar,
                depth: {kind: 'const', bars: 1},
                empty: ARRAY,
              },
            ],
            subs: [],
          },
        ],
      },
    });
    const target = runtime(module);
    // Independent arithmetic oracle: only final attempts change total/history;
    // every accepted call increments ticks, and failed attempts do neither.
    const expected = [0, 1].map(() => ({total: 0, ticks: 0, previous: NaN}));
    const attempt = (
      call: number,
      value: number,
      provisional: boolean,
      failed = false,
    ) => {
      selected = call;
      fail = failed;
      const update = input({series: [value], provisional});
      if (failed) {
        expect(() => target.step(update)).toThrow('nested attempt failed');
        return;
      }
      const state = expected[call];
      expect(target.step(update).outputs).toEqual(
        state
          ? [state.total + value, state.ticks + 1, state.previous]
          : [null, null, null],
      );
      if (state) state.ticks++;
      if (!provisional) {
        for (const item of expected) item.previous = NaN;
        if (state) {
          state.total += value;
          state.previous = value;
        }
      }
    };
    try {
      for (let row = 0; row < 256; row++) {
        attempt(row % 2, row * 10 + 1, true);
        attempt(1 - (row % 2), row * 10 + 2, true, true);
        if (row % 3 === 0) attempt(1 - (row % 2), row * 10 + 3, true);
        attempt(row % 4 === 0 ? -1 : row % 2, row * 10 + 4, false);
      }
    } finally {
      target.dispose();
    }
  });
});
