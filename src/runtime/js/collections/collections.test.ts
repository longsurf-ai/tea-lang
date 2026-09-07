// Persistent backing, exact generic values, ownership, and transaction failures.
import {expect, test} from 'vitest';
import {Value, bool, color, enumeration, float, int, text} from '../value';
import {ArrayValue, MatrixValue, MapValue, type Stored} from '../../value';
import type {Ref} from '../heap';
import {
  array,
  matrix,
  map,
  harness,
  call,
  mutate,
  arrayValues,
  mapValues,
  roots,
} from './testing';

const integer = int(NaN);
const integers = array(integer);
const strings = array(text(null));
const grid = matrix(integer);
const dictionary = map(text(null), integer);

class Point {
  constructor(
    readonly x: Value<number, 'int'>,
    readonly y: Value<number, 'int'>,
  ) {}
}
const pointType = new Value<Ref<Point> | null>(null, 'Point', undefined, {
  ctor: Point,
});

function point(h: ReturnType<typeof harness>, x = 1, y = 2) {
  using tx = h.heap.begin('point');
  const ref = h.structs.newStruct(tx, new Point(int(x), int(y)), 32);
  tx.commit();
  return pointType.withStored(ref);
}

test('empty collection element values survive construction and reads', () => {
  const h = harness();
  const value = call(h, 'array.new', integers, [int(2)]);
  expect(arrayValues(h, value)).toEqual([NaN, NaN]);
  expect(call(h, 'array.get', integer, [value, int(0)]).kind).toBe('int');
  const points = call(h, 'array.new', array(pointType), [int(2)]);
  expect(arrayValues(h, points)).toEqual([null, null]);
  expect(() => h.collections.entries(null)).toThrow('NA_COLLECTION');
});

test('array mutations and copies preserve previous headers and iteration snapshots', () => {
  const h = harness();
  const original = call(h, 'array.from', integers, [int(1), int(2)]);
  const snapshot = h.collections.entries(original.value!);
  const pushed = mutate(h, 'array.push', original, [int(99)]).replacement;
  const copied = call(h, 'array.copy', integers, [pushed]);
  const popped = mutate(h, 'array.pop', copied);
  expect(popped.result?.value).toBe(99);
  const cleared = mutate(h, 'array.clear', popped.replacement).replacement;
  expect(arrayValues(h, original)).toEqual([1, 2]);
  expect(arrayValues(h, pushed)).toEqual([1, 2, 99]);
  expect(arrayValues(h, popped.replacement)).toEqual([1, 2]);
  expect(arrayValues(h, cleared)).toEqual([]);
  expect(snapshot).toEqual([int(1), int(2)]);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(original.value)).toBe(true);
});

test('generic result checks cover empty projections as well as populated values', () => {
  const h = harness();
  const values = call(h, 'array.from', integers, [int(1)]);
  expect(() => call(h, 'array.get', float(NaN), [values, int(0)])).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
  const emptyGrid = call(h, 'matrix.new', grid, [int(1), int(0), int(0)]);
  expect(() => call(h, 'matrix.row', strings, [emptyGrid, int(0)])).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
  const emptyMap = call(h, 'map.new', dictionary);
  expect(() => call(h, 'map.keys', integers, [emptyMap])).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
  expect(() => mutate(h, 'array.push', values, [text('wrong')])).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
});

test('concrete headers reject invalid shapes before read-only operations can observe them', () => {
  const h = harness();
  const value = call(h, 'array.from', integers, [int(1)]).value!;
  expect(() => new ArrayValue(integer, value.storage, -1)).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
  expect(() => new ArrayValue(integer, value.storage, 1, 0)).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
  const m = call(h, 'matrix.new', grid, [int(1), int(1), int(0)]).value!;
  expect(() => new MatrixValue(integer, m.storage, 1.5, 1)).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
  const d = call(h, 'map.new', dictionary).value!;
  expect(() => new MapValue(text(null), integer, d.storage, -1)).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
});

test('matrix shape and independent projections survive later mutations', () => {
  const h = harness();
  const original = call(h, 'matrix.new', grid, [int(2), int(2), int(1)]);
  const changed = mutate(h, 'matrix.set', original, [
    int(0),
    int(1),
    int(9),
  ]).replacement;
  const row = call(h, 'matrix.row', integers, [changed, int(0)]);
  const column = call(h, 'matrix.column', integers, [changed, int(1)]);
  const filled = mutate(h, 'matrix.fill', changed, [int(7)]).replacement;
  expect(call(h, 'matrix.get', integer, [original, int(0), int(1)]).value).toBe(
    1,
  );
  expect(call(h, 'matrix.get', integer, [changed, int(0), int(1)]).value).toBe(
    9,
  );
  expect(call(h, 'matrix.get', integer, [filled, int(0), int(1)]).value).toBe(
    7,
  );
  expect(arrayValues(h, row)).toEqual([1, 9]);
  expect(arrayValues(h, column)).toEqual([9, 1]);
});

test('map replacement preserves order and reinsertion moves to the end', () => {
  const h = harness();
  let value = call(h, 'map.new', dictionary);
  for (const [key, item] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ] as const)
    value = mutate(h, 'map.put', value, [text(key), int(item)]).replacement;
  const original = value;
  value = mutate(h, 'map.put', value, [text('b'), int(20)]).replacement;
  expect(mapValues(h, value)).toEqual([
    ['a', 1],
    ['b', 20],
    ['c', 3],
  ]);
  const removed = mutate(h, 'map.remove', value, [text('b')]);
  expect(removed.result?.value).toBe(20);
  value = mutate(h, 'map.put', removed.replacement, [
    text('b'),
    int(21),
  ]).replacement;
  expect(mapValues(h, value)).toEqual([
    ['a', 1],
    ['c', 3],
    ['b', 21],
  ]);
  expect(mapValues(h, original)).toEqual([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  expect(arrayValues(h, call(h, 'map.keys', strings, [value]))).toEqual([
    'a',
    'c',
    'b',
  ]);
  expect(arrayValues(h, call(h, 'map.values', integers, [value]))).toEqual([
    1, 3, 21,
  ]);
});

test('map keys use color value equality and preserve stored null versus absence', () => {
  const h = harness();
  let colors = call(h, 'map.new', map(color(null), integer));
  colors = mutate(h, 'map.put', colors, [
    color('#ff0000ff'),
    int(1),
  ]).replacement;
  colors = mutate(h, 'map.put', colors, [color('#FF0000'), int(2)]).replacement;
  expect(call(h, 'map.size', integer, [colors]).value).toBe(1);
  expect(call(h, 'map.get', integer, [colors, color('#FF0000')]).value).toBe(2);
  let value = call(h, 'map.new', map(text(null), text(null)));
  expect(call(h, 'map.get', text(null), [value, text('key')]).value).toBeNull();
  expect(call(h, 'map.contains', bool(false), [value, text('key')]).value).toBe(
    false,
  );
  value = mutate(h, 'map.put', value, [text('key'), text(null)]).replacement;
  expect(call(h, 'map.get', text(null), [value, text('key')]).value).toBeNull();
  expect(call(h, 'map.contains', bool(false), [value, text('key')]).value).toBe(
    true,
  );
});

test('map key validation uses the declared enum domain and safe integer range', () => {
  const h = harness();
  enum Side {
    Buy = 'buy',
    Sell = 'sell',
  }
  let sides = call(h, 'map.new', map(enumeration(null, 'Side', Side), integer));
  sides = mutate(h, 'map.put', sides, [
    enumeration(Side.Buy, 'Side', Side),
    int(1),
  ]).replacement;
  expect(
    call(h, 'map.get', integer, [sides, enumeration(Side.Buy, 'Side', Side)])
      .value,
  ).toBe(1);
  const forged = enumeration('other', 'Side', {Other: 'other'});
  expect(() => mutate(h, 'map.put', sides, [forged, int(2)])).toThrow(
    'VALUE_LAYOUT_MISMATCH',
  );
  const numbers = call(h, 'map.new', map(integer, integer));
  expect(() =>
    mutate(h, 'map.put', numbers, [int(Number.MAX_SAFE_INTEGER + 1), int(1)]),
  ).toThrow('INVALID_MAP_KEY');
});

test('precondition failures retain stable codes and do not publish replacements', () => {
  const h = harness(1);
  const empty = call(h, 'array.new', integers);
  const full = call(h, 'array.from', integers, [int(1)]);
  const one = call(h, 'matrix.new', grid, [int(1), int(1), int(0)]);
  const lookup = call(h, 'map.new', map(float(NaN), integer));
  const failures = [
    ['NA_COLLECTION', () => call(h, 'array.size', integer, [integers])],
    [
      'INDEX_OUT_OF_BOUNDS',
      () => call(h, 'array.get', integer, [full, int(1)]),
    ],
    [
      'INDEX_OUT_OF_BOUNDS',
      () => call(h, 'matrix.get', integer, [one, int(-1), int(0)]),
    ],
    ['EMPTY_COLLECTION', () => mutate(h, 'array.pop', empty)],
    [
      'INVALID_SHAPE',
      () => call(h, 'array.new', integers, [float(1.5), int(0)]),
    ],
    [
      'INVALID_SHAPE',
      () => call(h, 'matrix.new', grid, [int(-1), int(1), int(0)]),
    ],
    [
      'INVALID_SHAPE',
      () =>
        call(h, 'matrix.new', grid, [
          int(Number.MAX_SAFE_INTEGER),
          int(2),
          int(0),
        ]),
    ],
    [
      'INVALID_MAP_KEY',
      () => mutate(h, 'map.put', lookup, [float(NaN), int(1)]),
    ],
    [
      'COLLECTION_LIMIT_EXCEEDED',
      () => mutate(h, 'array.push', full, [int(2)]),
    ],
    [
      'VALUE_LAYOUT_MISMATCH',
      () => mutate(h, 'array.push', empty, [text('wrong')]),
    ],
  ] as const;
  for (const [code, action] of failures) expect(action).toThrow(code);
  expect(arrayValues(h, empty)).toEqual([]);
  expect(arrayValues(h, full)).toEqual([1]);
});

test('collections retain shared struct identity with exact Heap byte accounting', () => {
  const h = harness();
  const p = point(h);
  const points = call(h, 'array.from', array(pointType), [p, p]);
  const first = call(h, 'array.get', pointType, [points, int(0)]);
  using tx = h.heap.begin('shared field');
  h.structs.storeField(tx, first.value as Stored, Point, 'x', int(9));
  tx.commit();
  expect(h.structs.field(p.value as Stored, Point, 'x', integer).value).toBe(9);
  expect(call(h, 'array.get', pointType, [points, int(1)]).value).toBe(p.value);
  h.heap.replaceRoots(roots([points]));
  h.heap.collect();
  expect(h.heap.stats().retainedLogicalBytes).toBe(64); // 32-byte Point + 16 + two 8-byte refs.
});

test('nested arrays retain snapshots, trace backing, and discard aborted versions', () => {
  const h = harness();
  const oldChild = call(h, 'array.from', integers, [int(1)]);
  const nested = array(integers);
  const oldOuter = call(h, 'array.from', nested, [oldChild]);
  h.heap.replaceRoots(roots([oldOuter]));
  h.heap.collect();
  expect(h.heap.stats().retainedLogicalBytes).toBe(72); // 24-byte inner + 48-byte outer.
  const child = call(h, 'array.from', integers, [int(2)]);
  const outer = mutate(h, 'array.set', oldOuter, [int(0), child]).replacement;
  h.heap.replaceRoots(roots([outer]));
  h.heap.collect();
  expect(() => arrayValues(h, oldChild)).toThrow('stale Ref');
  expect(() => arrayValues(h, oldOuter)).toThrow('stale Ref');
  using failed = h.heap.begin('aborted append');
  const aborted = h.collections.mutate(failed, 'array.push', child, [
    int(99),
  ]).replacement;
  failed.abort();
  expect(() => h.collections.entries(aborted)).toThrow('stale Ref');
  const nextChild = mutate(h, 'array.push', child, [int(3)]).replacement;
  const nextOuter = mutate(h, 'array.set', outer, [
    int(0),
    nextChild,
  ]).replacement;
  const retrieved = call(h, 'array.get', integers, [nextOuter, int(0)]);
  expect(arrayValues(h, retrieved)).toEqual([2, 3]);
  expect(
    arrayValues(h, call(h, 'array.get', integers, [outer, int(0)])),
  ).toEqual([2]);
  h.heap.replaceRoots(roots([nextOuter]));
  h.heap.collect();
  expect(h.heap.stats().retainedCells).toBe(2);
});

test('foreign and stale struct references cannot enter typed collection backing', () => {
  const h = harness();
  const foreign = point(harness());
  expect(() => call(h, 'array.from', array(pointType), [foreign])).toThrow();
  const stale = point(h);
  h.heap.replaceRoots([]);
  h.heap.collect();
  expect(() => call(h, 'array.from', array(pointType), [stale])).toThrow(
    'stale Ref',
  );
});

test('tuple elements retain their captured types and trace nested references without a table', () => {
  const h = harness();
  const p = point(h);
  const values = call(h, 'array.from', integers, [int(7)]);
  const empty = new Value<readonly Value<unknown>[] | null, 'tuple'>(
    null,
    'tuple',
    undefined,
    {elements: [pointType, integers]},
  );
  const pair = empty.withStored(Object.freeze([p, values]));
  const outer = call(h, 'array.from', array(empty), [pair]);
  const captured = call(h, 'array.get', empty, [outer, int(0)]);
  expect(captured.value![0]).toBe(p);
  expect(captured.value![1]).toBe(values);
  h.heap.replaceRoots(roots([outer]));
  h.heap.collect();
  expect(h.heap.stats().retainedCells).toBe(3);
  expect(h.heap.stats().retainedLogicalBytes).toBe(128);
});
