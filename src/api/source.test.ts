// Purpose: CSVSource schema discovery and cold RxJS resource semantics.

import {fileURLToPath} from 'node:url';
import {firstValueFrom, toArray} from 'rxjs';
import {describe, expect, test} from 'vitest';
import * as z from 'zod';
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
  test('discovers and freezes a strict string schema from the header', async () => {
    const source = await CSVSource.open(CLI_DATA);

    expect(source.indices).toBe(2);
    expect(source.schema.safeParse({time: '100', close: '1'}).success).toBe(
      true,
    );
    expect(
      source.schema.safeParse({time: '100', close: '1', extra: 'no'}).success,
    ).toBe(false);

    await expect(
      firstValueFrom(source.stream().asObservable().pipe(toArray())),
    ).resolves.toEqual([
      {time: '100', close: '1'},
      {time: '200', close: '2'},
    ]);
  });

  test('uses a caller schema to decode rows in order', async () => {
    const schema = z.object({
      time: z.coerce.number(),
      close: z.coerce.number(),
    });
    const stream = await fromCSV(CLI_DATA, schema);

    expect(stream.indices).toBe(2);

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
      z.object({time: z.coerce.bigint(), close: z.coerce.number()}),
      d,
    );

    expect(stream.clock).toBe(d);
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
    const source = new CSVSource(missing, z.record(z.string(), z.string()));
    const stream = source.stream();

    await expect(firstValueFrom(stream.asObservable())).rejects.toMatchObject({
      code: 'ENOENT',
      path: missing,
    });
  });

  test('reports Zod validation failures through the stream', async () => {
    const source = new CSVSource(
      CLI_DATA,
      z.object({time: z.string(), close: z.literal('2')}),
    );

    await expect(
      firstValueFrom(source.stream().asObservable()),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  test('reports missing files during schema discovery', async () => {
    await expect(CSVSource.open(fixture('missing.csv'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
