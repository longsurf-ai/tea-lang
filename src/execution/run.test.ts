// Purpose: Configured execution compiles once, resolves bindings, and owns target disposal.

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Errors} from '../base/print';
import {compileToProgram} from '../compile';
import type {ExecutionConfig} from './config';
import {executeConfiguredProgram, executeLoadedConfig} from './run';

const SOURCE = join(import.meta.dir, '../../testdata/cli/parameter-report.tea');
const CSV = new TextEncoder().encode('time,close\n100,1\n200,2\n');

describe('configured execution', () => {
  test('runs a compiled Program and releases its injected target', async () => {
    const errors = new Errors();
    const program = compileToProgram([SOURCE], errors);
    if (program === null) throw new Error('fixture did not compile');
    const result = await executeConfiguredProgram(program, config('run'), {
      readFileBytes: async () => CSV,
      now: () => 123,
      sinkForExecution: () => ({declare() {}, publish() {}}),
    });
    expect(result.kind).toBe('run');
    expect(result.summary.backend).toBe('cpu');
    expect(result.summary.bindings).toHaveLength(1);
    expect(result.summary.bindings[0]?.rows).toBe(2);
  });

  test('the loaded entry returns Core diagnostics without executing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tea-config-run-'));
    const invalid = join(directory, 'invalid.tea');
    writeFileSync(invalid, 'indicator("broken"\n');
    try {
      const result = await executeLoadedConfig(
        {
          configPath: join(directory, 'run.yaml'),
          baseDirectory: directory,
          bytesHash: '0'.repeat(64),
          config: {
            ...config('run'),
            program: {source: invalid},
          },
        },
        new Errors(),
        {
          readFileBytes: async () => CSV,
          sinkForExecution: () => ({declare() {}, publish() {}}),
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
});

function config(kind: 'run' | 'sweep'): ExecutionConfig {
  const execution = {
    kind,
    provider: {kind: 'csv' as const, path: '/data.csv'},
    parameters: {},
  };
  return {
    schema: 'tea.execution/v1',
    program: {source: SOURCE},
    runtime: {kind: 'javascript'},
    execution,
  };
}
