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
import type {StorageType} from '../storage-types';

const NUMBER = 0;
const ARRAY = 1;
const COUNTER = 2;
const ENVELOPE = 3;
const BOOLEAN = 4;
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
  {kind: 'boolean'},
] as const satisfies readonly StorageType[];

function input(value: number, provisional: boolean): StepInput {
  return {series: [value], builtins: [], requests: [], provisional};
}

const PROVISIONAL_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    if (ctx.needsInit(root, 0)) ctx.initialize(root, 0, 0);
    if (ctx.needsInit(root, 1)) ctx.initialize(root, 1, 0);
    ctx.write(root, 0, Number(ctx.read(root, 0, 0)) + ctx.series(0, 0));
    ctx.write(root, 1, Number(ctx.read(root, 1, 0)) + 1);
    ctx.emit(0, 0, ctx.read(root, 0, 0));
    ctx.emit(0, 1, ctx.read(root, 1, 0));
  },
  inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
  parameters: [],
  state: {
    layout: LAYOUTS,
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
  outputs: {
    schema: outputSchema([
      output('output0', [scalar('var', 'int'), scalar('varip', 'int')]),
    ]),
  },
  requests: [],
});

function structModule(shouldFail: () => boolean): Module {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
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
    inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
    parameters: [],
    state: {
      layout: LAYOUTS,
      frames: [
        {
          locals: [
            {storage: Storage.Var, depth: {kind: 'none'}, layout: COUNTER},
          ],
          subs: [],
        },
      ],
    },
    outputs: {
      schema: outputSchema([output('output0', [scalar('value', 'int')])]),
    },
    requests: [],
  });
}

function structEffectModule(shouldFail: () => boolean): Module {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
    main(ctx, root) {
      if (ctx.needsInit(root, 0)) {
        ctx.initialize(root, 0, ctx.newStruct(COUNTER, [0]));
      }
      const counter = ctx.requireStruct(ctx.read(root, 0, 0), COUNTER);
      const next = Number(ctx.structField(counter, COUNTER, 0)) + 1;
      ctx.storeStructField(counter, COUNTER, 0, next);
      const envelope = ctx.newStruct(ENVELOPE, [counter]);
      ctx.append(0, envelope);
      ctx.storeStructField(counter, COUNTER, 0, next + 100);
      if (shouldFail()) throw new Error('effect step failed');
    },
    inputs: {series: [], builtins: []},
    parameters: [],
    state: {
      layout: LAYOUTS,
      frames: [
        {
          locals: [
            {storage: Storage.Var, depth: {kind: 'none'}, layout: COUNTER},
          ],
          subs: [],
        },
      ],
    },
    outputs: {
      schema: outputSchema([
        output(
          'effect0',
          [
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
          ],
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
      ctx.initialize(root, 0, ctx.newStruct(COUNTER, [0]));
    }
  },
  inputs: {series: [], builtins: []},
  parameters: [],
  state: {
    layout: LAYOUTS,
    frames: [
      {
        locals: [
          {storage: Storage.Var, depth: {kind: 'none'}, layout: ENVELOPE},
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
    ctx.write(root, 0, ctx.callCollection('array.from', ARRAY, [close]));
    ctx.emit(
      0,
      0,
      close < 3
        ? 0
        : ctx.callCollection('array.size', NUMBER, [ctx.read(root, 0, 2)]),
    );
  },
  inputs: {series: [{id: 'close', depth: {kind: 'none'}}], builtins: []},
  parameters: [],
  state: {
    layout: LAYOUTS,
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
  outputs: {
    schema: outputSchema([output('output0', [scalar('old-size', 'int')])]),
  },
  requests: [],
});

const COLLECT_CHILD_MODULE: Module = testModule({
  abi: RUNTIME_ABI_VERSION,
  main(ctx, root) {
    ctx.write(root, 0, 0);
  },
  inputs: {series: [], builtins: []},
  parameters: [],
  state: {
    layout: LAYOUTS,
    frames: [
      {
        locals: [
          {storage: Storage.PerBar, depth: {kind: 'none'}, layout: NUMBER},
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
    const current = ctx.request(0, 0);
    const prior = ctx.request(0, 1);
    const size = Number(ctx.callCollection('array.size', NUMBER, [current]));
    const priorSize =
      prior === null
        ? -1
        : Number(ctx.callCollection('array.size', NUMBER, [prior]));
    ctx.emit(0, 0, size);
    ctx.emit(0, 1, ctx.callCollection('array.is_empty', BOOLEAN, [current]));
    ctx.emit(
      0,
      2,
      size === 0 ? -1 : ctx.callCollection('array.first', NUMBER, [current]),
    );
    ctx.emit(
      0,
      3,
      size === 0 ? -1 : ctx.callCollection('array.last', NUMBER, [current]),
    );
    ctx.emit(0, 4, priorSize);
    ctx.emit(
      0,
      5,
      priorSize <= 0 ? -1 : ctx.callCollection('array.first', NUMBER, [prior]),
    );
  },
  inputs: {series: [], builtins: []},
  parameters: [],
  state: {layout: LAYOUTS, frames: [{locals: [], subs: []}]},
  outputs: {
    schema: outputSchema([
      output('output0', [
        scalar('size', 'int'),
        scalar('empty', 'bool'),
        scalar('first', 'int'),
        scalar('last', 'int'),
        scalar('prior-size', 'int'),
        scalar('prior-first', 'int'),
      ]),
    ]),
  },
  requests: [
    {
      name: 'ticks',
      mode: 'collect',
      depth: {kind: 'const', bars: 1},
      resultSlot: 0,
      resultLayout: NUMBER,
      layout: ARRAY,
      context: {
        symbol: 'X',
        timeframe: '1m',
        fill: 'carry',
        availability: 'end',
        ignoreInvalidSymbol: false,
        calcBarsCount: 0,
      },
      module: COLLECT_CHILD_MODULE,
    },
  ],
});

function collectInput(values: Stored, provisional = false): StepInput {
  return {series: [], builtins: [], requests: [values], provisional};
}

function channels(result: StepResult) {
  return result.outputs[0] === null
    ? []
    : Object.values(result.outputs[0] as Record<string, unknown>);
}

describe('Context', () => {
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
        ordinal: 0,
        payload: {counter: {value: 1}},
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
    ).toThrow("references 'Counter', expected 'Envelope'");
    runtime.dispose();
  });

  test('accepts input NaN but fails closed when a read sees infinity', () => {
    const runtime = new Context(PROVISIONAL_MODULE.clone().bind());
    const na = runtime.step(input(NaN, false));
    expect(
      Number.isNaN((na.outputs[0] as Record<string, unknown>).var as number),
    ).toBe(true);
    expect(() => runtime.step(input(Infinity, false))).toThrow(
      'input series 0 returned a non-finite value',
    );
    runtime.dispose();
  });

  test('preserves multi-channel output and numeric na', () => {
    const runtime = new Context(PROVISIONAL_MODULE.clone().bind());
    const result = runtime.step(input(NaN, false));

    expect(result.outputs).toEqual([{var: Number.NaN, varip: 1}]);
    runtime.dispose();
  });

  test('preserves a missing conditional output as no emission', () => {
    const module = testModule({
      abi: RUNTIME_ABI_VERSION,
      main() {},
      inputs: {series: [], builtins: []},
      parameters: [],
      state: {layout: LAYOUTS, frames: [{locals: [], subs: []}]},
      outputs: {
        schema: outputSchema([output('output0', [scalar('value', 'int')])]),
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
      'request 0 collect input is not an array',
    );
    expect(() => runtime.step(collectInput([1, 'bad']))).toThrow(
      'request 0 element 1 does not match number layout 0',
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

  test('rejects a collect request whose parent layout is not its Tea array layout', () => {
    const mismatched = Object.assign(COLLECT_REQUEST_MODULE.clone(), {
      inputs: {...COLLECT_REQUEST_MODULE.inputs},
      requests: [
        {
          ...COLLECT_REQUEST_MODULE.requests[0]!,
          layout: NUMBER,
          module: COLLECT_REQUEST_MODULE.requests[0].module,
        },
      ],
    });
    expect(() => new Context(mismatched.bind())).toThrow(
      'request 0 has inconsistent collect layouts',
    );
  });
});
