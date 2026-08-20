// Purpose: Struct-reference runtime contracts — fresh identity, shared mutation, typed-empty reads, transaction rollback, nominal checks, and cyclic reachability.

import {describe, expect, test} from 'vitest';
import {HeapArena} from './heap';
import {StructStorageRuntime} from './struct-storage';
import {
  type AggregateLayoutManifest,
  ValueLayoutRegistry,
} from './value-layout';

const INT = 0;
const BOOL = 1;
const STRING = 2;
const CHILD = 3;
const PARENT = 4;
const NODE = 5;

const MANIFEST = {
  layouts: [
    {kind: 'number', numeric: 'int'},
    {kind: 'boolean'},
    {kind: 'nullable-scalar', scalar: 'string'},
    {
      kind: 'struct',
      name: 'Child',
      fields: [{name: 'value', layout: INT}],
    },
    {
      kind: 'struct',
      name: 'Parent',
      fields: [
        {name: 'child', layout: CHILD},
        {name: 'enabled', layout: BOOL},
        {name: 'label', layout: STRING},
      ],
    },
    {
      kind: 'struct',
      name: 'Node',
      fields: [{name: 'next', layout: NODE}],
    },
  ],
} as const satisfies AggregateLayoutManifest;

function harness() {
  const heap = new HeapArena();
  const layouts = new ValueLayoutRegistry(MANIFEST);
  const structs = new StructStorageRuntime(heap, layouts);
  return {heap, layouts, structs};
}

describe('struct storage', () => {
  test('na field reads return the exact field typed empty', () => {
    const {structs} = harness();
    expect(structs.field(null, PARENT, 0)).toBeNull();
    expect(structs.field(null, PARENT, 1)).toBe(false);
    expect(structs.field(null, PARENT, 2)).toBeNull();
    expect(Number.isNaN(structs.field(null, CHILD, 0) as number)).toBe(true);
  });

  test('assignment aliases one body while fresh construction has new identity', () => {
    const {heap, structs} = harness();
    const transaction = heap.beginTransaction('row');
    const a = structs.newStruct(transaction, CHILD, [1]);
    const alias = a;
    const other = structs.newStruct(transaction, CHILD, [1]);
    structs.storeField(transaction, alias, CHILD, 0, 9);
    expect(structs.field(a, CHILD, 0)).toBe(9);
    expect(structs.field(other, CHILD, 0)).toBe(1);
    transaction.prepareCommit([a, other]).commit();
  });

  test('abort restores committed fields and invalidates tentative objects', () => {
    const {heap, structs} = harness();
    const first = heap.beginTransaction('first');
    const child = structs.newStruct(first, CHILD, [1]);
    first.prepareCommit([child]).commit();

    const failed = heap.beginTransaction('failed');
    structs.storeField(failed, child, CHILD, 0, 2);
    const tentative = structs.newStruct(failed, CHILD, [3]);
    failed.abort();
    expect(structs.field(child, CHILD, 0)).toBe(1);
    expect(() => structs.field(tentative, CHILD, 0)).toThrow('stale');
  });

  test('nominal mismatch and writes through na fail', () => {
    const {heap, structs} = harness();
    const transaction = heap.beginTransaction('row');
    const child = structs.newStruct(transaction, CHILD, [1]);
    expect(() => structs.field(child, PARENT, 0)).toThrow(
      'VALUE_LAYOUT_MISMATCH',
    );
    expect(() => structs.requireStruct(null, CHILD)).toThrow('NA_STRUCT_WRITE');
    expect(() => structs.newStruct(transaction, CHILD, ['wrong'])).toThrow(
      'VALUE_LAYOUT_MISMATCH',
    );
    transaction.abort();
  });

  test('recursive structs are finite and cycles remain reachable', () => {
    const {heap, structs} = harness();
    const transaction = heap.beginTransaction('row');
    const left = structs.newStruct(transaction, NODE, [null]);
    const right = structs.newStruct(transaction, NODE, [left]);
    structs.storeField(transaction, left, NODE, 0, right);
    transaction.prepareCommit([left]).commit();
    heap.collect([left]);
    expect(heap.stats().retainedCells).toBe(2);
    expect(structs.field(left, NODE, 0)).toBe(right);
    expect(structs.field(right, NODE, 0)).toBe(left);
  });
});
