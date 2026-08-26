// Purpose: CSVSink Observer lifecycle, schema validation, and CSV encoding.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {of} from 'rxjs';
import {afterEach, describe, expect, test} from 'vitest';
import * as z from 'zod';
import {CSVSink, StdoutSink} from './sink';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function outputPath(): string {
  const directory = mkdtempSync(join(ROOT, '.csv-sink-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'output.csv');
}

const schema = z.object({
  symbol: z.string(),
  note: z.string(),
  close: z.number(),
});

describe('CSVSink', () => {
  test('subscribes as an Observer and writes quoted rows in schema order', async () => {
    const path = outputPath();
    const sink = new CSVSink(path, schema);

    expect(existsSync(path)).toBe(false);
    of(
      {symbol: 'AAPL', note: 'contains, comma', close: 193.25},
      {symbol: 'NVDA', note: 'spans\ntwo lines', close: 182.1},
    ).subscribe(sink);
    await sink.completion;

    expect(readFileSync(path, 'utf8')).toBe(
      [
        'symbol,note,close',
        'AAPL,"contains, comma",193.25',
        'NVDA,"spans',
        'two lines",182.1',
        '',
      ].join('\n'),
    );
  });

  test('writes a header for an empty completed stream', async () => {
    const path = outputPath();
    const sink = new CSVSink(path, schema);

    sink.complete();
    await sink.completion;

    expect(readFileSync(path, 'utf8')).toBe('symbol,note,close\n');
  });

  test('rejects completion when a row fails schema validation', async () => {
    const path = outputPath();
    const sink = new CSVSink(path, schema);

    sink.write({symbol: 'AAPL', note: 'bad', close: 'not a number'} as never);

    await expect(sink.completion).rejects.toBeInstanceOf(z.ZodError);
    expect(existsSync(path)).toBe(false);
  });

  test('rejects completion on an upstream error without opening a file', async () => {
    const path = outputPath();
    const sink = new CSVSink(path, schema);
    const error = new Error('upstream failed');

    sink.error(error);

    await expect(sink.completion).rejects.toBe(error);
    expect(existsSync(path)).toBe(false);
  });

  test('infers overwrite columns and JSON-encodes nested values', async () => {
    const path = outputPath();
    const sink = new CSVSink(path, 'w');

    sink.write({value: 1, detail: {color: 'green'}, effects: []});
    sink.complete();
    await sink.completion;

    expect(readFileSync(path, 'utf8')).toBe(
      'value,detail,effects\n1,"{""color"":""green""}",[]\n',
    );
  });

  test('appends by column set while preserving existing header order', async () => {
    const path = outputPath();
    writeFileSync(path, 'symbol,close\nAAPL,100\n');
    const sink = new CSVSink(path, 'a');

    sink.write({close: 200, symbol: 'NVDA'});
    sink.complete();
    await sink.completion;

    expect(readFileSync(path, 'utf8')).toBe(
      'symbol,close\nAAPL,100\nNVDA,200\n',
    );
  });

  test('rejects append rows with missing or additional columns', async () => {
    const path = outputPath();
    writeFileSync(path, 'symbol,close\nAAPL,100\n');
    const sink = new CSVSink(path, 'a');

    sink.write({symbol: 'NVDA', extra: true});

    await expect(sink.completion).rejects.toThrow('CSV columns do not match');
    expect(readFileSync(path, 'utf8')).toBe('symbol,close\nAAPL,100\n');
  });

  test('creates an empty file when overwrite has no schema or rows', async () => {
    const path = outputPath();
    const sink = new CSVSink(path, 'w');

    sink.complete();
    await sink.completion;

    expect(readFileSync(path, 'utf8')).toBe('');
  });
});

describe('StdoutSink', () => {
  test('prints every formatted value immediately without a completion Promise', () => {
    const lines: string[] = [];
    const sink = new StdoutSink<{value: number}>(
      value => `value=${value.value}`,
      line => lines.push(line),
    );

    sink.write({value: 1});
    sink.write({value: 2});
    expect(lines).toEqual(['value=1', 'value=2']);
    sink.complete();
    expect('completion' in sink).toBe(false);
  });
});
