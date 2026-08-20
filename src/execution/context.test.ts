// Purpose: Execution context resolution constructs one verified provider and complete ordered Program bindings.

import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {Errors} from '../base/print';
import {compileToProgram} from '../compile';
import type {Program} from '../ir/program';
import {
  isContextError,
  type DataProvider,
  type OutputSink,
} from '../runtime/abi';
import type {ExecutionConfig} from './config';
import {ExecutionConfigError} from './config';
import {createExecutionContext} from './context';

const SOURCE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/cli/parameter-report.tea',
);
const CSV = new TextEncoder().encode('time,close\n100,1\n200,2\n');

describe('execution context', () => {
  test('constructs one CSV source and ordered sweep bindings', async () => {
    let reads = 0;
    let clockCalls = 0;
    const sinks: OutputSink[] = [];
    const context = await createExecutionContext(
      program(),
      config({
        kind: 'sweep',
        provider: {
          kind: 'csv',
          path: '/data/bars.csv',
          sha256: createHash('sha256').update(CSV).digest('hex'),
        },
        parameters: {
          scale: 2,
          initial_cash: {range: {start: 1, stop: 3, step: 1}},
        },
        maxExecutions: 3,
      }),
      {
        async readFileBytes(path) {
          reads++;
          expect(path).toBe('/data/bars.csv');
          return CSV;
        },
        now() {
          clockCalls++;
          return 1_800_000_000_000;
        },
        sinkForExecution(index) {
          expect(index).toBe(sinks.length);
          const sink: OutputSink = {declare() {}, publish() {}};
          sinks.push(sink);
          return sink;
        },
      },
    );

    expect(reads).toBe(1);
    expect(clockCalls).toBe(1);
    expect(context.providerHash).toBe(
      createHash('sha256').update(CSV).digest('hex'),
    );
    expect(context.ranges).toEqual([{name: 'initial_cash', values: [1, 2, 3]}]);
    expect(context.bindings.map(binding => binding.params)).toEqual([
      {scale: 2, initial_cash: 1},
      {scale: 2, initial_cash: 2},
      {scale: 2, initial_cash: 3},
    ]);
    expect(context.bindings.map(binding => binding.timeNow)).toEqual([
      1_800_000_000_000, 1_800_000_000_000, 1_800_000_000_000,
    ]);
    expect(context.bindings.map(binding => binding.sink)).toEqual(sinks);
    expect(
      new Set(context.bindings.map(binding => binding.provider)).size,
    ).toBe(1);
    const primary = await context.bindings[0]!.provider.resolveContext('', '', {
      kind: 'full',
    });
    if (isContextError(primary)) throw new Error(primary.detail);
    expect(primary.rows).toBe(2);
    expect(primary.series('close')?.at(1)).toBe(2);
  });

  test('configured timeNow does not read the host clock', async () => {
    let clockCalls = 0;
    const context = await createExecutionContext(
      program(),
      config({
        kind: 'run',
        provider: {kind: 'csv', path: '/data/bars.csv'},
        parameters: {},
        timeNow: 123,
      }),
      {
        readFileBytes: async () => CSV,
        now: () => {
          clockCalls++;
          return 456;
        },
        sinkForExecution: () => ({declare() {}, publish() {}}),
      },
    );

    expect(clockCalls).toBe(0);
    expect(context.bindings).toHaveLength(1);
    expect(context.bindings[0]!.timeNow).toBe(123);
  });

  test('invokes an injected provider factory once with host dependencies', async () => {
    const environment = {FRED_API_KEY: 'secret'};
    const fetchImpl = (() =>
      Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const readFileBytes = async () => CSV;
    const provider: DataProvider = {
      resolveContext: async () => ({
        rows: 0,
        axis: null,
        series: () => null,
        builtinValue: () => undefined,
      }),
    };
    let factoryCalls = 0;
    const context = await createExecutionContext(
      program(),
      config({
        kind: 'sweep',
        provider: {kind: 'csv', path: '/data/bars.csv'},
        parameters: {initial_cash: {range: {start: 1, stop: 2, step: 1}}},
      }),
      {
        readFileBytes,
        environment,
        fetchImpl,
        async providerFactory(providerConfig, dependencies) {
          factoryCalls++;
          expect(providerConfig).toEqual({
            kind: 'csv',
            path: '/data/bars.csv',
          });
          expect(dependencies.readFileBytes).toBe(readFileBytes);
          expect(dependencies.environment).toBe(environment);
          expect(dependencies.fetchImpl).toBe(fetchImpl);
          return provider;
        },
        now: () => 0,
        sinkForExecution: () => ({declare() {}, publish() {}}),
      },
    );

    expect(factoryCalls).toBe(1);
    expect(context.bindings).toHaveLength(2);
    expect(
      context.bindings.every(binding => binding.provider === provider),
    ).toBe(true);
  });

  test('hashes exact bytes before strict UTF-8 decoding', async () => {
    const wrongHash = '0'.repeat(64);
    await expect(
      createExecutionContext(
        program(),
        config({
          kind: 'run',
          provider: {
            kind: 'csv',
            path: '/data/bars.csv',
            sha256: wrongHash,
          },
          parameters: {},
        }),
        dependencies(Uint8Array.of(0xff)),
      ),
    ).rejects.toThrow(/SHA-256 .* expected 000000/);

    const invalid = Uint8Array.of(0xff);
    await expect(
      createExecutionContext(
        program(),
        config({
          kind: 'run',
          provider: {
            kind: 'csv',
            path: '/data/bars.csv',
            sha256: createHash('sha256').update(invalid).digest('hex'),
          },
          parameters: {},
        }),
        dependencies(invalid),
      ),
    ).rejects.toThrow("CSV provider '/data/bars.csv' is not valid UTF-8");
  });

  test('wraps provider reads and rejects an invalid captured clock', async () => {
    await expect(
      createExecutionContext(
        program(),
        config({
          kind: 'run',
          provider: {kind: 'csv', path: '/missing.csv'},
          parameters: {},
        }),
        {
          readFileBytes: async () => {
            throw new Error('not a regular file');
          },
          sinkForExecution: () => ({declare() {}, publish() {}}),
        },
      ),
    ).rejects.toThrow(
      "cannot read CSV provider '/missing.csv': not a regular file",
    );

    await expect(
      createExecutionContext(
        program(),
        config({
          kind: 'run',
          provider: {kind: 'csv', path: '/data/bars.csv'},
          parameters: {},
        }),
        {
          readFileBytes: async () => CSV,
          now: () => 1.5,
          sinkForExecution: () => ({declare() {}, publish() {}}),
        },
      ),
    ).rejects.toBeInstanceOf(ExecutionConfigError);
  });
});

function program(): Program {
  const errors = new Errors();
  const result = compileToProgram([SOURCE], errors);
  if (result === null) {
    throw new Error(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  return result;
}

function config(execution: ExecutionConfig['execution']): ExecutionConfig {
  return {
    schema: 'tea.execution/v1',
    program: {source: '/strategy.tea'},
    runtime: {kind: 'javascript'},
    execution,
  };
}

function dependencies(bytes: Uint8Array) {
  return {
    readFileBytes: async () => bytes,
    sinkForExecution: () => ({declare() {}, publish() {}}),
  };
}
