// Purpose: Sparse effects share the JS runtime's row transaction and
// vanish on error/suspension instead of leaking or duplicating records.

import {describe, expect, test} from 'vitest';
import {MemorySink} from '../providers/sinks/memory-sink';
import {
  type DataProvider,
  type OutputSink,
  type ProviderContext,
  type TimeAxis,
} from './abi';
import {bindFixedHistory as bind} from './fixed-history';
import {RUNTIME_ABI_VERSION, type JSModule} from './module-abi';
import {testModule} from './testing';
import type {ValueLayout} from './value-layout';

const NUMBER = 0;
const LAYOUTS = [
  {kind: 'number', numeric: 'int'},
] as const satisfies readonly ValueLayout[];

function context(rows = 1, axis: TimeAxis | null = null): ProviderContext {
  return {
    rows,
    axis,
    series: id => (id === 'close' ? {length: rows, at: row => 10 + row} : null),
    builtinValue: () => undefined,
  };
}

const provider: DataProvider = {
  resolveContext: () => Promise.resolve(context()),
};

const INT_EFFECT = {
  layout: NUMBER,
  declaration: {payload: {kind: 'int' as const}},
};

function effectModule(main: JSModule['main']): JSModule {
  return testModule({
    abi: RUNTIME_ABI_VERSION,
    layout: LAYOUTS,
    manifest: {
      series: [],
      builtin: [],
      params: [],
      outputs: [],
      effects: [INT_EFFECT],
      frames: [{locals: [], subs: []}],
      requests: [],
    },
    requests: [],
    funcs: {},
    main,
  });
}

describe('effect row transactions', () => {
  test('a failed transaction discards effects before a successful retry', async () => {
    let fail = true;
    const module = effectModule(ctx => {
      ctx.emitEffect(0, 41);
      if (fail) {
        throw new Error('transaction failed');
      }
    });
    const sink = new MemorySink();
    const execution = await bind(module, {
      params: {},
      provider,
      sink,
      timeNow: 0,
    });

    expect(() => execution.executeRow(0, false)).toThrow('transaction failed');
    fail = false;
    execution.executeRow(0, false);
    execution.commitRow(0);

    expect(sink.effectEmissions).toEqual([
      {row: 0, effectId: 0, payload: 41, provisional: false},
    ]);
    execution.dispose();
  });

  test('completed provisional and final transactions each publish one row unit', async () => {
    const module = effectModule(ctx => ctx.emitEffect(0, 7));
    const sink = new MemorySink();
    const execution = await bind(module, {
      params: {},
      provider,
      sink,
      timeNow: 0,
    });

    execution.executeRow(0, true);
    execution.executeRow(0, false);
    execution.commitRow(0);

    expect(sink.publications.map(row => row.provisional)).toEqual([
      true,
      false,
    ]);
    expect(sink.effectEmissions).toEqual([
      {row: 0, effectId: 0, payload: 7, provisional: true},
      {row: 0, effectId: 0, payload: 7, provisional: false},
    ]);
    execution.dispose();
  });

  test('struct effects snapshot fields at emit time', async () => {
    const structLayout = 1;
    const module = testModule({
      abi: RUNTIME_ABI_VERSION,
      layout: [
        {kind: 'number', numeric: 'int'},
        {
          kind: 'struct',
          name: 'Payload',
          typeId: 'test.Payload',
          fields: [{name: 'value', layout: NUMBER}],
        },
      ],
      manifest: {
        series: [],
        builtin: [],
        params: [],
        outputs: [],
        effects: [
          {
            layout: structLayout,
            declaration: {
              payload: {
                kind: 'struct',
                typeId: 'test.Payload',
                displayName: 'Payload',
                fields: [{name: 'value', value: {kind: 'int'}}],
              },
            },
          },
        ],
        frames: [{locals: [], subs: []}],
        requests: [],
      },
      requests: [],
      funcs: {},
      main(ctx) {
        const payload = ctx.newStruct(structLayout, [1]);
        ctx.emitEffect(0, payload);
        ctx.storeStructField(payload, structLayout, 0, 2);
      },
    });
    const sink = new MemorySink();
    const execution = await bind(module, {
      params: {},
      provider,
      sink,
      timeNow: 0,
    });

    await execution.runAll();

    expect(sink.effectEmissions).toEqual([
      {
        row: 0,
        effectId: 0,
        payload: {kind: 'struct', fields: [1]},
        provisional: false,
      },
    ]);
    execution.dispose();
  });

  test('manifest validation rejects non-fixed effect layouts', async () => {
    const unsafe = testModule({
      ...effectModule(() => {}),
      layout: [
        {kind: 'number', numeric: 'int'},
        {kind: 'array', element: NUMBER},
      ],
      manifest: {
        ...effectModule(() => {}).manifest,
        effects: [{...INT_EFFECT, layout: 1}],
      },
    });

    await expect(
      bind(unsafe, {params: {}, provider, sink: new MemorySink(), timeNow: 0}),
    ).rejects.toThrow(
      'effect payload layout 1 has unsupported array transport',
    );
  });

  test('manifest validation keeps logical declarations aligned with physical layouts', async () => {
    const mismatched = testModule({
      ...effectModule(() => {}),
      manifest: {
        ...effectModule(() => {}).manifest,
        effects: [
          INT_EFFECT,
          {
            layout: NUMBER,
            declaration: {payload: {kind: 'float'}},
          },
        ],
      },
    });

    await expect(
      bind(mismatched, {
        params: {},
        provider,
        sink: new MemorySink(),
        timeNow: 0,
      }),
    ).rejects.toThrow(
      'effect payload layout 0 disagrees with logical float schema',
    );
  });

  test('dense output and effects publish once, then sink failure is terminal', async () => {
    const base = effectModule(ctx => {
      ctx.emit(0, 0, 5);
      ctx.emitEffect(0, 6);
    });
    const module = testModule({
      ...base,
      manifest: {
        ...base.manifest,
        outputs: [
          {
            effect: 'plot',
            staticArgs: [],
            channels: [{name: 'series', type: 'int', transport: {kind: 'int'}}],
          },
        ],
      },
    });
    const publications: Parameters<OutputSink['publish']>[0][] = [];
    const sink: OutputSink = {
      declare() {},
      publish(publication) {
        publications.push(publication);
        throw new Error('delivery failed');
      },
    };
    const execution = await bind(module, {
      params: {},
      provider,
      sink,
      timeNow: 0,
    });

    execution.executeRow(0, false);
    expect(() => execution.commitRow(0)).toThrow('delivery failed');
    expect(publications).toEqual([
      {
        row: 0,
        outputs: [{outputId: 0, channels: [5]}],
        effects: [{effectId: 0, payload: 6}],
        provisional: false,
      },
    ]);
    expect(() => execution.executeRow(1, false)).toThrow('delivery failed');
    expect(publications).toHaveLength(1);
    execution.dispose();
  });

  test('final-dense sinks receive effect rows and only the final dense row', async () => {
    let row = 0;
    const base = effectModule(ctx => {
      const current = row;
      row += 1;
      ctx.emit(0, 0, current);
      if (current === 1) ctx.emitEffect(0, 101);
    });
    const module = testModule({
      ...base,
      manifest: {
        ...base.manifest,
        outputs: [
          {
            effect: 'plot',
            staticArgs: [],
            channels: [{name: 'series', type: 'int', transport: {kind: 'int'}}],
          },
        ],
      },
    });
    const publications: Parameters<OutputSink['publish']>[0][] = [];
    const sink: OutputSink = {
      capabilities: {denseRows: 'final'},
      declare() {},
      publish(publication) {
        publications.push(publication);
      },
    };
    const execution = await bind(module, {
      params: {},
      provider: {resolveContext: () => Promise.resolve(context(4))},
      sink,
      timeNow: 0,
    });

    await execution.runAll();

    expect(publications).toEqual([
      {
        row: 1,
        outputs: [],
        effects: [{effectId: 0, payload: 101}],
        provisional: false,
      },
      {
        row: 3,
        outputs: [{outputId: 0, channels: [3]}],
        effects: [],
        provisional: false,
      },
    ]);
    execution.dispose();
  });

  test('effect-disabled sinks receive dense output without effect publications', async () => {
    const base = effectModule(ctx => {
      ctx.emit(0, 0, 17);
      ctx.emitEffect(0, 101);
    });
    const module = testModule({
      ...base,
      manifest: {
        ...base.manifest,
        outputs: [
          {
            effect: 'plot',
            staticArgs: [],
            channels: [{name: 'series', type: 'int', transport: {kind: 'int'}}],
          },
        ],
      },
    });
    const publications: Parameters<OutputSink['publish']>[0][] = [];
    const sink: OutputSink = {
      capabilities: {effects: 'none'},
      declare() {},
      publish(publication) {
        publications.push(publication);
      },
    };
    const execution = await bind(module, {
      params: {},
      provider,
      sink,
      timeNow: 0,
    });

    await execution.runAll();

    expect(publications).toEqual([
      {
        row: 0,
        outputs: [{outputId: 0, channels: [17]}],
        effects: [],
        provisional: false,
      },
    ]);
    execution.dispose();
  });
});
