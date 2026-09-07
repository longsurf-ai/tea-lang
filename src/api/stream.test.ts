// Purpose: Arrow-validating Observable construction and schema ownership.

import {
  Binary,
  DataType,
  Field,
  Float64,
  List,
  Schema,
  Struct,
  TimestampMillisecond,
} from 'apache-arrow';
import {firstValueFrom, map, of, toArray} from 'rxjs';
import {expect, test} from 'vitest';
import {i} from './clock';
import {DataStream} from './stream';

const schema = new Schema([new Field('close', new Float64(), false)]);

test('validates Arrow rows and keeps explicit coercion in the producer', async () => {
  const stream = new DataStream(
    schema,
    of({close: '1'}, {close: '2'}).pipe(
      map(row => ({close: Number(row.close)})),
    ),
  );
  await expect(
    firstValueFrom(stream.asObservable().pipe(toArray())),
  ).resolves.toEqual([{close: 1}, {close: 2}]);
  await expect(
    firstValueFrom(new DataStream(schema, of({close: '1'})).asObservable()),
  ).rejects.toBeInstanceOf(TypeError);
});

test('accepts one-field scalar streams', async () => {
  const stream = new DataStream(schema, of(1, 2), i);
  await expect(
    firstValueFrom(stream.asObservable().pipe(toArray())),
  ).resolves.toEqual([1, 2]);
});

test('owns schema copies without losing Arrow types or metadata', async () => {
  const schema = new Schema(
    [new Field('close', new Float64(), false, new Map([['unit', 'USD']]))],
    new Map([['feed', 'prices']]),
  );
  const stream = new DataStream(schema, of({close: 12.5}));
  schema.fields[0]!.metadata.set('unit', 'EUR');
  schema.metadata.set('feed', 'changed');
  const exposed = stream.schema;
  exposed.fields[0]!.metadata.set('unit', 'JPY');
  exposed.fields.splice(0);
  expect(stream.schema).toBeInstanceOf(Schema);
  expect(DataType.isFloat(stream.schema.fields[0]!.type)).toBe(true);
  expect(stream.schema.fields[0]!.type.toString()).toBe('Float64');
  expect(stream.schema.fields[0]!.metadata.get('unit')).toBe('USD');
  expect(stream.schema.metadata.get('feed')).toBe('prices');
  await expect(firstValueFrom(stream.asObservable())).resolves.toEqual({
    close: 12.5,
  });
});

test('validates nested lists and binary without collapsing NaN or signed zero', async () => {
  const schema = new Schema([
    new Field(
      'payload',
      new Struct([
        new Field(
          'values',
          new List(new Field('item', new Float64(), true)),
          false,
        ),
        new Field('bytes', new Binary(), false),
      ]),
      false,
    ),
  ]);
  const row = {
    payload: {values: [NaN, -0, null], bytes: new Uint8Array([0, 255])},
  };
  await expect(
    firstValueFrom(new DataStream(schema, of(row)).asObservable()),
  ).resolves.toEqual(row);
  await expect(
    firstValueFrom(
      new DataStream(
        schema,
        of({payload: {values: ['bad'], bytes: new Uint8Array()}}),
      ).asObservable(),
    ),
  ).rejects.toBeInstanceOf(TypeError);
});

test('preserves exact numeric and bigint timestamps and rejects unsafe times', async () => {
  const schema = new Schema([
    new Field('time', new TimestampMillisecond(), false),
  ]);
  const rows = [{time: -1}, {time: BigInt(Number.MAX_SAFE_INTEGER)}];
  await expect(
    firstValueFrom(
      new DataStream(schema, of(...rows)).asObservable().pipe(toArray()),
    ),
  ).resolves.toEqual(rows);
  await expect(
    firstValueFrom(
      new DataStream(
        schema,
        of({time: Number.MAX_SAFE_INTEGER + 1}),
      ).asObservable(),
    ),
  ).rejects.toBeInstanceOf(TypeError);
});
