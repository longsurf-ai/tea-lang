// Purpose: Observable array, matrix, ordered-map, nesting, user-value, snapshot, and eager-copy-model conformance tests.

import {describe, expect, test} from 'bun:test';
import {
  ExecutionError,
  type CollectionValue,
  type UserTypeValue,
  type Value,
} from '../abi';
import {HeapArena, type HeapAttempt, type StorageRef} from '../heap';
import {newUserValue, rebuildUserPath} from '../user-value';
import {
  ValueLayoutRegistry,
  visitRuntimeValueStorageRefs,
  type AggregateLayoutManifest,
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

const MANIFEST = {
  layouts: [
    {kind: 'number', numeric: 'int'},
    {kind: 'number', numeric: 'float'},
    {kind: 'boolean'},
    {kind: 'nullable-scalar', scalar: 'string'},
    {
      kind: 'user-type',
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
      kind: 'user-type',
      name: 'Holder',
      fields: [{name: 'values', layout: INTS}],
    },
  ],
} as const satisfies AggregateLayoutManifest;

interface Harness {
  readonly heap: HeapArena;
  readonly layouts: ValueLayoutRegistry;
  readonly collections: CollectionRuntime;
}

function harness(maxElements = 100): Harness {
  const heap = new HeapArena();
  const layouts = new ValueLayoutRegistry(MANIFEST);
  return {
    heap,
    layouts,
    collections: new CollectionRuntime(heap, layouts, maxElements),
  };
}

function roots(values: readonly Value[]): StorageRef[] {
  const result: StorageRef[] = [];
  values.forEach(value =>
    visitRuntimeValueStorageRefs(value, ref => result.push(ref)),
  );
  return result;
}

function publish(attempt: HeapAttempt, values: readonly Value[]): void {
  attempt.preparePublication(roots(values)).publish();
}

function construct(
  h: Harness,
  operation: 'array.from' | 'array.new' | 'matrix.new' | 'map.new',
  layout: number,
  args: readonly Value[],
): CollectionValue {
  const attempt = h.heap.beginAttempt(operation);
  const value = h.collections.call(attempt, operation, layout, args);
  publish(attempt, [value]);
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
  const attempt = h.heap.beginAttempt(operation);
  const value = h.collections.call(attempt, operation, layout, args);
  attempt.abort();
  return value;
}

describe('array values', () => {
  test('iterating a typed-empty collection reports NA_COLLECTION', () => {
    const h = harness();
    expect(() => h.collections.entries(null)).toThrow(
      expect.objectContaining({code: 'NA_COLLECTION'}),
    );
  });

  test('assignment and retained history headers stay isolated', () => {
    const h = harness();
    const a = construct(h, 'array.from', INTS, [1, 2]);
    const attempt = h.heap.beginAttempt('push');
    const pushed = h.collections.mutate(attempt, 'array.push', INTS, a, [3]);
    const b = pushed.replacement;
    publish(attempt, [a, b]);

    expect(h.collections.entries(a)).toEqual([1, 2]);
    expect(h.collections.entries(b)).toEqual([1, 2, 3]);
    expect(read(h, 'array.size', INT, [a])).toBe(2);
    expect(read(h, 'array.size', INT, [b])).toBe(3);
  });

  test('element access guards the exact generated result layout', () => {
    const h = harness();
    const array = construct(h, 'array.from', INTS, [1]);
    const attempt = h.heap.beginAttempt('wrong result layout');
    expect(() =>
      h.collections.call(attempt, 'array.get', FLOAT, [array, 0]),
    ).toThrow('expected 0');
    attempt.abort();
  });

  test('pop and clear remove logical high-water slots', () => {
    const h = harness();
    const original = construct(h, 'array.from', INTS, [1, 2, 99]);
    const popAttempt = h.heap.beginAttempt('pop');
    const popped = h.collections.mutate(
      popAttempt,
      'array.pop',
      INTS,
      original,
      [],
    );
    publish(popAttempt, [original, popped.replacement]);
    expect(popped.result).toBe(99);
    expect(h.collections.entries(popped.replacement)).toEqual([1, 2]);

    const pushAttempt = h.heap.beginAttempt('push');
    const pushed = h.collections.mutate(
      pushAttempt,
      'array.push',
      INTS,
      popped.replacement,
      [3],
    );
    publish(pushAttempt, [original, pushed.replacement]);
    expect(h.collections.entries(pushed.replacement)).toEqual([1, 2, 3]);

    const clearAttempt = h.heap.beginAttempt('clear');
    const cleared = h.collections.mutate(
      clearAttempt,
      'array.clear',
      INTS,
      pushed.replacement,
      [],
    );
    publish(clearAttempt, [original, cleared.replacement]);
    expect(h.collections.entries(cleared.replacement)).toEqual([]);
    expect(h.collections.entries(original)).toEqual([1, 2, 99]);
  });

  test('snapshot iteration is complete-header stable', () => {
    const h = harness();
    const value = construct(h, 'array.from', INTS, [1, 2]);
    const snapshot = h.collections.entries(value);
    const attempt = h.heap.beginAttempt('push');
    const mutation = h.collections.mutate(
      attempt,
      'array.push',
      INTS,
      value,
      [3],
    );
    publish(attempt, [value, mutation.replacement]);
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
      const attempt = h.heap.beginAttempt(step);
      if (model.length === 0 || seed % 3 === 0) {
        const value = seed % 97;
        const mutation = h.collections.mutate(
          attempt,
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
          attempt,
          'array.set',
          INTS,
          current,
          [at, value],
        );
        current = mutation.replacement;
        model[at] = value;
      } else {
        const mutation = h.collections.mutate(
          attempt,
          'array.pop',
          INTS,
          current,
          [],
        );
        expect(mutation.result).toBe(model.pop());
        current = mutation.replacement;
      }
      publish(attempt, [...versions.map(version => version.value), current]);
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
    const attempt = h.heap.beginAttempt('matrix.set');
    const changed = h.collections.mutate(
      attempt,
      'matrix.set',
      MATRIX,
      matrix,
      [0, 1, 9],
    );
    publish(attempt, [matrix, changed.replacement]);
    expect(read(h, 'matrix.get', INT, [matrix, 0, 1])).toBe(1);
    expect(read(h, 'matrix.get', INT, [changed.replacement, 0, 1])).toBe(9);

    const rowAttempt = h.heap.beginAttempt('matrix.row');
    const row = h.collections.call(rowAttempt, 'matrix.row', INTS, [
      changed.replacement,
      0,
    ]);
    publish(rowAttempt, [changed.replacement, row]);
    expect(h.collections.entries(row)).toEqual([1, 9]);
  });

  test('invalid shapes and bounds use stable codes', () => {
    const h = harness();
    const attempt = h.heap.beginAttempt('bad shape');
    expect(() =>
      h.collections.call(attempt, 'matrix.new', MATRIX, [-1, 2, 0]),
    ).toThrow('INVALID_SHAPE');
    attempt.abort();
    const matrix = construct(h, 'matrix.new', MATRIX, [1, 1, 0]);
    expect(() => read(h, 'matrix.get', INT, [matrix, 1, 0])).toThrow(
      'INDEX_OUT_OF_BOUNDS',
    );
  });

  test('empty projections still guard their array element layout', () => {
    const h = harness();
    const matrix = construct(h, 'matrix.new', MATRIX, [1, 0, 0]);
    const attempt = h.heap.beginAttempt('wrong projection layout');
    expect(() =>
      h.collections.call(attempt, 'matrix.row', STRINGS, [matrix, 0]),
    ).toThrow('expected 0');
    attempt.abort();
  });
});

describe('ordered map values', () => {
  test('empty key/value projections guard their exact element layout', () => {
    const h = harness();
    const map = construct(h, 'map.new', MAP, []);
    const attempt = h.heap.beginAttempt('wrong map projection layout');
    expect(() => h.collections.call(attempt, 'map.keys', INTS, [map])).toThrow(
      `expected ${STRING}`,
    );
    attempt.abort();
  });

  test('replacement keeps order; remove and reinsert moves to the end', () => {
    const h = harness();
    let value = construct(h, 'map.new', MAP, []);
    for (const [key, item] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const) {
      const attempt = h.heap.beginAttempt(`put ${key}`);
      const mutation = h.collections.mutate(attempt, 'map.put', MAP, value, [
        key,
        item,
      ]);
      value = mutation.replacement;
      publish(attempt, [value]);
    }
    const replace = h.heap.beginAttempt('replace');
    value = h.collections.mutate(replace, 'map.put', MAP, value, [
      'b',
      20,
    ]).replacement;
    publish(replace, [value]);
    expect(h.collections.entries(value)).toEqual([
      ['a', 1],
      ['b', 20],
      ['c', 3],
    ]);

    const remove = h.heap.beginAttempt('remove');
    const removed = h.collections.mutate(remove, 'map.remove', MAP, value, [
      'b',
    ]);
    value = removed.replacement;
    publish(remove, [value]);
    expect(removed.result).toBe(20);
    const reinsert = h.heap.beginAttempt('reinsert');
    value = h.collections.mutate(reinsert, 'map.put', MAP, value, [
      'b',
      21,
    ]).replacement;
    publish(reinsert, [value]);
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
    const put = h.heap.beginAttempt('put');
    const filled = h.collections.mutate(put, 'map.put', MAP, map, [
      'a',
      1,
    ]).replacement;
    publish(put, [map, filled]);

    const keysAttempt = h.heap.beginAttempt('keys');
    const keys = h.collections.call(keysAttempt, 'map.keys', STRINGS, [filled]);
    const values = h.collections.call(keysAttempt, 'map.values', INTS, [
      filled,
    ]);
    publish(keysAttempt, [filled, keys, values]);
    expect(h.collections.entries(keys)).toEqual(['a']);
    expect(h.collections.entries(values)).toEqual([1]);
  });

  test('na keys and na collections fail with stable codes', () => {
    const h = harness();
    const map = construct(h, 'map.new', MAP, []);
    const attempt = h.heap.beginAttempt('bad key');
    expect(() =>
      h.collections.mutate(attempt, 'map.put', MAP, map, [null, 1]),
    ).toThrow('INVALID_MAP_KEY');
    attempt.abort();
    const readAttempt = h.heap.beginAttempt('na collection');
    expect(() =>
      h.collections.call(readAttempt, 'array.size', INT, [null]),
    ).toThrow('NA_COLLECTION');
    readAttempt.abort();
  });
});

describe('user values and collection nesting', () => {
  test('Heap bytes charge layout-aware inline values and collection headers', () => {
    const pointsHarness = harness();
    const point = newUserValue(pointsHarness.layouts, POINT, [1, 2]);
    construct(pointsHarness, 'array.from', POINTS, [point]);
    expect(pointsHarness.heap.stats().retainedLogicalBytes).toBe(48);

    const nestedHarness = harness();
    const inner = construct(nestedHarness, 'array.from', INTS, [1]);
    construct(nestedHarness, 'array.from', ARRAYS, [inner]);
    // inner: 16 + int(8); outer: 16 + array header(32).
    expect(nestedHarness.heap.stats().retainedLogicalBytes).toBe(72);
  });

  test('collection<UserType> requires explicit get-modify-set', () => {
    const h = harness();
    const point = newUserValue(h.layouts, POINT, [1, 2]);
    const points = construct(h, 'array.from', POINTS, [point]);
    const got = read(h, 'array.get', POINT, [points, 0]) as UserTypeValue;
    const changed = rebuildUserPath(h.layouts, got, POINT, [0], 9);
    expect(
      (read(h, 'array.get', POINT, [points, 0]) as UserTypeValue).fields,
    ).toEqual([1, 2]);

    const attempt = h.heap.beginAttempt('writeback');
    const written = h.collections.mutate(attempt, 'array.set', POINTS, points, [
      0,
      changed,
    ]);
    publish(attempt, [points, written.replacement]);
    expect(
      (read(h, 'array.get', POINT, [written.replacement, 0]) as UserTypeValue)
        .fields,
    ).toEqual([9, 2]);
    expect(point.fields).toEqual([1, 2]);
  });

  test('UserType containing a collection copies the header by value', () => {
    const h = harness();
    const values = construct(h, 'array.from', INTS, [1]);
    const a = newUserValue(h.layouts, HOLDER, [values]);
    const push = h.heap.beginAttempt('nested push');
    const changed = h.collections.mutate(
      push,
      'array.push',
      INTS,
      a.fields[0],
      [2],
    );
    const b = rebuildUserPath(h.layouts, a, HOLDER, [0], changed.replacement);
    publish(push, [a, b]);
    expect(h.collections.entries(a.fields[0])).toEqual([1]);
    expect(h.collections.entries((b as UserTypeValue).fields[0])).toEqual([
      1, 2,
    ]);
  });

  test('nested collection headers store values without a boxing boundary', () => {
    const h = harness();
    const inner = construct(h, 'array.from', INTS, [1]);
    const outer = construct(h, 'array.from', ARRAYS, [inner]);
    const nested = read(h, 'array.get', INTS, [outer, 0]);
    const push = h.heap.beginAttempt('nested');
    const changed = h.collections.mutate(push, 'array.push', INTS, nested, [2]);
    publish(push, [outer, changed.replacement]);
    expect(
      h.collections.entries(read(h, 'array.get', INTS, [outer, 0])),
    ).toEqual([1]);
    expect(h.collections.entries(changed.replacement)).toEqual([1, 2]);
  });

  test('removed nested storage is collected and aborted appends cannot resurrect it', () => {
    const h = harness();
    const oldChild = construct(h, 'array.from', INTS, [1]);
    const oldOuter = construct(h, 'array.from', ARRAYS, [oldChild]);

    const replace = h.heap.beginAttempt('replace nested child');
    const currentChild = h.collections.call(replace, 'array.from', INTS, [2]);
    const currentOuter = h.collections.mutate(
      replace,
      'array.set',
      ARRAYS,
      oldOuter,
      [0, currentChild],
    ).replacement;
    publish(replace, [currentOuter]);
    h.heap.collect(roots([currentOuter]));

    // The outer storage traces its nested collection header. The replacement
    // stays live while both removed backing stores are now unreachable.
    expect(h.collections.entries(currentChild)).toEqual([2]);
    expect(() => h.collections.entries(oldChild)).toThrow('stale StorageRef');
    expect(() => h.collections.entries(oldOuter)).toThrow('stale StorageRef');

    const failed = h.heap.beginAttempt('aborted high-water append');
    const highWater = h.collections.mutate(
      failed,
      'array.push',
      INTS,
      currentChild,
      [99],
    ).replacement;
    failed.abort();
    expect(() => h.collections.entries(highWater)).toThrow('stale StorageRef');

    const retry = h.heap.beginAttempt('retry append');
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
    publish(retry, [retriedOuter]);
    h.heap.collect(roots([retriedOuter]));

    const nested = read(h, 'array.get', INTS, [retriedOuter, 0]);
    expect(h.collections.entries(nested)).toEqual([2, 3]);
    expect(h.heap.stats()).toMatchObject({
      publishedCells: 2,
      retainedCells: 2,
    });
  });

  test('collection element limits fail before a replacement is published', () => {
    const h = harness(1);
    const array = construct(h, 'array.from', INTS, [1]);
    const attempt = h.heap.beginAttempt('overflow');
    expect(() =>
      h.collections.mutate(attempt, 'array.push', INTS, array, [2]),
    ).toThrow(ExecutionError);
    attempt.abort();
    expect(h.collections.entries(array)).toEqual([1]);
  });
});

void FLOAT;
void BOOL;
