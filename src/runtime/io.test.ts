// Purpose: Arrow schema ownership and the shared external-value boundary.

import assert from 'node:assert/strict';
import {
  Binary,
  Dictionary,
  Int32,
  Field,
  FixedSizeBinary,
  FixedSizeList,
  Float64,
  List,
  Map_ as ArrowMap,
  Schema,
  Struct,
  Table,
  TimestampMillisecond,
  Utf8,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  type DataType,
} from 'apache-arrow';
import {describe, expect, test} from 'vitest';
import {
  cloneSchema,
  decodeSchema,
  encodeSchema,
  validateRecord,
  validateValue,
} from './io';

const item = new Field('item', new Float64(), false);
const blob = new Field('blob', new Binary(), true);
const samples = new Field('samples', new List(item), true);
const named = new Field(
  'named',
  new Struct([new Field('label', new Utf8(), true), samples]),
  true,
  new Map([['tea:typeId', 'test.Named']]),
);
const schema = new Schema([blob, named], new Map([['title', 'Original']]));

describe('Arrow I/O ownership and validation', () => {
  test('clones nested Arrow classes and metadata without sharing mutable Maps', () => {
    const copy = cloneSchema(schema);
    expect(copy).toEqual(schema);
    expect(copy).toBeInstanceOf(Schema);
    expect(copy.fields[1]).toBeInstanceOf(Field);
    copy.metadata.set('title', 'Changed');
    copy.fields[1].metadata.set('tea:typeId', 'forged.Other');
    copy.fields[1].type.children[1].type.children[0].metadata.set(
      'unit',
      'wrong',
    );
    expect(schema.metadata.get('title')).toBe('Original');
    expect(named.metadata.get('tea:typeId')).toBe('test.Named');
    expect(item.metadata.has('unit')).toBe(false);
    expect(decodeSchema(encodeSchema(schema))).toEqual(schema);
  });

  test('round-trips dictionary types and rejects recursive schema graphs', () => {
    const dictionary = new Schema([
      new Field('label', new Dictionary(new Utf8(), new Int32()), true),
    ]);
    const restored = cloneSchema(dictionary);
    expect(restored.fields[0].type.toString()).toBe('Dictionary<Int32, Utf8>');
    validateRecord(restored, {label: 'one'});
    expect(() => validateRecord(restored, {label: 1})).toThrow();
    const fields: Field[] = [];
    const recursive = new Struct(fields);
    const cyclic = new Schema([new Field('root', recursive, true)]);
    fields.push(new Field('next', recursive, true));
    expect(() => encodeSchema(cyclic)).toThrow('recursive Arrow schema');
  });

  test('validates binary, nested lists, null, NaN, signed zero and exact times', () => {
    const value = {
      blob: Uint8Array.of(0, 255),
      named: {label: null, samples: [NaN, -0, 1]},
      unused: true,
    };
    const record = validateRecord(schema, value);
    expect(Object.keys(record)).toEqual(['blob', 'named']);
    expect(record.named).toBe(value.named);
    expect(Object.is(value.named.samples[1], -0)).toBe(true);
    validateRecord(schema, {blob: new Uint8Array(), named: null});
    validateRecord(schema, {});
    const time = new Field('time', new TimestampMillisecond(), false);
    for (const instant of [
      -1,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      -1n,
    ])
      validateValue(time, instant);
    for (const instant of [
      1.1,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      9007199254740992n,
    ]) {
      expect(() => validateValue(time, instant)).toThrow();
    }
  });

  test('rejects malformed nested values, sparse required items and fixed-size violations', () => {
    for (const value of [[1, '2'], [1, Infinity], [undefined], Array(2)]) {
      expect(() => validateValue(samples, value)).toThrow();
    }
    expect(() => validateValue(blob, [0, 255])).toThrow();
    expect(() =>
      validateValue(
        new Field('fixed', new FixedSizeBinary(2), false),
        Uint8Array.of(1),
      ),
    ).toThrow();
    expect(() =>
      validateValue(new Field('pair', new FixedSizeList(2, item), false), [1]),
    ).toThrow();
    expect(() => validateRecord(new Schema([item, item]), {item: 1})).toThrow(
      'duplicate',
    );
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const nested = new Field(
      'outer',
      new List(new Field('inner', new List(item), false)),
      false,
    );
    expect(() => validateValue(nested, cycle)).toThrow('cycle');
  });

  test('captures own input properties once and rejects inherited required values', () => {
    const schema = new Schema([new Field('close', new Float64(), false)]);
    let reads = 0;
    const source = {
      get close() {
        reads += 1;
        return reads;
      },
    };
    expect(validateRecord(schema, source)).toEqual({close: 1});
    expect(reads).toBe(1);
    expect(() => validateRecord(schema, Object.create({close: 12}))).toThrow();
    const nested = new Schema([
      new Field('box', new Struct(schema.fields), false),
    ]);
    expect(() =>
      validateRecord(nested, {box: Object.create({close: 12})}),
    ).toThrow();
    const own = Object.assign(Object.create(null), {close: 12});
    expect(validateRecord(schema, own)).toEqual({close: 12});
  });

  test('requires non-null map keys and retains insertion order and zero normalization', () => {
    const field = new Field(
      'map',
      new ArrowMap(
        new Field(
          'entries',
          new Struct<{key: DataType; value: DataType}>([
            new Field('key', new Float64(), false),
            new Field('value', new Utf8(), true),
          ]),
          false,
        ),
      ),
      false,
    );
    const values = new Map([
      [2, 'two'],
      [-0, 'zero'],
      [NaN, null],
    ]);
    validateValue(field, values);
    expect([...values.keys()]).toEqual([2, 0, NaN]);
    expect(Object.is([...values.keys()][1], 0)).toBe(true);
    expect(() => validateValue(field, new Map([[null, 'bad']]))).toThrow();
  });

  test('round-trips independently constructed nested and binary values at several Arrow batch sizes', () => {
    const rows = [
      {blob: new Uint8Array(), named: null},
      {
        blob: Uint8Array.of(0, 255, 128),
        named: {label: 'one', samples: [NaN, -0, 4]},
      },
      {blob: null, named: {label: null, samples: []}},
      {blob: Uint8Array.of(3), named: {label: 'missing', samples: null}},
    ];
    for (const size of [1, 2, 4]) {
      const batches = [];
      for (let offset = 0; offset < rows.length; offset += size) {
        const part = rows.slice(offset, offset + size);
        batches.push(
          ...new Table(schema, {
            blob: vectorFromArray(
              part.map(row => row.blob),
              blob.type,
            ),
            named: vectorFromArray(
              part.map(row => row.named),
              named.type,
            ),
          }).batches,
        );
      }
      const restored = tableFromIPC(tableToIPC(new Table(schema, batches)));
      assert.deepStrictEqual(
        encodeSchema(restored.schema),
        encodeSchema(schema),
      );
      for (const [index, expected] of rows.entries()) {
        const row = restored.get(index)!;
        assert.deepStrictEqual(row.blob, expected.blob);
        if (expected.named === null) assert.equal(row.named, null);
        else {
          assert.equal(row.named.label, expected.named.label);
          const values = row.named.samples;
          assert.deepStrictEqual(
            values === null ? null : Array.from(values),
            expected.named.samples,
          );
        }
      }
    }
  });
});
