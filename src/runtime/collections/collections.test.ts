// Purpose: Observable array, matrix, ordered-map, nesting, struct-reference, snapshot, and eager-copy-model conformance tests.

import {describe, expect, test} from 'vitest';
import {ExecutionError, type CollectionValue, type Value} from '../abi';
import {ArenaHeap, type HeapTransaction, type Ref} from '../heap';
import {StructStorageRuntime, type StructRef} from '../struct-storage';
import {
  ValueLayoutRegistry,
  visitRuntimeValueRefs,
  type ValueLayout,
} from '../value-layout';
import {CollectionRuntime} from './index';

const INT = 0;
const FLOAT = 1;
const BOOL = 2;
const STRING = 3;
const POINT = 4;
const INTS = 5;
const POINTS = 6;
const MATRIX = 7;
const MAP = 8;
const STRINGS = 9;
const ARRAYS = 10;
const HOLDER = 11;

const MANIFEST = [
  {kind: 'number', numeric: 'int'},
  {kind: 'number', numeric: 'float'},
  {kind: 'boolean'},
  {kind: 'nullable-scalar', scalar: 'string'},
  {
    kind: 'struct',
    name: 'Point',
    fields: [
      {name: 'x', layout: INT},
      {name: 'y', layout: INT},
    ],
  },
  {kind: 'array', element: INT},
  {kind: 'array', element: POINT},
  {kind: 'matrix', element: INT},
  {kind: 'map', key: STRING, value: INT},
  {kind: 'array', element: STRING},
  {kind: 'array', element: INTS},
  {
    kind: 'struct',
    name: 'Holder',
    fields: [{name: 'values', layout: INTS}],
  },
] as const satisfies readonly ValueLayout[];

interface Harness {
  readonly heap: ArenaHeap;
  readonly layouts: ValueLayoutRegistry;
  readonly collections: CollectionRuntime;
  readonly structs: StructStorageRuntime;
}

function harness(maxElements = 100): Harness {
  const heap = new ArenaHeap();
  const layouts = new ValueLayoutRegistry(MANIFEST);
  const structs = new StructStorageRuntime(heap, layouts);
  return {
    heap,
    layouts,
    structs,
    collections: new CollectionRuntime(heap, layouts, maxElements, structs),
  };
}

function constructStruct(
  h: Harness,
  layout: number,
  fields: readonly Value[],
): StructRef {
  const transaction = h.heap.begin(`struct:${layout}`);
  const value = h.structs.newStruct(transaction, layout, fields);
  commit(transaction, [value]);
  return value;
}

function roots(values: readonly Value[]): Ref[] {
  const result: Ref[] = [];
  values.forEach(value =>
    visitRuntimeValueRefs(value, ref => result.push(ref)),
  );
  return result;
}

function commit(transaction: HeapTransaction, values: readonly Value[]): void {
  void values;
  transaction.commit();
}

function construct(
  h: Harness,
  operation: 'array.from' | 'array.new' | 'matrix.new' | 'map.new',
  layout: number,
  args: readonly Value[],
): CollectionValue {
  const transaction = h.heap.begin(operation);
  const value = h.collections.call(transaction, operation, layout, args);
  commit(transaction, [value]);
  return value as CollectionValue;
}

function read(
  h: Harness,
  operation:
    | 'array.size'
    | 'array.get'
    | 'matrix.get'
    | 'matrix.row'
    | 'map.get'
    | 'map.keys'
    | 'map.values',
  layout: number,
  args: readonly Value[],
): Value {
  const transaction = h.heap.begin(operation);
  const value = h.collections.call(transaction, operation, layout, args);
  transaction.abort();
  return value;
}

describe('array values', () => {
  test('iterating a typed-empty collection reports NA_COLLECTION', () => {
    const h = harness();
    expect(() => h.collections.entries(null)).toThrow(
      expect.objectContaining({code: 'NA_COLLECTION'}),
    );
  });

  test('array.new(size) fills with the element layout typed empty', () => {
    const h = harness();
    const ints = construct(h, 'array.new', INTS, [2]);
    const points = construct(h, 'array.new', POINTS, [2]);
    const intValues = h.collections.entries(ints);
    expect(intValues).toHaveLength(2);
    expect(intValues.every(value => Number.isNaN(value as number))).toBe(true);
    expect(h.collections.entries(points)).toEqual([null, null]);
  });

  test('assignment and retained history headers stay isolated', () => {
    const h = harness();
    const a = construct(h, 'array.from', INTS, [1, 2]);
    const transaction = h.heap.begin('push');
    const pushed = h.collections.mutate(
      transaction,
      'array.push',
      INTS,
      a,
      [3],
    );
    const b = pushed.replacement;
    commit(transaction, [a, b]);

    expect(h.collections.entries(a)).toEqual([1, 2]);
    expect(h.collections.entries(b)).toEqual([1, 2, 3]);
    expect(read(h, 'array.size', INT, [a])).toBe(2);
    expect(read(h, 'array.size', INT, [b])).toBe(3);
  });

  test('element access guards the exact generated result layout', () => {
    const h = harness();
    const array = construct(h, 'array.from', INTS, [1]);
    const transaction = h.heap.begin('wrong result layout');
    expect(() =>
      h.collections.call(transaction, 'array.get', FLOAT, [array, 0]),
    ).toThrow('expected 0');
    transaction.abort();
  });

  test('pop and clear remove logical high-water slots', () => {
    const h = harness();
    const original = construct(h, 'array.from', INTS, [1, 2, 99]);
    const popTransaction = h.heap.begin('pop');
    const popped = h.collections.mutate(
      popTransaction,
      'array.pop',
      INTS,
      original,
      [],
    );
    commit(popTransaction, [original, popped.replacement]);
    expect(popped.result).toBe(99);
    expect(h.collections.entries(popped.replacement)).toEqual([1, 2]);

    const pushTransaction = h.heap.begin('push');
    const pushed = h.collections.mutate(
      pushTransaction,
      'array.push',
      INTS,
      popped.replacement,
      [3],
    );
    commit(pushTransaction, [original, pushed.replacement]);
    expect(h.collections.entries(pushed.replacement)).toEqual([1, 2, 3]);

    const clearTransaction = h.heap.begin('clear');
    const cleared = h.collections.mutate(
      clearTransaction,
      'array.clear',
      INTS,
      pushed.replacement,
      [],
    );
    commit(clearTransaction, [original, cleared.replacement]);
    expect(h.collections.entries(cleared.replacement)).toEqual([]);
    expect(h.collections.entries(original)).toEqual([1, 2, 99]);
  });

  test('snapshot iteration is complete-header stable', () => {
    const h = harness();
    const value = construct(h, 'array.from', INTS, [1, 2]);
    const snapshot = h.collections.entries(value);
    const transaction = h.heap.begin('push');
    const mutation = h.collections.mutate(
      transaction,
      'array.push',
      INTS,
      value,
      [3],
    );
    commit(transaction, [value, mutation.replacement]);
    expect(snapshot).toEqual([1, 2]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('random mutations match an eager-copy reference and preserve every version', () => {
    const h = harness(1_000);
    let current = construct(h, 'array.from', INTS, []);
    const model: number[] = [];
    const versions: {value: CollectionValue; model: number[]}[] = [];
    let seed = 17;
    for (let step = 0; step < 80; step += 1) {
      versions.push({value: current, model: [...model]});
      seed = (seed * 48_271) % 2_147_483_647;
      const transaction = h.heap.begin(step);
      if (model.length === 0 || seed % 3 === 0) {
        const value = seed % 97;
        const mutation = h.collections.mutate(
          transaction,
          'array.push',
          INTS,
          current,
          [value],
        );
        current = mutation.replacement;
        model.push(value);
      } else if (seed % 3 === 1) {
        const at = seed % model.length;
        const value = (seed + step) % 101;
        const mutation = h.collections.mutate(
          transaction,
          'array.set',
          INTS,
          current,
          [at, value],
        );
        current = mutation.replacement;
        model[at] = value;
      } else {
        const mutation = h.collections.mutate(
          transaction,
          'array.pop',
          INTS,
          current,
          [],
        );
        expect(mutation.result).toBe(model.pop());
        current = mutation.replacement;
      }
      commit(transaction, [...versions.map(version => version.value), current]);
    }
    expect(h.collections.entries(current)).toEqual(model);
    versions.forEach(version =>
      expect(h.collections.entries(version.value)).toEqual(version.model),
    );
  });
});

describe('matrix values', () => {
  test('shape is fixed and row projections are independent arrays', () => {
    const h = harness();
    const matrix = construct(h, 'matrix.new', MATRIX, [2, 2, 1]);
    const transaction = h.heap.begin('matrix.set');
    const changed = h.collections.mutate(
      transaction,
      'matrix.set',
      MATRIX,
      matrix,
      [0, 1, 9],
    );
    commit(transaction, [matrix, changed.replacement]);
    expect(read(h, 'matrix.get', INT, [matrix, 0, 1])).toBe(1);
    expect(read(h, 'matrix.get', INT, [changed.replacement, 0, 1])).toBe(9);

    const rowTransaction = h.heap.begin('matrix.row');
    const row = h.collections.call(rowTransaction, 'matrix.row', INTS, [
      changed.replacement,
      0,
    ]);
    commit(rowTransaction, [changed.replacement, row]);
    expect(h.collections.entries(row)).toEqual([1, 9]);
  });

  test('invalid shapes and bounds use stable codes', () => {
    const h = harness();
    const transaction = h.heap.begin('bad shape');
    expect(() =>
      h.collections.call(transaction, 'matrix.new', MATRIX, [-1, 2, 0]),
    ).toThrow('INVALID_SHAPE');
    transaction.abort();
    const matrix = construct(h, 'matrix.new', MATRIX, [1, 1, 0]);
    expect(() => read(h, 'matrix.get', INT, [matrix, 1, 0])).toThrow(
      'INDEX_OUT_OF_BOUNDS',
    );
  });

  test('empty projections still guard their array element layout', () => {
    const h = harness();
    const matrix = construct(h, 'matrix.new', MATRIX, [1, 0, 0]);
    const transaction = h.heap.begin('wrong projection layout');
    expect(() =>
      h.collections.call(transaction, 'matrix.row', STRINGS, [matrix, 0]),
    ).toThrow('expected 0');
    transaction.abort();
  });
});

describe('ordered map values', () => {
  test('empty key/value projections guard their exact element layout', () => {
    const h = harness();
    const map = construct(h, 'map.new', MAP, []);
    const transaction = h.heap.begin('wrong map projection layout');
    expect(() =>
      h.collections.call(transaction, 'map.keys', INTS, [map]),
    ).toThrow(`expected ${STRING}`);
    transaction.abort();
  });

  test('replacement keeps order; remove and reinsert moves to the end', () => {
    const h = harness();
    let value = construct(h, 'map.new', MAP, []);
    for (const [key, item] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const) {
      const transaction = h.heap.begin(`put ${key}`);
      const mutation = h.collections.mutate(
        transaction,
        'map.put',
        MAP,
        value,
        [key, item],
      );
      value = mutation.replacement;
      commit(transaction, [value]);
    }
    const replace = h.heap.begin('replace');
    value = h.collections.mutate(replace, 'map.put', MAP, value, [
      'b',
      20,
    ]).replacement;
    commit(replace, [value]);
    expect(h.collections.entries(value)).toEqual([
      ['a', 1],
      ['b', 20],
      ['c', 3],
    ]);

    const remove = h.heap.begin('remove');
    const removed = h.collections.mutate(remove, 'map.remove', MAP, value, [
      'b',
    ]);
    value = removed.replacement;
    commit(remove, [value]);
    expect(removed.result).toBe(20);
    const reinsert = h.heap.begin('reinsert');
    value = h.collections.mutate(reinsert, 'map.put', MAP, value, [
      'b',
      21,
    ]).replacement;
    commit(reinsert, [value]);
    expect(h.collections.entries(value)).toEqual([
      ['a', 1],
      ['c', 3],
      ['b', 21],
    ]);
  });

  test('missing values are typed empty and keys/values are aligned snapshots', () => {
    const h = harness();
    const map = construct(h, 'map.new', MAP, []);
    expect(
      Number.isNaN(read(h, 'map.get', INT, [map, 'missing']) as number),
    ).toBe(true);
    const put = h.heap.begin('put');
    const filled = h.collections.mutate(put, 'map.put', MAP, map, [
      'a',
      1,
    ]).replacement;
    commit(put, [map, filled]);

    const keysTransaction = h.heap.begin('keys');
    const keys = h.collections.call(keysTransaction, 'map.keys', STRINGS, [
      filled,
    ]);
    const values = h.collections.call(keysTransaction, 'map.values', INTS, [
      filled,
    ]);
    commit(keysTransaction, [filled, keys, values]);
    expect(h.collections.entries(keys)).toEqual(['a']);
    expect(h.collections.entries(values)).toEqual([1]);
  });

  test('na keys and na collections fail with stable codes', () => {
    const h = harness();
    const map = construct(h, 'map.new', MAP, []);
    const transaction = h.heap.begin('bad key');
    expect(() =>
      h.collections.mutate(transaction, 'map.put', MAP, map, [null, 1]),
    ).toThrow('INVALID_MAP_KEY');
    transaction.abort();
    const readTransaction = h.heap.begin('na collection');
    expect(() =>
      h.collections.call(readTransaction, 'array.size', INT, [null]),
    ).toThrow('NA_COLLECTION');
    readTransaction.abort();
  });
});

describe('struct references and collection nesting', () => {
  test('Heap bytes charge struct bodies and fixed-width references', () => {
    const pointsHarness = harness();
    const point = constructStruct(pointsHarness, POINT, [1, 2]);
    const points = construct(pointsHarness, 'array.from', POINTS, [point]);
    pointsHarness.heap.replaceRoots(roots([points]));
    pointsHarness.heap.collect();
    // Point body: 16 + 2 ints; array backing: 16 + one Ref.
    expect(pointsHarness.heap.stats().retainedLogicalBytes).toBe(56);

    const nestedHarness = harness();
    const inner = construct(nestedHarness, 'array.from', INTS, [1]);
    const nested = construct(nestedHarness, 'array.from', ARRAYS, [inner]);
    nestedHarness.heap.replaceRoots(roots([nested]));
    nestedHarness.heap.collect();
    // inner: 16 + int(8); outer: 16 + array header(32).
    expect(nestedHarness.heap.stats().retainedLogicalBytes).toBe(72);
  });

  test('collections and historical headers share contained struct refs', () => {
    const h = harness();
    const point = constructStruct(h, POINT, [1, 2]);
    const points = construct(h, 'array.from', POINTS, [point]);
    const got = read(h, 'array.get', POINT, [points, 0]);
    const transaction = h.heap.begin('writeback');
    h.structs.storeField(transaction, got, POINT, 0, 9);
    commit(transaction, [points]);
    expect(h.structs.field(point, POINT, 0)).toBe(9);
    expect(
      h.structs.field(read(h, 'array.get', POINT, [points, 0]), POINT, 0),
    ).toBe(9);
  });

  test('a struct field keeps a collection header by value', () => {
    const h = harness();
    const values = construct(h, 'array.from', INTS, [1]);
    const holder = constructStruct(h, HOLDER, [values]);
    const before = h.structs.field(holder, HOLDER, 0);
    const push = h.heap.begin('nested push');
    const changed = h.collections.mutate(push, 'array.push', INTS, before, [2]);
    h.structs.storeField(push, holder, HOLDER, 0, changed.replacement);
    commit(push, [holder, before]);
    expect(h.collections.entries(before)).toEqual([1]);
    expect(h.collections.entries(h.structs.field(holder, HOLDER, 0))).toEqual([
      1, 2,
    ]);
  });

  test('nested collection headers store values without a boxing boundary', () => {
    const h = harness();
    const inner = construct(h, 'array.from', INTS, [1]);
    const outer = construct(h, 'array.from', ARRAYS, [inner]);
    const nested = read(h, 'array.get', INTS, [outer, 0]);
    const push = h.heap.begin('nested');
    const changed = h.collections.mutate(push, 'array.push', INTS, nested, [2]);
    commit(push, [outer, changed.replacement]);
    expect(
      h.collections.entries(read(h, 'array.get', INTS, [outer, 0])),
    ).toEqual([1]);
    expect(h.collections.entries(changed.replacement)).toEqual([1, 2]);
  });

  test('removed nested storage is collected and aborted appends cannot resurrect it', () => {
    const h = harness();
    const oldChild = construct(h, 'array.from', INTS, [1]);
    const oldOuter = construct(h, 'array.from', ARRAYS, [oldChild]);

    const replace = h.heap.begin('replace nested child');
    const currentChild = h.collections.call(replace, 'array.from', INTS, [2]);
    const currentOuter = h.collections.mutate(
      replace,
      'array.set',
      ARRAYS,
      oldOuter,
      [0, currentChild],
    ).replacement;
    commit(replace, [currentOuter]);
    h.heap.replaceRoots(roots([currentOuter]));
    h.heap.collect();

    // The outer storage traces its nested collection header. The replacement
    // stays live while both removed backing stores are now unreachable.
    expect(h.collections.entries(currentChild)).toEqual([2]);
    expect(() => h.collections.entries(oldChild)).toThrow('stale Ref');
    expect(() => h.collections.entries(oldOuter)).toThrow('stale Ref');

    const failed = h.heap.begin('aborted high-water append');
    const highWater = h.collections.mutate(
      failed,
      'array.push',
      INTS,
      currentChild,
      [99],
    ).replacement;
    failed.abort();
    expect(() => h.collections.entries(highWater)).toThrow('stale Ref');

    const retry = h.heap.begin('retry append');
    const retriedChild = h.collections.mutate(
      retry,
      'array.push',
      INTS,
      currentChild,
      [3],
    ).replacement;
    const retriedOuter = h.collections.mutate(
      retry,
      'array.set',
      ARRAYS,
      currentOuter,
      [0, retriedChild],
    ).replacement;
    commit(retry, [retriedOuter]);
    h.heap.replaceRoots(roots([retriedOuter]));
    h.heap.collect();

    const nested = read(h, 'array.get', INTS, [retriedOuter, 0]);
    expect(h.collections.entries(nested)).toEqual([2, 3]);
    expect(h.heap.stats()).toMatchObject({
      committedCells: 2,
      retainedCells: 2,
    });
  });

  test('collection element limits fail before a replacement is published', () => {
    const h = harness(1);
    const array = construct(h, 'array.from', INTS, [1]);
    const transaction = h.heap.begin('overflow');
    expect(() =>
      h.collections.mutate(transaction, 'array.push', INTS, array, [2]),
    ).toThrow(ExecutionError);
    transaction.abort();
    expect(h.collections.entries(array)).toEqual([1]);
  });
});

void FLOAT;
void BOOL;
