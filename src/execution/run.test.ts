// Purpose: Config execution compiles once, resolves bindings, and owns backend disposal.

import {describe, expect, test} from 'vitest';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Errors} from '../base/print';
import {compileToProgram} from '../compiler';
import type {ExecutionConfig} from './config';
import {runProgram} from './run';

const SOURCE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/cli/parameter-report.tea',
);
const CSV = new TextEncoder().encode('time,close\n100,1\n200,2\n');

describe('config execution', () => {
  test('runs a compiled Program and releases its backend', async () => {
    const errors = new Errors();
    const program = compileToProgram([SOURCE], errors);
    if (program === null) throw new Error('fixture did not compile');
    const result = await runProgram(program, config('run'), {
      readFileBytes: async () => CSV,
      now: () => 123,
      sinkForExecution: () => ({declare() {}, publish() {}}),
    });
    expect(result.kind).toBe('run');
    expect(result.summary.backend).toBe('cpu');
    expect(result.summary.bindings).toHaveLength(1);
    expect(result.summary.bindings[0]?.rows).toBe(2);
    expect(result.timeNow).toBe(123);
    expect(result.providerHash).toMatch(/^[0-9a-f]{64}$/);
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
