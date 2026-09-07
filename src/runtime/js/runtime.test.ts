import {Field, Struct} from 'apache-arrow';
// Purpose: Ownership, provisional/final, rollback, and GC-safe-point coverage
// for the state-owning JavaScript runtime.

import {describe, expect, test} from 'vitest';
import {Storage} from '../../ir/node';
import {Context, type StepInput, type StepResult} from './context';

import {RUNTIME_ABI_VERSION} from '../module-abi';
import {Module} from '../module-binding';
import {testModule, scalar, output} from '../testing';
import {outputSchema} from '../output';
import type {Stored} from '../value';
import {array, bool, int, struct, Value} from './value';

// Step exposes raw payloads; fixture empties validate their domains at that boundary.
const NUMBER: Value<unknown> = int(NaN);
const ARRAY: Value<unknown> = array(NUMBER).empty();
const BOOLEAN: Value<unknown> = bool(false);
class Counter {
  value = NUMBER;
  constructor(fields?: {value: typeof NUMBER}) {
    Object.assign(this, fields);
  }
}
const COUNTER: Value<unknown> = struct(Counter, 'test.Counter', 24).empty();
class Envelope {
  counter = COUNTER;
  constructor(fields?: {counter: typeof COUNTER}) {
    Object.assign(this, fields);
  }
}
const ENVELOPE: Value<unknown> = struct(Envelope, 'test.Envelope', 24).empty();

function input(value: number, provisional: boolean): StepInput {
  return {series: [value], builtins: [], requests: [], provisional};
}

const PROVISIONAL_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    if (ctx.needsInit(root, 0)) ctx.initialize(root, 0, int(0));
    if (ctx.needsInit(root, 1)) ctx.initialize(root, 1, int(0));
    ctx.write(root, 0, int(Number(ctx.read(root, 0, 0)) + ctx.series(0, 0)));
    ctx.write(root, 1, int(Number(ctx.read(root, 1, 0)) + 1));
    ctx.emit(0, NUMBER.withStored(ctx.read(root, 0, 0)));
    ctx.emit(1, NUMBER.withStored(ctx.read(root, 1, 0)));
  },
  inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
  parameters: [],
  state: {
    frames: [
      {
        locals: [
          {storage: Storage.Var, depth: {kind: 'none'}, empty: NUMBER},
          {storage: Storage.Varip, depth: {kind: 'none'}, empty: NUMBER},
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

function structModule(shouldFail: () => boolean): Module {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
    main(ctx, root) {
      if (ctx.needsInit(root, 0)) {
        ctx.initialize(
          root,
          0,
          COUNTER.withStored(ctx.newStruct(new Counter({value: int(0)}), 24)),
        );
      }
      const counter = ctx.requireStruct(ctx.read(root, 0, 0), Counter);
      const value =
        Number(ctx.structField(counter, Counter, 'value', NUMBER).value) + 1;
      ctx.storeStructField(counter, Counter, 'value', int(value));
      if (shouldFail()) throw new Error('step failed');
      ctx.emit(0, int(value));
    },
    inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
    parameters: [],
    state: {
      frames: [
        {
          locals: [
            {storage: Storage.Var, depth: {kind: 'none'}, empty: COUNTER},
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
    requests: [],
  });
}

function structEffectModule(shouldFail: () => boolean): Module {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
    main(ctx, root) {
      if (ctx.needsInit(root, 0)) {
        ctx.initialize(
          root,
          0,
          COUNTER.withStored(ctx.newStruct(new Counter({value: int(0)}), 24)),
        );
      }
      const counter = ctx.requireStruct(ctx.read(root, 0, 0), Counter);
      const next =
        Number(ctx.structField(counter, Counter, 'value', NUMBER).value) + 1;
      ctx.storeStructField(counter, Counter, 'value', int(next));
      const envelope = ctx.newStruct(
        new Envelope({counter: COUNTER.withStored(counter)}),
        24,
      );
      ctx.append(0, ENVELOPE.withStored(envelope));
      ctx.storeStructField(counter, Counter, 'value', int(next + 100));
      if (shouldFail()) throw new Error('effect step failed');
    },
    inputs: {series: [], builtins: []},
    parameters: [],
    state: {
      frames: [
        {
          locals: [
            {storage: Storage.Var, depth: {kind: 'none'}, empty: COUNTER},
          ],
          subs: [],
        },
      ],
    },
    outputs: {
      schema: outputSchema([
        output(
          'effect0',
          new Field(
            'payload',
            new Struct([
              new Field(
                'counter',
                new Struct([scalar('value', 'int')]),
                true,
                new Map([
                  ['tea:type', 'struct'],
                  ['tea:typeId', 'test.Counter'],
                  ['tea:name', 'Counter'],
                ]),
              ),
            ]),
            true,
            new Map([
              ['tea:type', 'struct'],
              ['tea:typeId', 'test.Envelope'],
              ['tea:name', 'Envelope'],
            ]),
          ),
          true,
        ),
      ]),
    },
    requests: [],
  });
}

const WRONG_NOMINAL_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    if (ctx.needsInit(root, 0)) {
      ctx.initialize(
        root,
        0,
        COUNTER.withStored(ctx.newStruct(new Counter({value: int(0)}), 24)),
      );
    }
  },
  inputs: {series: [], builtins: []},
  parameters: [],
  state: {
    frames: [
      {
        locals: [
          {storage: Storage.Var, depth: {kind: 'none'}, empty: ENVELOPE},
        ],
        subs: [],
      },
    ],
  },
  outputs: {schema: outputSchema([])},
  requests: [],
});

const GC_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    const close = ctx.series(0, 0);
    ctx.write(root, 0, ctx.callCollection('array.from', ARRAY, [int(close)]));
    ctx.emit(
      0,
      close < 3
        ? int(0)
        : ctx.callCollection('array.size', NUMBER, [
            ARRAY.withStored(ctx.read(root, 0, 2)),
          ]),
    );
  },
  inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
  parameters: [],
  state: {
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'const', bars: 2},
            empty: ARRAY,
          },
        ],
        subs: [],
      },
    ],
  },
  outputs: {
    schema: outputSchema([
      ...[scalar('old-size', 'int')].map(field => output(field.name, field)),
    ]),
  },
  requests: [],
});

const COLLECT_CHILD_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    ctx.write(root, 0, int(0));
  },
  inputs: {series: [], builtins: []},
  parameters: [],
  state: {
    frames: [
      {
        locals: [
          {storage: Storage.PerBar, depth: {kind: 'none'}, empty: NUMBER},
        ],
        subs: [],
      },
    ],
  },
  outputs: {schema: outputSchema([])},
  requests: [],
});

const COLLECT_REQUEST_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx) {
    const current = ARRAY.withStored(ctx.request(0, 0));
    const prior = ARRAY.withStored(ctx.request(0, 1));
    const size = Number(
      ctx.callCollection('array.size', NUMBER, [current]).value,
    );
    const priorSize =
      prior.value === null
        ? -1
        : Number(ctx.callCollection('array.size', NUMBER, [prior]).value);
    ctx.emit(0, int(size));
    ctx.emit(1, ctx.callCollection('array.is_empty', BOOLEAN, [current]));
    ctx.emit(
      2,
      size === 0
        ? int(-1)
        : ctx.callCollection('array.first', NUMBER, [current]),
    );
    ctx.emit(
      3,
      size === 0
        ? int(-1)
        : ctx.callCollection('array.last', NUMBER, [current]),
    );
    ctx.emit(4, int(priorSize));
    ctx.emit(
      5,
      priorSize <= 0
        ? int(-1)
        : ctx.callCollection('array.first', NUMBER, [prior]),
    );
  },
  inputs: {series: [], builtins: []},
  parameters: [],
  state: {frames: [{locals: [], subs: []}]},
  outputs: {
    schema: outputSchema([
      ...[
        scalar('size', 'int'),
        scalar('empty', 'bool'),
        scalar('first', 'int'),
        scalar('last', 'int'),
        scalar('prior-size', 'int'),
        scalar('prior-first', 'int'),
      ].map(field => output(field.name, field)),
    ]),
  },
  requests: [
    {
      name: 'ticks',
      mode: 'collect',
      depth: {kind: 'const', bars: 1},
      resultSlot: 0,
      resultEmpty: NUMBER,
      empty: ARRAY,
      context: {
        symbol: 'X',
        timeframe: '1m',
        fill: 'carry',
        ignoreInvalidSymbol: false,
        calcBarsCount: 0,
      },
      module: COLLECT_CHILD_MODULE,
    },
  ],
});

function collectInput(
  values: Stored | readonly Stored[],
  provisional = false,
): StepInput {
  return {series: [], builtins: [], requests: [values], provisional};
}

function channels(result: StepResult) {
  return result.outputs;
}

describe('Context', () => {
  test('rejects duplicate handwritten sets including null and aborts staged state', () => {
    let duplicate = true;
    const module = testModule({
      abi: RUNTIME_ABI_VERSION,
      main(step, root) {
        if (step.needsInit(root, 0)) step.initialize(root, 0, int(0));
        step.write(root, 0, int(Number(step.read(root, 0, 0)) + 1));
        step.emit(0, NUMBER.withStored(step.read(root, 0, 0)));
        step.emit(1, COUNTER);
        if (duplicate) step.emit(1, COUNTER);
      },
      inputs: {series: [], builtins: []},
      parameters: [],
      requests: [],
      state: {
        frames: [
          {
            locals: [
              {storage: Storage.Var, depth: {kind: 'none'}, empty: NUMBER},
            ],
            subs: [],
          },
        ],
      },
      outputs: {
        schema: outputSchema([
          output('count', scalar('count', 'int')),
          output(
            'counter',
            new Field(
              'counter',
              new Struct([scalar('value', 'int')]),
              true,
              new Map([
                ['tea:type', 'struct'],
                ['tea:name', 'Counter'],
                ['tea:typeId', 'test.Counter'],
              ]),
            ),
          ),
        ]),
      },
    });
    const runtime = new Context(module.bind());
    const emptyInput = {
      series: [],
      builtins: [],
      requests: [],
      provisional: false,
    };
    expect(() => runtime.step(emptyInput)).toThrow(
      "duplicate emit to output 'counter'",
    );
    duplicate = false;
    expect(runtime.step(emptyInput).outputs).toEqual([1, null]);
    runtime.dispose();
  });
  test('owns State and Intermediate across provisional and final steps', () => {
    const runtime = new Context(PROVISIONAL_MODULE.clone().bind());

    expect(channels(runtime.step(input(10, true)))).toEqual([10, 1]);
    expect(channels(runtime.step(input(11, true)))).toEqual([11, 2]);
    expect(channels(runtime.step(input(12, false)))).toEqual([12, 3]);
    expect(channels(runtime.step(input(5, false)))).toEqual([17, 4]);

    runtime.dispose();
    expect(() => runtime.step(input(1, false))).toThrow('Context is disposed');
  });

  test('does not advance owned state or Heap writes after a failed step', () => {
    let fail = false;
    const runtime = new Context(structModule(() => fail).bind());

    expect(channels(runtime.step(input(0, false)))).toEqual([1]);
    fail = true;
    expect(() => runtime.step(input(0, false))).toThrow('step failed');
    fail = false;
    expect(channels(runtime.step(input(0, false)))).toEqual([2]);
    runtime.dispose();
  });

  test('snapshots nested struct effects at emit time and drops failed emissions', () => {
    let fail = true;
    const runtime = new Context(structEffectModule(() => fail).bind());

    expect(() =>
      runtime.step({
        series: [],
        builtins: [],
        requests: [],
        provisional: false,
      }),
    ).toThrow('effect step failed');

    fail = false;
    const result = runtime.step({
      series: [],
      builtins: [],
      requests: [],
      provisional: false,
    });
    expect(result.outputs[0]).toEqual([
      {
        counter: {value: 1},
      },
    ]);
    runtime.dispose();
  });

  test('rejects nominally wrong struct values at State initialization', () => {
    const runtime = new Context(WRONG_NOMINAL_MODULE.clone().bind());
    expect(() =>
      runtime.step({
        series: [],
        builtins: [],
        requests: [],
        provisional: false,
      }),
    ).toThrow('initializer has a different type');
    runtime.dispose();
  });

  test('accepts input NaN but fails closed when a read sees infinity', () => {
    const runtime = new Context(PROVISIONAL_MODULE.clone().bind());
    const na = runtime.step(input(NaN, false));
    expect(Number.isNaN(na.outputs[0] as number)).toBe(true);
    expect(() => runtime.step(input(Infinity, false))).toThrow(
      'input series 0 returned a non-finite value',
    );
    runtime.dispose();
  });

  test('preserves multi-channel output and numeric na', () => {
    const runtime = new Context(PROVISIONAL_MODULE.clone().bind());
    const result = runtime.step(input(NaN, false));

    expect(result.outputs).toEqual([Number.NaN, 1]);
    runtime.dispose();
  });

  test('preserves a missing conditional output as no emission', () => {
    const module = testModule({
      abi: RUNTIME_ABI_VERSION,
      main() {},
      inputs: {series: [], builtins: []},
      parameters: [],
      state: {frames: [{locals: [], subs: []}]},
      outputs: {
        schema: outputSchema([
          ...[scalar('value', 'int')].map(field => output(field.name, field)),
        ]),
      },
      requests: [],
    });
    const runtime = new Context(module);
    const result = runtime.step({
      series: [],
      builtins: [],
      requests: [],
      provisional: false,
    });

    expect(result.outputs).toEqual([null]);
    runtime.dispose();
  });

  test('collects from retained owner state rather than a provisional candidate', () => {
    const runtime = new Context(GC_MODULE.clone().bind());

    runtime.step(input(1, false));
    runtime.step(input(2, false));
    expect(channels(runtime.step(input(3, true)))).toEqual([1]);
    expect(channels(runtime.step(input(4, true)))).toEqual([1]);
    runtime.dispose();
  });

  test('materializes empty, single, and multiple request batches as Tea arrays with history', () => {
    const runtime = new Context(COLLECT_REQUEST_MODULE.clone().bind());

    expect(channels(runtime.step(collectInput([])))).toEqual([
      0,
      true,
      -1,
      -1,
      -1,
      -1,
    ]);
    expect(channels(runtime.step(collectInput([7])))).toEqual([
      1,
      false,
      7,
      7,
      0,
      -1,
    ]);
    expect(channels(runtime.step(collectInput([10, 20, 30])))).toEqual([
      3,
      false,
      10,
      30,
      1,
      7,
    ]);

    runtime.dispose();
  });

  test('rejects non-batch and invalid collect request elements without poisoning state', () => {
    const runtime = new Context(COLLECT_REQUEST_MODULE.clone().bind());

    expect(() => runtime.step(collectInput(7))).toThrow(
      'collect request requires an array',
    );
    expect(() => runtime.step(collectInput([1, 'bad']))).toThrow(
      'value does not match int',
    );
    expect(channels(runtime.step(collectInput([5])))).toEqual([
      1,
      false,
      5,
      5,
      -1,
      -1,
    ]);

    runtime.dispose();
  });

  test('aborts a materialized request array and its history when main fails', () => {
    let fail = true;
    const module = new Module(COLLECT_REQUEST_MODULE, ctx => {
      COLLECT_REQUEST_MODULE.main(ctx);
      if (fail) throw new Error('parent failed');
    });
    const runtime = new Context(module.bind());

    expect(() => runtime.step(collectInput([1, 2]))).toThrow('parent failed');
    fail = false;
    expect(channels(runtime.step(collectInput([3])))).toEqual([
      1,
      false,
      3,
      3,
      -1,
      -1,
    ]);

    runtime.dispose();
  });

  test('rejects a collect request with a scalar parent value', () => {
    const mismatched = Object.assign(COLLECT_REQUEST_MODULE.clone(), {
      inputs: {...COLLECT_REQUEST_MODULE.inputs},
      requests: [
        {
          ...COLLECT_REQUEST_MODULE.requests[0]!,
          empty: NUMBER,
          module: COLLECT_REQUEST_MODULE.requests[0].module,
        },
      ],
    });
    expect(() => new Context(mismatched.bind())).toThrow(
      'request 0 has inconsistent collect values',
    );
  });
});
