// Seeded persistent-collection traces checked against independent eager-copy models.
import {expect, test} from 'vitest';
import {Value, bool, float, int} from '../value';
import {
  array,
  matrix,
  map,
  harness,
  call,
  mutate,
  arrayValues,
  mapValues,
} from './testing';

const integer = int(NaN);
const integers = array(integer);
const grid = matrix(integer);
const lookup = map(float(NaN), integer);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function matrixValues(h: ReturnType<typeof harness>, value: Value<unknown>) {
  const rows = call(h, 'matrix.rows', integer, [value]).value;
  const columns = call(h, 'matrix.columns', integer, [value]).value;
  expect(call(h, 'matrix.elements_count', integer, [value]).value).toBe(
    rows * columns,
  );
  return {
    rows,
    columns,
    values: Array.from(
      {length: rows * columns},
      (_, offset) =>
        call(h, 'matrix.get', integer, [
          value,
          int(Math.floor(offset / columns)),
          int(offset % columns),
        ]).value,
    ),
  };
}

test('seeded array mutations preserve every retained alias against eager copies', () => {
  const h = harness();
  const next = random(0xa221_17f3);
  let value = call(h, 'array.from', integers);
  let model: number[] = [];
  const versions: {value: Value<unknown>; model: number[]}[] = [];
  for (let step = 0; step < 96; step++) {
    versions.push({value, model: [...model]});
    if (step % 11 === 0) value = call(h, 'array.copy', integers, [value]);
    const choice = next() % 5;
    if (model.length === 0 || choice <= 1) {
      const item = next() % 10_000;
      value = mutate(h, 'array.push', value, [int(item)]).replacement;
      model = [...model, item];
    } else if (choice === 2) {
      const index = next() % model.length;
      const item = next() % 10_000;
      value = mutate(h, 'array.set', value, [
        int(index),
        int(item),
      ]).replacement;
      model = model.map((old, at) => (at === index ? item : old));
    } else if (choice === 3) {
      const result = mutate(h, 'array.pop', value);
      expect(result.result?.value).toBe(model.at(-1));
      value = result.replacement;
      model = model.slice(0, -1);
    } else {
      value = mutate(h, 'array.clear', value).replacement;
      model = [];
    }
    for (const version of [...versions, {value, model}])
      expect(arrayValues(h, version.value)).toEqual(version.model);
  }
});

test('seeded matrix writes and projections match independent row-major copies', () => {
  const h = harness();
  const next = random(0x4d41_5458);
  let value = call(h, 'matrix.new', grid, [int(3), int(4), int(0)]);
  let model = {rows: 3, columns: 4, values: Array<number>(12).fill(0)};
  const versions: {value: Value<unknown>; model: typeof model}[] = [];
  for (let step = 0; step < 48; step++) {
    versions.push({value, model: {...model, values: [...model.values]}});
    if (step % 7 === 0) value = call(h, 'matrix.copy', grid, [value]);
    const item = next() % 1_000;
    if (next() % 4 === 0) {
      value = mutate(h, 'matrix.fill', value, [int(item)]).replacement;
      model = {...model, values: model.values.map(() => item)};
    } else {
      const row = next() % model.rows;
      const column = next() % model.columns;
      value = mutate(h, 'matrix.set', value, [
        int(row),
        int(column),
        int(item),
      ]).replacement;
      const values = [...model.values];
      values[row * model.columns + column] = item;
      model = {...model, values};
    }
    if (step % 6 === 0) {
      const row = next() % model.rows;
      const column = next() % model.columns;
      expect(
        arrayValues(h, call(h, 'matrix.row', integers, [value, int(row)])),
      ).toEqual(
        model.values.slice(row * model.columns, (row + 1) * model.columns),
      );
      expect(
        arrayValues(
          h,
          call(h, 'matrix.column', integers, [value, int(column)]),
        ),
      ).toEqual(
        Array.from(
          {length: model.rows},
          (_, at) => model.values[at * model.columns + column],
        ),
      );
    }
    for (const version of [...versions, {value, model}])
      expect(matrixValues(h, version.value)).toEqual(version.model);
  }
});

test('seeded ordered maps preserve versions and canonical negative-zero keys', () => {
  const h = harness();
  const next = random(0x4d41_5053);
  const keys = [-0, 0, -2.5, -1, 1, 2.5, 3] as const;
  let value = call(h, 'map.new', lookup);
  value = mutate(h, 'map.put', value, [float(-0), int(1)]).replacement;
  value = mutate(h, 'map.put', value, [float(0), int(2)]).replacement;
  let model: (readonly [number, number])[] = [[0, 2]];
  expect(mapValues(h, value)).toEqual(model);
  expect(Object.is(mapValues(h, value)[0][0], -0)).toBe(false);
  const versions: {
    value: Value<unknown>;
    model: readonly (readonly [number, number])[];
  }[] = [];
  for (let step = 0; step < 72; step++) {
    versions.push({value, model: model.map(entry => [...entry] as const)});
    if (step % 9 === 0) value = call(h, 'map.copy', lookup, [value]);
    const rawKey = keys[next() % keys.length];
    const key = Object.is(rawKey, -0) ? 0 : rawKey;
    const choice = next() % 5;
    const at = model.findIndex(entry => entry[0] === key);
    if (choice <= 2) {
      const item = next() % 10_000;
      value = mutate(h, 'map.put', value, [
        float(rawKey),
        int(item),
      ]).replacement;
      model =
        at < 0
          ? [...model, [key, item]]
          : model.map((entry, index) =>
              index === at ? [entry[0], item] : entry,
            );
    } else if (choice === 3) {
      const result = mutate(h, 'map.remove', value, [float(rawKey)]);
      if (at < 0) expect(result.result?.value).toBeNaN();
      else expect(result.result?.value).toBe(model[at][1]);
      value = result.replacement;
      model = at < 0 ? [...model] : model.filter((_, index) => index !== at);
    } else {
      value = mutate(h, 'map.clear', value).replacement;
      model = [];
    }
    expect(call(h, 'map.size', integer, [value]).value).toBe(model.length);
    const query = keys[next() % keys.length];
    const found = model.find(
      entry => entry[0] === (Object.is(query, -0) ? 0 : query),
    );
    expect(
      call(h, 'map.contains', bool(false), [value, float(query)]).value,
    ).toBe(found !== undefined);
    const got = call(h, 'map.get', integer, [value, float(query)]).value;
    if (found === undefined) expect(got).toBeNaN();
    else expect(got).toBe(found[1]);
    if (step % 8 === 0) {
      expect(
        arrayValues(h, call(h, 'map.keys', array(float(NaN)), [value])),
      ).toEqual(model.map(entry => entry[0]));
      expect(arrayValues(h, call(h, 'map.values', integers, [value]))).toEqual(
        model.map(entry => entry[1]),
      );
    }
    for (const version of [...versions, {value, model}])
      expect(mapValues(h, version.value)).toEqual(version.model);
  }
});
