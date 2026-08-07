// Purpose: Runtime boundary locks for explicit empty-value families and the finite-or-na numeric contract.

import {describe, expect, test} from 'bun:test';
import {Storage} from '../ir/node';
import {
  BindError,
  ValueClass,
  type DataProvider,
  type ManifestValue,
  type OutputSink,
  type ParamSpec,
  type ProviderContext,
  type TeaModule,
  type Value,
} from './abi';
import {bind} from './js-runtime';

class Sink implements OutputSink {
  readonly values: Value[][] = [];

  declare(): void {}

  emit(_row: number, _oid: number, values: readonly Value[]): void {
    this.values.push([...values]);
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
  abi: 2,
  manifest: {
    series: [],
    params: [],
    outputs: [
      {
        effect: 'probe',
        staticArgs: [],
        channels: [
          {name: 'numeric', type: 'float'},
          {name: 'reference', type: 'string'},
          {name: 'boolean', type: 'bool'},
        ],
      },
    ],
    frames: [
      {
        locals: [
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            valueClass: ValueClass.Numeric,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            valueClass: ValueClass.Reference,
          },
          {
            storage: Storage.PerBar,
            depth: {kind: 'none'},
            valueClass: ValueClass.Boolean,
          },
        ],
        subs: [],
      },
    ],
    requests: [],
  },
  requests: [],
  init() {},
  bind() {},
  inits: {},
  funcs: {},
  main(rt, fr) {
    rt.emit(0, 0, rt.read(fr, 0, 0));
    rt.emit(0, 1, rt.read(fr, 1, 0));
    rt.emit(0, 2, rt.read(fr, 2, 0));
  },
};

function paramModule(spec: ParamSpec): TeaModule {
  return {
    abi: 2,
    manifest: {
      series: [],
      params: [spec],
      outputs: [],
      frames: [{locals: [], subs: []}],
      requests: [],
    },
    requests: [],
    init() {},
    bind() {},
    inits: {},
    funcs: {},
    main() {},
  };
}

describe('runtime value contract', () => {
  test('empty history is numeric NaN, reference null, and bool false', async () => {
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
