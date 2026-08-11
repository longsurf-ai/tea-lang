// Purpose: Exercise the production TypeGPU backtest kernel against CPU replay through Node Dawn.

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

test('matches the CPU exchange journal and summary on Dawn', async () => {
  const cli = path.resolve(process.cwd(), 'dist/cli.js');
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'tea-typegpu-parity-'),
  );
  const artifactDirectory = path.join(temporaryDirectory, 'artifacts');
  try {
    const {stdout} = await execFileAsync(process.execPath, [
      cli,
      'parity-smoke',
      '--output',
      artifactDirectory,
    ]);
    const result: unknown = JSON.parse(stdout);
    assert.equal(
      (result as {status?: unknown}).status,
      'ok',
      `Unexpected parity result: ${stdout}`,
    );

    const manifest: unknown = JSON.parse(
      await readFile(path.join(artifactDirectory, 'manifest.json'), 'utf8'),
    );
    assert.equal((manifest as {complete?: unknown}).complete, true);
    assert.equal((manifest as {jobCount?: unknown}).jobCount, 1);
    assert.equal(
      (await stat(path.join(artifactDirectory, 'equity.f32le'))).size,
      11 * 4,
    );
  } finally {
    await rm(temporaryDirectory, {recursive: true, force: true});
  }
});

test('fails loudly instead of truncating an undersized GPU journal', async () => {
  const cli = path.resolve(process.cwd(), 'dist/cli.js');
  const {stdout} = await execFileAsync(process.execPath, [
    cli,
    'overflow-smoke',
  ]);
  const result = JSON.parse(stdout) as {
    attemptedEventCount?: unknown;
    eventCapacity?: unknown;
    status?: unknown;
  };
  assert.equal(result.status, 'ok');
  assert.equal(result.attemptedEventCount, 6);
  assert.equal(result.eventCapacity, 1);
});
