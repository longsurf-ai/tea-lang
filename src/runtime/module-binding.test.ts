// Purpose: Generated bind evaluation may use aggregate values inside one
// abort-only Heap transaction without leaking them into immutable facts.

import {describe, expect, test} from 'vitest';
import {ExecutionError} from './errors';
import {evaluateModuleBinding} from './module-binding';
import {RUNTIME_ABI_VERSION, type JSModule} from './module-abi';
import type {AggregateLayoutManifest} from './value-layout';

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
    const module = bindingModule((rt, _root) => {
      const values = rt.callCollection('array.from', ARRAY, [7]);
      const holder = rt.newStruct(HOLDER, [values, 1]);
      const ref = rt.requireStruct(holder, HOLDER);
      const mutation = rt.mutateCollection(
        'array.push',
        ARRAY,
        rt.structField(ref, HOLDER, 0),
        [9],
      );
      rt.storeStructField(ref, HOLDER, 0, mutation.replacement);
      rt.storeStructField(ref, HOLDER, 1, 5);
      const entries = rt.collectionEntries(rt.structField(ref, HOLDER, 0));
      rt.bindOutput(
        0,
        'price',
        Number(entries[1]) + Number(rt.structField(ref, HOLDER, 1)),
      );
    });

    const facts = evaluateModuleBinding(module, []);

    expect(facts.declaration.outputs[0].boundArgs).toEqual([
      {name: 'price', value: 14},
    ]);
    expect(Object.isFrozen(facts)).toBe(true);
  });

  test('preserves an ordinary fallible collection error from eager bind code', () => {
    const module = bindingModule(rt => {
      const empty = rt.callCollection('array.new', ARRAY, []);
      rt.callCollection('array.first', NUMBER, [empty]);
    });

    let thrown: unknown;
    try {
      evaluateModuleBinding(module, []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExecutionError);
    expect(thrown).toMatchObject({code: 'EMPTY_COLLECTION'});
  });
});

function bindingModule(bind: JSModule['bind']): JSModule {
  return {
    abi: RUNTIME_ABI_VERSION,
    aggregateLayouts: LAYOUTS,
    manifest: {
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
    },
    requests: [],
    init() {},
    bind,
    funcs: {},
    main() {},
  };
}
