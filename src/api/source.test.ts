// Purpose: CSVSource schema discovery and cold RxJS resource semantics.

import {fileURLToPath} from 'node:url';
import {firstValueFrom, toArray} from 'rxjs';
import {describe, expect, test} from 'vitest';
import {
  Field,
  Float64,
  Int64,
  Schema,
  TimestampMillisecond,
  Utf8,
  Bool,
} from 'apache-arrow';
import {d} from './clock';
import {CSVSource, fromCSV} from './source';

const FIXTURES = new URL('../../tests/fixtures/api/', import.meta.url);
const CLI_DATA = fileURLToPath(
  new URL('../../tests/fixtures/cli/data.csv', import.meta.url),
);

function fixture(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

describe('CSVSource', () => {
  test('discovers Arrow string fields from the header', async () => {
    const source = await CSVSource.open(CLI_DATA);

    expect(source.schema).toBeInstanceOf(Schema);
    expect(source.schema.fields.map(field => field.name)).toEqual([
      'time',
      'close',
    ]);
    expect(
      source.schema.fields.every(
        field => field.type instanceof Utf8 && !field.nullable,
      ),
    ).toBe(true);

    await expect(
      firstValueFrom(source.stream().asObservable().pipe(toArray())),
    ).resolves.toEqual([
      {time: '100', close: '1'},
      {time: '200', close: '2'},
    ]);
  });

  test('uses a caller schema to decode rows in order', async () => {
    const schema = new Schema([
      new Field('time', new TimestampMillisecond(), false),
      new Field('close', new Float64(), false),
    ]);
    const stream = await fromCSV(CLI_DATA, schema);

    await expect(
      firstValueFrom(stream.asObservable().pipe(toArray())),
    ).resolves.toEqual([
      {time: 100, close: 1},
      {time: 200, close: 2},
    ]);
  });

  test('forwards a caller clock into the CSV DataStream', async () => {
    const stream = await fromCSV(
      CLI_DATA,
      new Schema([
        new Field('time', new Int64(), false),
        new Field('close', new Float64(), false),
      ]),
      d,
    );

    expect(stream.clock).toBe(d);
    await expect(firstValueFrom(stream.asObservable())).resolves.toEqual({
      time: 100n,
      close: 1,
    });
  });

  test('handles quoted commas and multiline fields', async () => {
    const stream = await fromCSV(fixture('quoted.csv'));

    await expect(
      firstValueFrom(stream.asObservable().pipe(toArray())),
    ).resolves.toEqual([
      {symbol: 'AAPL', note: 'contains, comma', close: '193.25'},
      {symbol: 'NVDA', note: 'spans\ntwo lines', close: '182.10'},
    ]);
  });

  test('rejects duplicate headers during discovery', async () => {
    await expect(
      CSVSource.open(fixture('duplicate-header.csv')),
    ).rejects.toThrow('has an invalid header');
  });

  test('does not open an explicitly typed source before subscription', async () => {
    const missing = fixture('missing.csv');
    const source = new CSVSource(
      missing,
      new Schema([new Field('close', new Utf8(), false)]),
    );
    const stream = source.stream();

    await expect(firstValueFrom(stream.asObservable())).rejects.toMatchObject({
      code: 'ENOENT',
      path: missing,
    });
  });

  test('reports decoding failures through the stream', async () => {
    const source = new CSVSource(
      CLI_DATA,
      new Schema([
        new Field('time', new Utf8(), false),
        new Field('close', new Bool(), false),
      ]),
    );

    await expect(
      firstValueFrom(source.stream().asObservable()),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test('opens a fresh reader for each subscription to the same stream', async () => {
    const stream = await fromCSV(CLI_DATA);
    const first = await firstValueFrom(stream.asObservable().pipe(toArray()));
    const second = await firstValueFrom(stream.asObservable().pipe(toArray()));
    expect(second).toEqual(first);
    expect(second).toHaveLength(2);
  });

  test('ignores undeclared CSV columns and isolates its supplied schema', async () => {
    const schema = new Schema([new Field('close', new Float64(), false)]);
    const source = await CSVSource.open(CLI_DATA, schema);
    schema.fields.splice(0);
    source.schema.fields.splice(0);
    await expect(
      firstValueFrom(source.stream().asObservable()),
    ).resolves.toEqual({close: 1});
  });

  test('reports missing files during schema discovery', async () => {
    await expect(CSVSource.open(fixture('missing.csv'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
