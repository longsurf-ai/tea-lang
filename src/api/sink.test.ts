// Purpose: CSVSink Observer lifecycle, schema validation, and CSV encoding.

import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {of} from 'rxjs';
import {afterEach, describe, expect, test} from 'vitest';
import * as z from 'zod';
import {CSVSink} from './sink';

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
});
