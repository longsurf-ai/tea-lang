// Purpose: Configured execution compiles once, resolves bindings, and owns target disposal.

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Errors} from '../base/print';
import {compileToProgram, hashProgramSourceClosure} from '../compile';
import type {ExecutionConfig} from './config';
import {
  executeConfiguredProgram,
  executeLoadedConfig,
  executeLoadedSweepScenario,
  selectSweepScenarioConfig,
} from './run';

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
    expect(result.timeNow).toBe(123);
    expect(result.providerBytesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('selects one sweep binding as an ordinary isolated run', () => {
    const errors = new Errors();
    const program = compileToProgram([SOURCE], errors);
    if (program === null) throw new Error('fixture did not compile');
    const selected = selectSweepScenarioConfig(
      program,
      {
        ...config('sweep'),
        execution: {
          kind: 'sweep',
          provider: {kind: 'csv', path: '/data.csv'},
          parameters: {
            scale: {range: {start: 1, stop: 2, step: 0.5}},
            initial_cash: 1,
          },
          maxExecutions: 3,
        },
      },
      1,
      456,
    );
    expect(selected.execution).toEqual({
      kind: 'run',
      provider: {kind: 'csv', path: '/data.csv'},
      parameters: {scale: 1.5, initial_cash: 1},
      timeNow: 456,
    });
    expect(() =>
      selectSweepScenarioConfig(program, config('sweep'), 1),
    ).toThrow('outside sweep binding range');
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

  test('loaded execution hashes the root and builtin source closure', async () => {
    const result = await executeLoadedConfig(
      {
        configPath: '/run.yaml',
        baseDirectory: '/',
        bytesHash: '0'.repeat(64),
        config: config('run'),
      },
      new Errors(),
      {
        readFileBytes: async () => CSV,
        sinkForExecution: () => ({declare() {}, publish() {}}),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.programBytesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('selected replay rejects nested request contexts before provider I/O', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tea-request-replay-'));
    const source = join(directory, 'requests.tea');
    writeFileSync(
      source,
      [
        'scale = input.float(1.0)',
        'value = request.security("X", "D", request.security("Y", "W", close) * scale)',
        'plot(value)',
      ].join('\n'),
    );
    let providerReads = 0;
    try {
      await expect(
        executeLoadedSweepScenario(
          {
            configPath: join(directory, 'sweep.yaml'),
            baseDirectory: directory,
            bytesHash: '0'.repeat(64),
            config: {
              ...config('sweep'),
              program: {source},
            },
          },
          0,
          123,
          hashProgramSourceClosure([source]),
          new Errors(),
          {
            readFileBytes: async () => {
              providerReads++;
              return CSV;
            },
            sinkForExecution: () => ({declare() {}, publish() {}}),
          },
        ),
      ).rejects.toThrow(
        'cannot run a Program with request edges (found 2): non-primary provider contexts are not captured',
      );
      expect(providerReads).toBe(0);
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
