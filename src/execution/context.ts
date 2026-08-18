// Purpose: Resolve one validated execution config into provider-backed, target-neutral Program bindings.

import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {decodeUtf8, FileError} from '../base/files';
import {paramSpecsOf} from '../codegen/params';
import type {Program} from '../ir/program';
import {builtinSources} from '../providers/data/builtin-sources';
import {csvProvider} from '../providers/data/csv';
import type {BindInputs, DataProvider, OutputSink} from '../runtime/abi';
import type {CsvProviderConfig, RuntimeConfig} from './config';
import {ExecutionConfigError, type ExecutionConfig} from './config';
import {
  resolveExecutionParameters,
  type ResolvedParameterAxis,
} from './parameters';

export interface ResolvedExecutionContext {
  readonly kind: 'run' | 'sweep';
  readonly axes: readonly ResolvedParameterAxis[];
  readonly bindings: readonly BindInputs[];
  readonly runtime: RuntimeConfig;
  readonly timeNow: number;
  readonly providerBytesHash?: string;
}

export interface ExecutionContextDependencies {
  readonly readFileBytes?: (path: string) => Promise<Uint8Array>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly providerFactory?: ExecutionProviderFactory;
  readonly now?: () => number;
  readonly sinkForExecution: (executionIndex: number) => OutputSink;
  readonly expectedProviderBytesHash?: string;
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

interface ResolvedProvider {
  readonly provider: DataProvider;
  readonly bytesHash?: string;
}

// Provider construction belongs to this host-side context boundary. One
// provider instance and one clock value are shared by all isolated bindings.
export async function resolveExecutionContext(
  program: Program,
  config: ExecutionConfig,
  dependencies: ExecutionContextDependencies,
): Promise<ResolvedExecutionContext> {
  const parameters = resolveExecutionParameters(
    paramSpecsOf(program.params),
    config.execution,
  );
  const resolvedProvider = await createProvider(config, dependencies);
  const provider = resolvedProvider.provider;
  const timeNow = resolveTimeNow(config, dependencies.now ?? Date.now);
  const bindings = parameters.parameterSets.map(
    (params, executionIndex): BindInputs => ({
      params,
      provider,
      sink: dependencies.sinkForExecution(executionIndex),
      timeNow,
    }),
  );
  return {
    kind: config.execution.kind,
    axes: parameters.axes,
    bindings,
    runtime: config.runtime,
    timeNow,
    ...(resolvedProvider.bytesHash === undefined
      ? {}
      : {providerBytesHash: resolvedProvider.bytesHash}),
  };
}

async function createProvider(
  config: ExecutionConfig,
  dependencies: ExecutionContextDependencies,
): Promise<ResolvedProvider> {
  const factoryDependencies = {
    readFileBytes: dependencies.readFileBytes ?? defaultReadFileBytes,
    environment: dependencies.environment,
    fetchImpl: dependencies.fetchImpl,
  };
  if (dependencies.providerFactory !== undefined) {
    return {
      provider: await dependencies.providerFactory(
        config.execution.provider,
        factoryDependencies,
      ),
    };
  }
  return createCsvExecutionProviderSnapshot(
    config.execution.provider,
    factoryDependencies,
    dependencies.expectedProviderBytesHash,
  );
}

export async function createCsvExecutionProvider(
  config: CsvProviderConfig,
  dependencies: ExecutionProviderFactoryDependencies,
): Promise<DataProvider> {
  return (await createCsvExecutionProviderSnapshot(config, dependencies))
    .provider;
}

async function createCsvExecutionProviderSnapshot(
  config: CsvProviderConfig,
  dependencies: ExecutionProviderFactoryDependencies,
  expectedBytesHash?: string,
): Promise<ResolvedProvider> {
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
  if (expectedBytesHash !== undefined && actual !== expectedBytesHash) {
    throw new ExecutionConfigError(
      `CSV provider '${config.path}' changed after sweep: SHA-256 ${actual}, expected ${expectedBytesHash}`,
    );
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
    bytesHash: actual,
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
