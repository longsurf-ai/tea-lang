// Purpose: Public package examples execute against deterministic local CSV data.

import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {run as csvRequestToCSV} from '../examples/api/csv-request-to-csv';
import {run as csvToCSV} from '../examples/api/csv-to-csv';
import {run as csvToStdout} from '../examples/api/csv-to-stdout';

const INPUT = fileURLToPath(new URL('fixtures/cli/data.csv', import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function output(): string {
  const directory = mkdtempSync(join(process.cwd(), '.api-example-test-'));
  directories.push(directory);
  return join(directory, 'output.csv');
}

describe('API examples', () => {
  test('runs CSV through Tea into CSV', async () => {
    const path = output();

    await csvToCSV(INPUT, path);

    expect(readFileSync(path, 'utf8')).toBe(
      'output_0,output_1,effects,provisional\n-1,0,[],false\n1,1,[],false\n',
    );
  });

  test('runs two CSV streams through a scalar request', async () => {
    const path = output();

    await csvRequestToCSV(INPUT, INPUT, path);

    expect(readFileSync(path, 'utf8')).toBe(
      'output_0,output_1,effects,provisional\n0,2,[],false\n0,4,[],false\n',
    );
  });

  test('prints each output datum incrementally', async () => {
    const lines: string[] = [];

    const subscription = await csvToStdout(INPUT, line => lines.push(line));
    await vi.waitFor(() => expect(subscription.closed).toBe(true));

    expect(lines).toEqual([
      '{"output_0":-1,"effects":[],"provisional":false}',
      '{"output_0":4,"effects":[],"provisional":false}',
    ]);
  });
});
