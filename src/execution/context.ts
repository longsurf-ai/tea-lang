// Purpose: Resolve one validated execution config into provider-backed, backend-neutral Program bindings.

import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {decodeUtf8, FileError} from '../base/files';
import {paramSpecsOf} from '../codegen/params';
import type {Program} from '../ir/program';
import {builtinSources} from '../providers/data/builtin-sources';
import {csvProvider} from '../providers/data/csv';
import type {BindInputs, DataProvider, OutputSink} from '../runtime/abi';
import type {CsvProviderConfig} from './config';
import {ExecutionConfigError, type ExecutionConfig} from './config';
import {resolveExecutionParameters, type SweepRange} from './parameters';

export interface ExecutionContext {
  readonly ranges: readonly SweepRange[];
  readonly bindings: readonly BindInputs[];
  readonly timeNow: number;
  readonly providerHash?: string;
}

export interface ExecutionDependencies {
  readonly readFileBytes?: (path: string) => Promise<Uint8Array>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly providerFactory?: ExecutionProviderFactory;
  readonly now?: () => number;
  readonly sinkForExecution: (executionIndex: number) => OutputSink;
}

export interface ExecutionProviderFactoryDependencies {
  readonly readFileBytes: (path: string) => Promise<Uint8Array>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
}

export type ExecutionProviderFactory = (
  config: CsvProviderConfig,
  dependencies: ExecutionProviderFactoryDependencies,
) => Promise<DataProvider>;

interface ProviderInput {
  readonly provider: DataProvider;
  readonly hash?: string;
}

// Provider construction belongs to this host-side context boundary. One
// provider instance and one clock value are shared by all isolated bindings.
export async function createExecutionContext(
  program: Program,
  config: ExecutionConfig,
  dependencies: ExecutionDependencies,
): Promise<ExecutionContext> {
  const parameters = resolveExecutionParameters(
    paramSpecsOf(program.params),
    config.execution,
  );
  const providerInput = await loadProvider(
    config.execution.provider,
    dependencies,
  );
  const provider = providerInput.provider;
  const timeNow = resolveTimeNow(config, dependencies.now ?? Date.now);
  const bindings = parameters.sets.map(
    (params, executionIndex): BindInputs => ({
      params,
      provider,
      sink: dependencies.sinkForExecution(executionIndex),
      timeNow,
    }),
  );
  return {
    ranges: parameters.ranges,
    bindings,
    timeNow,
    ...(providerInput.hash === undefined
      ? {}
      : {providerHash: providerInput.hash}),
  };
}

async function loadProvider(
  config: CsvProviderConfig,
  dependencies: ExecutionDependencies,
): Promise<ProviderInput> {
  const factoryDependencies = {
    readFileBytes: dependencies.readFileBytes ?? defaultReadFileBytes,
    environment: dependencies.environment,
    fetchImpl: dependencies.fetchImpl,
  };
  if (dependencies.providerFactory !== undefined) {
    return {
      provider: await dependencies.providerFactory(config, factoryDependencies),
    };
  }
  return loadCsvProvider(config, factoryDependencies);
}

async function loadCsvProvider(
  config: CsvProviderConfig,
  dependencies: ExecutionProviderFactoryDependencies,
): Promise<ProviderInput> {
  let bytes: Uint8Array;
  try {
    bytes = await dependencies.readFileBytes(config.path);
  } catch (error) {
    throw new ExecutionConfigError(
      `cannot read CSV provider '${config.path}': ${errorMessage(error)}`,
    );
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (config.sha256 !== undefined) {
    if (actual !== config.sha256) {
      throw new ExecutionConfigError(
        `CSV provider '${config.path}' has SHA-256 ${actual}, expected ${config.sha256}`,
      );
    }
  }
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch (error) {
    if (!(error instanceof FileError) || error.kind !== 'invalid-utf8') {
      throw error;
    }
    throw new ExecutionConfigError(
      `CSV provider '${config.path}' is not valid UTF-8`,
    );
  }
  return {
    provider: builtinSources({
      primary: csvProvider(text),
      config: dependencies.environment,
      fetchImpl: dependencies.fetchImpl,
    }),
    hash: actual,
  };
}

function resolveTimeNow(config: ExecutionConfig, now: () => number): number {
  const value = config.execution.timeNow ?? now();
  if (!Number.isSafeInteger(value)) {
    throw new ExecutionConfigError(
      'execution.timeNow must be a finite safe epoch-ms integer',
    );
  }
  return value;
}

async function defaultReadFileBytes(path: string): Promise<Uint8Array> {
  return readFile(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
