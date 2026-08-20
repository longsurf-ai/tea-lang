// Purpose: Deterministic collection traces compare immutable runtime headers with independent eager-copy reference models.

import {describe, expect, test} from 'vitest';
import {
  type CollectionMutation,
  type CollectionMutationOperation,
  type CollectionOperation,
  type CollectionValue,
  type Value,
} from '../abi';
import {HeapArena, type HeapTransaction, type StorageRef} from '../heap';
import {StructStorageRuntime} from '../struct-storage';
import {
  type AggregateLayoutManifest,
  ValueLayoutRegistry,
  visitRuntimeValueStorageRefs,
} from '../value-layout';
import {CollectionRuntime} from './index';

const INT = 0;
const FLOAT = 1;
const STRING = 2;
const POINT = 3;
const BOX = 4;
const INTS = 5;
const BOXES = 6;
const INT_MATRIX = 7;
const FLOAT_INT_MAP = 8;
const STRING_STRING_MAP = 9;
const FLOATS = 10;
const STRINGS = 11;
const BOOL = 12;

const MANIFEST = {
  layouts: [
    {kind: 'number', numeric: 'int'},
    {kind: 'number', numeric: 'float'},
    {kind: 'nullable-scalar', scalar: 'string'},
    {
      kind: 'struct',
      name: 'Point',
      fields: [
        {name: 'x', layout: INT},
        {name: 'y', layout: INT},
      ],
    },
    {
      kind: 'struct',
      name: 'Box',
      fields: [
        {name: 'point', layout: POINT},
        {name: 'stamp', layout: INT},
      ],
    },
    {kind: 'array', element: INT},
    {kind: 'array', element: BOX},
    {kind: 'matrix', element: INT},
    {kind: 'map', key: FLOAT, value: INT},
    {kind: 'map', key: STRING, value: STRING},
    {kind: 'array', element: FLOAT},
    {kind: 'array', element: STRING},
    {kind: 'boolean'},
  ],
} as const satisfies AggregateLayoutManifest;

interface Harness {
  readonly heap: HeapArena;
  readonly layouts: ValueLayoutRegistry;
  readonly collections: CollectionRuntime;
  readonly structs: StructStorageRuntime;
  transaction: number;
}

function harness(maxElements = 10_000): Harness {
  const heap = new HeapArena();
  const layouts = new ValueLayoutRegistry(MANIFEST);
  const structs = new StructStorageRuntime(heap, layouts);
  return {
    heap,
    layouts,
    structs,
    collections: new CollectionRuntime(heap, layouts, maxElements, structs),
    transaction: 0,
  };
}

function roots(values: readonly Value[]): StorageRef[] {
  const result: StorageRef[] = [];
  values.forEach(value =>
    visitRuntimeValueStorageRefs(value, ref => result.push(ref)),
  );
  return result;
}

function commit(transaction: HeapTransaction, values: readonly Value[]): void {
  transaction.prepareCommit(roots(values)).commit();
}

function call(
  h: Harness,
  operation: CollectionOperation,
  layout: number,
  args: readonly Value[],
): Value {
  const transaction = h.heap.beginTransaction(
    `call-${h.transaction++}-${operation}`,
  );
  const result = h.collections.call(transaction, operation, layout, args);
  commit(transaction, [result]);
  return result;
}

function mutate(
  h: Harness,
  operation: CollectionMutationOperation,
  layout: number,
  receiver: Value,
  args: readonly Value[],
): CollectionMutation {
  const transaction = h.heap.beginTransaction(
    `mutate-${h.transaction++}-${operation}`,
  );
  const result = h.collections.mutate(
    transaction,
    operation,
    layout,
    receiver,
    args,
  );
  commit(transaction, [result.replacement]);
  return result;
}

function fail(
  h: Harness,
  code: string,
  run: (transaction: HeapTransaction) => unknown,
): void {
  const transaction = h.heap.beginTransaction(
    `failure-${h.transaction++}-${code}`,
  );
  expect(() => run(transaction)).toThrow(code);
  transaction.abort();
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function hash(value: unknown): number {
  const text = JSON.stringify(value);
  let result = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    result = Math.imul(result ^ text.charCodeAt(index), 16_777_619);
  }
  return result >>> 0;
}

function arrayValues(h: Harness, value: Value): readonly Value[] {
  return h.collections.entries(value) as readonly Value[];
}

interface MatrixModel {
  readonly rows: number;
  readonly columns: number;
  readonly values: readonly number[];
}

function matrixValues(h: Harness, value: Value): MatrixModel {
  const transaction = h.heap.beginTransaction(`matrix-read-${h.transaction++}`);
  const rows = h.collections.call(transaction, 'matrix.rows', INT, [
    value,
  ]) as number;
  const columns = h.collections.call(transaction, 'matrix.columns', INT, [
    value,
  ]) as number;
  const count = h.collections.call(transaction, 'matrix.elements_count', INT, [
    value,
  ]);
  const values: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      values.push(
        h.collections.call(transaction, 'matrix.get', INT, [
          value,
          row,
          column,
        ]) as number,
      );
    }
  }
  commit(transaction, []);
  expect(count).toBe(rows * columns);
  return {rows, columns, values};
}

function mapValues(
  h: Harness,
  value: Value,
): readonly (readonly [Value, Value])[] {
  return h.collections.entries(value) as readonly (readonly [Value, Value])[];
}

describe('collection property traces', () => {
  test('array mutations match eager copies and preserve every retained alias', () => {
    const h = harness();
    const next = random(0xa221_17f3);
    let value = call(h, 'array.from', INTS, []) as CollectionValue;
    let model: number[] = [];
    const versions: {value: Value; model: readonly number[]}[] = [];

    for (let step = 0; step < 96; step += 1) {
      versions.push({value, model: [...model]});
      if (step % 11 === 0) {
        value = call(h, 'array.copy', INTS, [value]) as CollectionValue;
      }

      const choice = next() % 5;
      if (model.length === 0 || choice <= 1) {
        const item = next() % 10_000;
        value = mutate(h, 'array.push', INTS, value, [item]).replacement;
        model = [...model, item];
      } else if (choice === 2) {
        const index = next() % model.length;
        const item = next() % 10_000;
        value = mutate(h, 'array.set', INTS, value, [index, item]).replacement;
        model = model.map((old, at) => (at === index ? item : old));
      } else if (choice === 3) {
        const expected = model[model.length - 1];
        const result = mutate(h, 'array.pop', INTS, value, []);
        expect(result.result).toBe(expected);
        value = result.replacement;
        model = model.slice(0, -1);
      } else {
        value = mutate(h, 'array.clear', INTS, value, []).replacement;
        model = [];
      }

      for (const version of [...versions, {value, model}]) {
        expect(hash(arrayValues(h, version.value))).toBe(hash(version.model));
      }
    }

    expect(arrayValues(h, value)).toEqual(model);
    expect(arrayValues(h, versions[0].value)).toEqual([]);
  });

  test('matrix set/fill/copy and projections match a fixed row-major model', () => {
    const h = harness();
    const next = random(0x4d41_5458);
    let value = call(h, 'matrix.new', INT_MATRIX, [3, 4, 0]);
    let model: MatrixModel = {rows: 3, columns: 4, values: Array(12).fill(0)};
    const versions: {value: Value; model: MatrixModel}[] = [];

    for (let step = 0; step < 48; step += 1) {
      versions.push({
        value,
        model: {...model, values: [...model.values]},
      });
      if (step % 7 === 0) {
        value = call(h, 'matrix.copy', INT_MATRIX, [value]);
      }

      const item = next() % 1_000;
      if (next() % 4 === 0) {
        value = mutate(h, 'matrix.fill', INT_MATRIX, value, [item]).replacement;
        model = {...model, values: model.values.map(() => item)};
      } else {
        const row = next() % model.rows;
        const column = next() % model.columns;
        value = mutate(h, 'matrix.set', INT_MATRIX, value, [
          row,
          column,
          item,
        ]).replacement;
        const values = [...model.values];
        values[row * model.columns + column] = item;
        model = {...model, values};
      }

      if (step % 6 === 0) {
        const row = next() % model.rows;
        const column = next() % model.columns;
        const rowValue = call(h, 'matrix.row', INTS, [value, row]);
        const columnValue = call(h, 'matrix.column', INTS, [value, column]);
        expect(arrayValues(h, rowValue)).toEqual(
          model.values.slice(row * model.columns, (row + 1) * model.columns),
        );
        expect(arrayValues(h, columnValue)).toEqual(
          Array.from(
            {length: model.rows},
            (_, at) => model.values[at * model.columns + column],
          ),
        );
      }

      for (const version of [...versions, {value, model}]) {
        expect(hash(matrixValues(h, version.value))).toBe(hash(version.model));
      }
    }

    expect(matrixValues(h, value)).toEqual(model);
  });

  test('ordered map traces match eager copies, including canonical negative zero', () => {
    const h = harness();
    const next = random(0x4d41_5053);
    const keys = [-0, 0, -2.5, -1, 1, 2.5, 3] as const;
    let value = call(h, 'map.new', FLOAT_INT_MAP, []);
    value = mutate(h, 'map.put', FLOAT_INT_MAP, value, [-0, 1]).replacement;
    value = mutate(h, 'map.put', FLOAT_INT_MAP, value, [0, 2]).replacement;
    let model: (readonly [number, number])[] = [[0, 2]];
    expect(mapValues(h, value)).toEqual(model);
    const versions: {
      value: Value;
      model: readonly (readonly [number, number])[];
    }[] = [];

    for (let step = 0; step < 72; step += 1) {
      versions.push({value, model: model.map(entry => [...entry] as const)});
      if (step % 9 === 0) {
        value = call(h, 'map.copy', FLOAT_INT_MAP, [value]);
      }

      const rawKey = keys[next() % keys.length];
      const key = Object.is(rawKey, -0) ? 0 : rawKey;
      const choice = next() % 5;
      if (choice <= 2) {
        const item = next() % 10_000;
        const at = model.findIndex(entry => entry[0] === key);
        value = mutate(h, 'map.put', FLOAT_INT_MAP, value, [
          rawKey,
          item,
        ]).replacement;
        model =
          at < 0
            ? [...model, [key, item] as const]
            : model.map((entry, index) =>
                index === at ? ([entry[0], item] as const) : entry,
              );
      } else if (choice === 3) {
        const at = model.findIndex(entry => entry[0] === key);
        const result = mutate(h, 'map.remove', FLOAT_INT_MAP, value, [rawKey]);
        if (at < 0) {
          expect(Number.isNaN(result.result as number)).toBe(true);
        } else {
          expect(result.result).toBe(model[at][1]);
        }
        value = result.replacement;
        model = at < 0 ? [...model] : model.filter((_, index) => index !== at);
      } else {
        value = mutate(h, 'map.clear', FLOAT_INT_MAP, value, []).replacement;
        model = [];
      }

      expect(call(h, 'map.size', INT, [value])).toBe(model.length);
      const query = keys[next() % keys.length];
      const canonical = Object.is(query, -0) ? 0 : query;
      const found = model.find(entry => entry[0] === canonical);
      expect(call(h, 'map.contains', BOOL, [value, query])).toBe(
        found !== undefined,
      );
      const got = call(h, 'map.get', INT, [value, query]) as number;
      expect(found === undefined ? Number.isNaN(got) : got === found[1]).toBe(
        true,
      );

      if (step % 8 === 0) {
        const runtimeKeys = call(h, 'map.keys', FLOATS, [value]);
        const runtimeValues = call(h, 'map.values', INTS, [value]);
        expect(arrayValues(h, runtimeKeys)).toEqual(
          model.map(entry => entry[0]),
        );
        expect(arrayValues(h, runtimeValues)).toEqual(
          model.map(entry => entry[1]),
        );
      }

      for (const version of [...versions, {value, model}]) {
        expect(hash(mapValues(h, version.value))).toBe(hash(version.model));
      }
    }

    expect(mapValues(h, value)).toEqual(model);
  });

  test('nested struct refs stay aliased across repeated and historical collection headers', () => {
    const h = harness();
    const allocation = h.heap.beginTransaction('nested structs');
    const point = h.structs.newStruct(allocation, POINT, [1, 2]);
    const box = h.structs.newStruct(allocation, BOX, [point, 7]);
    commit(allocation, [box]);
    const value = call(h, 'array.from', BOXES, [box, box]);
    const historicalHeader = value;
    const snapshot = (candidate: Value) =>
      arrayValues(h, candidate).map(item => {
        const storedPoint = h.structs.field(item, BOX, 0);
        return {
          point: [
            h.structs.field(storedPoint, POINT, 0),
            h.structs.field(storedPoint, POINT, 1),
          ],
          stamp: h.structs.field(item, BOX, 1),
        };
      });

    const update = h.heap.beginTransaction('shared field update');
    h.structs.storeField(update, point, POINT, 0, 99);
    commit(update, [value]);

    expect(snapshot(value)).toEqual([
      {point: [99, 2], stamp: 7},
      {point: [99, 2], stamp: 7},
    ]);
    expect(snapshot(historicalHeader)).toEqual(snapshot(value));
  });
});

describe('collection failure contracts', () => {
  test('all collection precondition failures use their stable execution codes', () => {
    const h = harness(1);
    const empty = call(h, 'array.from', INTS, []);
    const full = call(h, 'array.from', INTS, [1]);
    const matrix = call(h, 'matrix.new', INT_MATRIX, [1, 1, 0]);
    const map = call(h, 'map.new', FLOAT_INT_MAP, []);

    fail(h, 'NA_COLLECTION', transaction =>
      h.collections.call(transaction, 'array.size', INT, [null]),
    );
    fail(h, 'INDEX_OUT_OF_BOUNDS', transaction =>
      h.collections.call(transaction, 'array.get', INT, [full, 1]),
    );
    fail(h, 'INDEX_OUT_OF_BOUNDS', transaction =>
      h.collections.call(transaction, 'matrix.get', INT, [matrix, -1, 0]),
    );
    fail(h, 'EMPTY_COLLECTION', transaction =>
      h.collections.mutate(transaction, 'array.pop', INTS, empty, []),
    );
    fail(h, 'INVALID_SHAPE', transaction =>
      h.collections.call(transaction, 'array.new', INTS, [1.5, 0]),
    );
    fail(h, 'INVALID_SHAPE', transaction =>
      h.collections.call(transaction, 'matrix.new', INT_MATRIX, [-1, 1, 0]),
    );
    fail(h, 'INVALID_MAP_KEY', transaction =>
      h.collections.mutate(transaction, 'map.put', FLOAT_INT_MAP, map, [
        NaN,
        1,
      ]),
    );
    fail(h, 'COLLECTION_LIMIT_EXCEEDED', transaction =>
      h.collections.mutate(transaction, 'array.push', INTS, full, [2]),
    );
    fail(h, 'VALUE_LAYOUT_MISMATCH', transaction =>
      h.collections.mutate(transaction, 'array.push', INTS, empty, ['wrong']),
    );
    expect(() => h.structs.requireStruct(null, BOX)).toThrow('NA_STRUCT_WRITE');

    expect(arrayValues(h, empty)).toEqual([]);
    expect(arrayValues(h, full)).toEqual([1]);
  });

  test('contains distinguishes a missing key from a stored typed empty', () => {
    const h = harness();
    let value = call(h, 'map.new', STRING_STRING_MAP, []);
    expect(call(h, 'map.get', STRING, [value, 'key'])).toBeNull();
    expect(call(h, 'map.contains', BOOL, [value, 'key'])).toBe(false);

    value = mutate(h, 'map.put', STRING_STRING_MAP, value, [
      'key',
      null,
    ]).replacement;
    expect(call(h, 'map.get', STRING, [value, 'key'])).toBeNull();
    expect(call(h, 'map.contains', BOOL, [value, 'key'])).toBe(true);

    const removed = mutate(h, 'map.remove', STRING_STRING_MAP, value, ['key']);
    expect(removed.result).toBeNull();
    expect(call(h, 'map.contains', BOOL, [removed.replacement, 'key'])).toBe(
      false,
    );
    expect(
      arrayValues(
        h,
        call(h, 'map.keys', STRINGS, [removed.replacement]) as Value,
      ),
    ).toHaveLength(0);
  });
});
