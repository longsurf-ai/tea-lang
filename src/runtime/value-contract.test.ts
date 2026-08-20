// Purpose: Runtime boundary locks for explicit empty-value families and the finite-or-na numeric contract.

import {describe, expect, test} from 'vitest';
import {Storage} from '../ir/node';
import {
  BindError,
  type AggregateLayoutManifest,
  type BindInputs,
  type DataProvider,
  type ManifestValue,
  type OutputSink,
  type ParamSpec,
  type ProviderContext,
  RUNTIME_ABI_VERSION,
  type TeaModule,
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

const NUMBER_LAYOUT = 0;
const NULLABLE_LAYOUT = 1;
const BOOLEAN_LAYOUT = 2;
const TEST_LAYOUTS = {
  layouts: [
    {kind: 'number', numeric: 'float'},
    {kind: 'nullable-scalar', scalar: 'string'},
    {kind: 'boolean'},
  ],
} as const satisfies AggregateLayoutManifest;

class Sink implements OutputSink {
  readonly values: Value[][] = [];

  declare(): void {}

  publish(publication: Parameters<OutputSink['publish']>[0]): void {
    for (const output of publication.outputs) {
      this.values.push([...output.channels]);
    }
  }
}

function provider(context: ProviderContext): DataProvider {
  return {resolveContext: () => Promise.resolve(context)};
}

function context(value: number = 1): ProviderContext {
  return {
    rows: 1,
    axis: null,
    series: id => (id === 'close' ? {length: 1, at: () => value} : null),
    builtinValue: () => undefined,
  };
}

function param(
  name: string,
  type: ParamSpec['type'],
  defaultValue: ManifestValue,
): ParamSpec {
  return {
    name,
    title: null,
    type,
    control: 'auto',
    defaultValue,
    constraints: null,
    group: null,
    inline: null,
    tooltip: null,
    confirm: false,
    display: 'all',
    enumType: null,
    seriesSid: null,
  };
}

const EMPTY_VALUES_MODULE: TeaModule = {
  abi: RUNTIME_ABI_VERSION,
  aggregateLayouts: TEST_LAYOUTS,
  manifest: {
    series: [],
    builtin: [],
    params: [],
    outputs: [
      {
        effect: 'probe',
        staticArgs: [],
        channels: [
          {name: 'numeric', type: 'float', transport: {kind: 'float'}},
          {name: 'nullable', type: 'string', transport: {kind: 'string'}},
          {name: 'boolean', type: 'bool', transport: {kind: 'bool'}},
        ],
      },
    ],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            layout: NUMBER_LAYOUT,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            layout: NULLABLE_LAYOUT,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            layout: BOOLEAN_LAYOUT,
          },
        ],
        subs: [],
      },
    ],
    effects: [],
    requests: [],
  },
  requests: [],
  init() {},
  bind() {},
  funcs: {},
  main(rt, fr) {
    rt.emit(0, 0, rt.read(fr, 0, 0));
    rt.emit(0, 1, rt.read(fr, 1, 0));
    rt.emit(0, 2, rt.read(fr, 2, 0));
  },
};

function paramModule(spec: ParamSpec): TeaModule {
  return {
    abi: RUNTIME_ABI_VERSION,
    aggregateLayouts: TEST_LAYOUTS,
    manifest: {
      series: [],
      builtin: [],
      params: [spec],
      outputs: [],
      frames: [{locals: [], subs: []}],
      effects: [],
      requests: [],
    },
    requests: [],
    init() {},
    bind() {},
    funcs: {},
    main() {},
  };
}

describe('runtime value contract', () => {
  test('empty history is numeric NaN, nullable null, and bool false', async () => {
    const sink = new Sink();
    const bound = await bind(EMPTY_VALUES_MODULE, {
      params: {},
      provider: provider(context()),
      sink,
    });
    await bound.runAll();

    expect(Number.isNaN(sink.values[0][0] as number)).toBe(true);
    expect(sink.values[0][1]).toBeNull();
    expect(sink.values[0][2]).toBe(false);
  });

  test('invalid history offsets return each slot class empty value', async () => {
    const module: TeaModule = {
      ...EMPTY_VALUES_MODULE,
      main(rt, fr) {
        rt.emit(0, 0, rt.read(fr, 0, -1));
        rt.emit(0, 1, rt.read(fr, 1, NaN));
        rt.emit(0, 2, rt.read(fr, 2, 0.5));
      },
    };
    const sink = new Sink();
    const bound = await bind(module, {
      params: {},
      provider: provider(context()),
      sink,
    });
    await bound.runAll();

    expect(Number.isNaN(sink.values[0][0] as number)).toBe(true);
    expect(sink.values[0][1]).toBeNull();
    expect(sink.values[0][2]).toBe(false);
  });

  test('host numeric inputs reject NaN and both infinities', async () => {
    const module = paramModule(param('level', 'float', 1));
    const inputs = {provider: provider(context()), sink: new Sink()};
    for (const value of [NaN, Infinity, -Infinity]) {
      await expect(
        bind(module, {...inputs, params: {level: value}}),
      ).rejects.toThrow(BindError);
    }
  });

  test('host int inputs reject values outside the exact runtime domain', async () => {
    const module = paramModule(param('count', 'int', 1));
    await expect(
      bind(module, {
        params: {count: Number.MAX_SAFE_INTEGER + 1},
        provider: provider(context()),
        sink: new Sink(),
      }),
    ).rejects.toThrow(BindError);
  });

  test('host colors normalize once at the binding boundary', async () => {
    const module = paramModule(param('tone', 'color', '#FFFFFF'));
    const inputs = {provider: provider(context()), sink: new Sink()};
    for (const value of ['red', '#12345G']) {
      await expect(
        bind(module, {...inputs, params: {tone: value}}),
      ).rejects.toThrow(BindError);
    }
    const opaque = await bind(module, {
      ...inputs,
      params: {tone: '#ffffffFF'},
    });
    expect(opaque.inputs[0].value).toBe('#FFFFFF');
    const translucent = await bind(module, {
      ...inputs,
      params: {tone: '#12345678'},
    });
    expect(translucent.inputs[0].value).toBe('#12345678');
  });

  test('provider NaN is numeric na, but provider infinity is fatal', async () => {
    const module: TeaModule = {
      ...EMPTY_VALUES_MODULE,
      manifest: {
        ...EMPTY_VALUES_MODULE.manifest,
        series: [{id: 'close', depth: {kind: 'none'}}],
        frames: [{locals: [], subs: []}],
      },
      main(rt) {
        rt.emit(0, 0, rt.series(0, 0));
      },
    };

    const naSink = new Sink();
    const naBound = await bind(module, {
      params: {},
      provider: provider(context(NaN)),
      sink: naSink,
    });
    await naBound.runAll();
    expect(Number.isNaN(naSink.values[0][0] as number)).toBe(true);

    const infinite = await bind(module, {
      params: {},
      provider: provider(context(Infinity)),
      sink: new Sink(),
    });
    expect(() => infinite.executeRow(0, false)).toThrow(
      'provider series 0 returned a non-finite value at row 0',
    );
  });
});
