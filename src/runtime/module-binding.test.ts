// Purpose: Generated bind evaluation may use aggregate values inside one
// abort-only Heap transaction without leaking them into immutable facts.

import {describe, expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {CollectionRuntime} from './collections';
import {ExecutionError} from './errors';
import {ArenaHeap} from './heap';
import {loadModule} from './load';
import {evaluateModuleBinding} from './module-binding';
import {RUNTIME_ABI_VERSION, type JSModule} from './module-abi';
import {StructStorageRuntime} from './struct-storage';
import {
  type AggregateLayoutManifest,
  ValueLayoutRegistry,
} from './value-layout';
import type {ArrayValue} from './value';

const NUMBER = 0;
const ARRAY = 1;
const HOLDER = 2;
const LAYOUTS = {
  layouts: [
    {kind: 'number', numeric: 'int'},
    {kind: 'array', element: NUMBER},
    {
      kind: 'struct',
      name: 'Holder',
      fields: [
        {name: 'values', layout: ARRAY},
        {name: 'marker', layout: NUMBER},
      ],
    },
  ],
} as const satisfies AggregateLayoutManifest;

describe('module binding aggregates', () => {
  test('evaluates collection and struct operations into scalar bind facts', () => {
    const module = bindingModule(`
      const values = rt.callCollection('array.from', ${ARRAY}, [7]);
      const holder = rt.newStruct(${HOLDER}, [values, 1]);
      const ref = rt.requireStruct(holder, ${HOLDER});
      const mutation = rt.mutateCollection(
        'array.push',
        ${ARRAY},
        rt.structField(ref, ${HOLDER}, 0),
        [9]
      );
      rt.storeStructField(ref, ${HOLDER}, 0, mutation.replacement);
      rt.storeStructField(ref, ${HOLDER}, 1, 5);
      const entries = rt.collectionEntries(rt.structField(ref, ${HOLDER}, 0));
      rt.bindOutput(
        0,
        'price',
        Number(entries[1]) + Number(rt.structField(ref, ${HOLDER}, 1))
      );
    `);

    const facts = evaluateModuleBinding(module, []);

    expect(facts.declaration.outputs[0].boundArgs).toEqual([
      {name: 'price', value: 14},
    ]);
    expect(Object.isFrozen(facts)).toBe(true);
  });

  test('preserves an ordinary fallible collection error from eager bind code', () => {
    const module = bindingModule(`
      const empty = rt.callCollection('array.new', ${ARRAY}, []);
      rt.callCollection('array.first', ${NUMBER}, [empty]);
    `);

    let thrown: unknown;
    try {
      evaluateModuleBinding(module, []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExecutionError);
    expect(thrown).toMatchObject({code: 'EMPTY_COLLECTION'});
  });

  test('invalidates an aggregate that a generated closure tries to retain', () => {
    const module = bindingModule(`
      rt.bindOutput(
        0,
        'price',
        rt.callCollection('array.from', ${ARRAY}, [7])
      );
    `);
    const escaped = module.bind({params: []}).outputs[0]![0]!
      .value as ArrayValue;

    const heap = new ArenaHeap();
    const transaction = heap.begin('module-binding-test');
    const layouts = new ValueLayoutRegistry(LAYOUTS);
    const structs = new StructStorageRuntime(heap, layouts);
    const collections = new CollectionRuntime(heap, layouts, 100, structs);
    try {
      expect(() =>
        collections.call(transaction, 'array.first', NUMBER, [escaped!]),
      ).toThrow('Ref belongs to another Heap arena');
    } finally {
      transaction.abort();
      heap.dispose();
    }
  });
});

describe('generated pure binding', () => {
  test('accepts values and returns immutable data without an init phase', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = input.int(3)\nlevel = input.float(10)\nhline(level)\nplot(close[length])',
        ),
      ),
    );

    const binding = module.bind({params: [4, 25]});

    expect('init' in module).toBe(false);
    expect(binding.retention.series).toEqual([4]);
    expect(binding.activeParams).toEqual([true, true]);
    expect(binding.outputs[0]).toEqual([{name: 'price', value: 25}]);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  test('preserves sparse provider builtin visibility', () => {
    const module = loadModule(
      generate(mustBuild('length = timeframe.multiplier\nplot(close[length])')),
    );

    expect(() => module.bind({params: []})).toThrow(
      "builtin 'timeframe.multiplier' is not bind-visible",
    );
    expect(
      module.bind({params: [], builtins: new Map([[0, 7]])}).retention.series,
    ).toEqual([7]);
  });

  test('request children consume the compilation-global parameter vector', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = input.int(3)\nvalue = request.security("X", "D", close[length])\nplot(value)',
        ),
      ),
    );
    const child = module.requests[0]!;

    expect(child.manifest.params).toEqual([]);
    expect(child.bind({params: [6]}).retention.series).toEqual([6]);
  });
});

function bindingModule(body: string): JSModule {
  const manifest = {
    series: [],
    builtin: [],
    params: [],
    outputs: [
      {
        effect: 'hline',
        staticArgs: [],
        channels: [],
      },
    ],
    effects: [],
    frames: [{locals: [], subs: []}],
    requests: [],
  };
  return loadModule(`
    "use strict";
    const M = {
      abi: ${RUNTIME_ABI_VERSION},
      aggregateLayouts: ${JSON.stringify(LAYOUTS)},
      manifest: ${JSON.stringify(manifest)},
      requests: [],
      bind(values) {
        return $bind(M, values, (rt, fr) => {
          ${body}
        });
      },
      funcs: {},
      main() {},
    };
    return M;
  `);
}
