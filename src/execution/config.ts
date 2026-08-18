// Purpose: Load and strictly validate one versioned Tea execution configuration snapshot.

import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node,
  type Pair,
  type ParsedNode,
  type Scalar,
  type YAMLMap,
} from 'yaml';
import {
  decodeUtf8,
  FileError,
  readFileBytes,
  resolveReadableFile,
} from '../base/files';

export const EXECUTION_CONFIG_SCHEMA = 'tea.execution/v1' as const;
export const MAX_EXECUTION_CONFIG_BYTES = 1024 * 1024;
export const MAX_EXECUTION_CONFIG_DEPTH = 64;
export const MAX_EXECUTION_CONFIG_NODES = 10_000;
export const MAX_EXECUTION_CONFIG_COLLECTION_ENTRIES = 10_000;
export const MAX_EXECUTIONS = 10_000;

const MAX_U32 = 0xffff_ffff;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

export type ParameterScalar = number | string | boolean;

export interface NumericRange {
  readonly range: {
    readonly start: number;
    readonly stop: number;
    readonly step: number;
  };
}

export type ParameterSelection = ParameterScalar | NumericRange;

export interface ProgramConfig {
  readonly source: string;
}

export interface JavaScriptRuntimeConfig {
  readonly kind: 'javascript';
}

export interface WebGpuRuntimeConfig {
  readonly kind: 'webgpu';
  readonly maxRowsPerChunk?: number;
  readonly effectRecordsPerExecution?: number;
  readonly maxGpuBytes?: number;
  readonly maxCacheBytesPerWorkgroup?: number;
}

export type RuntimeConfig = JavaScriptRuntimeConfig | WebGpuRuntimeConfig;

export interface CsvProviderConfig {
  readonly kind: 'csv';
  readonly path: string;
  readonly sha256?: string;
}

interface ExecutionConfigBase {
  readonly provider: CsvProviderConfig;
  readonly parameters: Readonly<Record<string, ParameterSelection>>;
  readonly timeNow?: number;
}

export interface RunExecutionConfig extends ExecutionConfigBase {
  readonly kind: 'run';
}

export interface SweepExecutionConfig extends ExecutionConfigBase {
  readonly kind: 'sweep';
  readonly maxExecutions?: number;
}

export interface ExecutionConfig {
  readonly schema: typeof EXECUTION_CONFIG_SCHEMA;
  readonly program: ProgramConfig;
  readonly runtime: RuntimeConfig;
  readonly execution: RunExecutionConfig | SweepExecutionConfig;
}

export interface LoadedExecutionConfig {
  readonly configPath: string;
  readonly baseDirectory: string;
  readonly bytesHash: string;
  readonly config: ExecutionConfig;
}

export class ExecutionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionConfigError';
  }
}

export function loadExecutionConfig(
  configArgument: string,
): LoadedExecutionConfig {
  try {
    const configPath = resolve(configArgument);
    const baseDirectory = dirname(configPath);
    const bytes = readFileBytes(
      configPath,
      'execution config',
      MAX_EXECUTION_CONFIG_BYTES,
    );
    let source: string;
    try {
      source = decodeUtf8(bytes);
    } catch (error) {
      if (error instanceof FileError && error.kind === 'invalid-utf8') {
        throw new ExecutionConfigError('execution config must be valid UTF-8');
      }
      throw error;
    }
    const parsed = parseConfig(source);
    const programSource = resolveReadableFile(
      baseDirectory,
      parsed.program.source,
      'program.source',
    );
    const providerPath = resolveReadableFile(
      baseDirectory,
      parsed.execution.provider.path,
      'execution.provider.path',
    );
    const config = object({
      ...parsed,
      program: object({...parsed.program, source: programSource}),
      execution: object({
        ...parsed.execution,
        provider: object({
          ...parsed.execution.provider,
          path: providerPath,
        }),
      }),
    });
    return Object.freeze({
      configPath,
      baseDirectory,
      bytesHash: createHash('sha256').update(bytes).digest('hex'),
      config,
    });
  } catch (error) {
    if (error instanceof FileError) {
      throw new ExecutionConfigError(error.message);
    }
    throw error;
  }
}

function parseConfig(source: string): ExecutionConfig {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(source, {
      version: '1.2',
      schema: 'core',
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      merge: false,
      resolveKnownTags: false,
      prettyErrors: true,
    });
  } catch (error) {
    throw yamlError(error);
  }
  if (documents.length !== 1) {
    throw new ExecutionConfigError(
      'execution config must contain exactly one YAML document',
    );
  }
  const document = documents[0]!;
  if (document.errors.length > 0) {
    throw new ExecutionConfigError(
      `invalid execution config: ${document.errors[0]!.message}`,
    );
  }
  if (document.warnings.length > 0) {
    throw new ExecutionConfigError(
      `invalid execution config: ${document.warnings[0]!.message}`,
    );
  }
  if (
    document.directives?.yaml.explicit === true ||
    Object.keys(document.directives?.tags ?? {}).some(tag => tag !== '!!')
  ) {
    throw new ExecutionConfigError(
      'execution config does not accept explicit YAML directives',
    );
  }
  const root = document.contents;
  if (root === null) {
    throw new ExecutionConfigError('execution config must be a mapping');
  }
  validateAst(root as Node);
  return buildConfig(mapping(root, 'execution config'));
}

function validateAst(root: Node): void {
  let nodes = 0;
  const walk = (node: Node, depth: number): void => {
    if (depth > MAX_EXECUTION_CONFIG_DEPTH) {
      throw new ExecutionConfigError(
        `execution config exceeds the ${MAX_EXECUTION_CONFIG_DEPTH} level depth limit`,
      );
    }
    nodes++;
    if (nodes > MAX_EXECUTION_CONFIG_NODES) {
      throw new ExecutionConfigError(
        `execution config exceeds the ${MAX_EXECUTION_CONFIG_NODES} node limit`,
      );
    }
    if (isAlias(node)) {
      throw new ExecutionConfigError(
        'execution config does not accept aliases',
      );
    }
    if ('anchor' in node && node.anchor !== undefined) {
      throw new ExecutionConfigError(
        'execution config does not accept anchors',
      );
    }
    if (node.tag !== undefined) {
      throw new ExecutionConfigError(
        'execution config does not accept explicit YAML tags',
      );
    }
    if (isMap(node)) {
      if (node.items.length > MAX_EXECUTION_CONFIG_COLLECTION_ENTRIES) {
        throw new ExecutionConfigError(
          `execution config mapping exceeds the ${MAX_EXECUTION_CONFIG_COLLECTION_ENTRIES} entry limit`,
        );
      }
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
          throw new ExecutionConfigError(
            'execution config mapping keys must be strings',
          );
        }
        if (pair.key.value === '<<') {
          throw new ExecutionConfigError(
            'execution config does not accept merge keys',
          );
        }
        walk(pair.key as Node, depth + 1);
        if (pair.value === null) {
          throw new ExecutionConfigError(
            `execution config value '${pair.key.value}' must not be empty`,
          );
        }
        walk(pair.value as Node, depth + 1);
      }
      return;
    }
    if (isSeq(node)) {
      if (node.items.length > MAX_EXECUTION_CONFIG_COLLECTION_ENTRIES) {
        throw new ExecutionConfigError(
          `execution config sequence exceeds the ${MAX_EXECUTION_CONFIG_COLLECTION_ENTRIES} entry limit`,
        );
      }
      for (const item of node.items) walk(item as Node, depth + 1);
      return;
    }
    if (!isScalar(node)) {
      throw new ExecutionConfigError(
        'execution config contains an unsupported YAML node',
      );
    }
  };
  walk(root, 1);
}

function buildConfig(root: YAMLMap<unknown, unknown>): ExecutionConfig {
  fields(root, 'execution config', [
    'schema',
    'program',
    'runtime',
    'execution',
  ]);
  const schema = literalString(root, 'schema', 'execution config');
  if (schema !== EXECUTION_CONFIG_SCHEMA) {
    throw new ExecutionConfigError(
      `unsupported execution config schema '${schema}'`,
    );
  }
  return object({
    schema: EXECUTION_CONFIG_SCHEMA,
    program: buildProgram(requiredMap(root, 'program', 'execution config')),
    runtime: buildRuntime(requiredMap(root, 'runtime', 'execution config')),
    execution: buildExecution(
      requiredMap(root, 'execution', 'execution config'),
    ),
  });
}

function buildProgram(map: YAMLMap<unknown, unknown>): ProgramConfig {
  fields(map, 'program', ['source']);
  return object({source: nonemptyString(map, 'source', 'program')});
}

function buildRuntime(map: YAMLMap<unknown, unknown>): RuntimeConfig {
  const kind = literalString(map, 'kind', 'runtime');
  if (kind === 'javascript') {
    fields(map, 'runtime', ['kind']);
    return object({kind});
  }
  if (kind === 'webgpu') {
    fields(map, 'runtime', [
      'kind',
      'maxRowsPerChunk',
      'effectRecordsPerExecution',
      'maxGpuBytes',
      'maxCacheBytesPerWorkgroup',
    ]);
    return object({
      kind,
      ...optionalInteger(map, 'maxRowsPerChunk', true),
      ...optionalInteger(map, 'effectRecordsPerExecution', false),
      ...optionalInteger(map, 'maxGpuBytes', true),
      ...optionalInteger(map, 'maxCacheBytesPerWorkgroup', false),
    });
  }
  throw new ExecutionConfigError(
    `runtime.kind must be 'javascript' or 'webgpu'`,
  );
}

function buildExecution(
  map: YAMLMap<unknown, unknown>,
): RunExecutionConfig | SweepExecutionConfig {
  const kind = literalString(map, 'kind', 'execution');
  const shared = [
    'kind',
    'provider',
    'parameters',
    'timeNow',
    'maxExecutions',
  ] as const;
  if (kind !== 'run' && kind !== 'sweep') {
    throw new ExecutionConfigError(`execution.kind must be 'run' or 'sweep'`);
  }
  fields(map, 'execution', shared);
  if (kind === 'run' && has(map, 'maxExecutions')) {
    throw new ExecutionConfigError(
      'run execution does not accept maxExecutions',
    );
  }
  const common = {
    provider: buildProvider(requiredMap(map, 'provider', 'execution')),
    parameters: buildParameters(optionalMap(map, 'parameters', 'execution')),
    ...optionalTimeNow(map),
  };
  return kind === 'run'
    ? object({kind, ...common})
    : object({kind, ...common, ...optionalMaxExecutions(map)});
}

function buildProvider(map: YAMLMap<unknown, unknown>): CsvProviderConfig {
  fields(map, 'execution.provider', ['kind', 'path', 'sha256']);
  const kind = literalString(map, 'kind', 'execution.provider');
  if (kind !== 'csv') {
    throw new ExecutionConfigError(`execution.provider.kind must be 'csv'`);
  }
  const hash = optionalScalar(map, 'sha256');
  if (
    hash !== undefined &&
    (typeof hash.value !== 'string' || !SHA256_PATTERN.test(hash.value))
  ) {
    throw new ExecutionConfigError(
      'execution.provider.sha256 must be exactly 64 hexadecimal characters',
    );
  }
  return object({
    kind,
    path: nonemptyString(map, 'path', 'execution.provider'),
    ...(hash === undefined ? {} : {sha256: String(hash.value).toLowerCase()}),
  });
}

function buildParameters(
  map: YAMLMap<unknown, unknown> | undefined,
): Readonly<Record<string, ParameterSelection>> {
  const result: Record<string, ParameterSelection> = Object.create(null);
  if (map === undefined) return Object.freeze(result);
  for (const pair of map.items) {
    const key = scalarKey(pair);
    if (pair.value === null) {
      throw new ExecutionConfigError(`parameter '${key}' must not be empty`);
    }
    if (isScalar(pair.value)) {
      const value = pair.value.value;
      if (
        (typeof value !== 'number' || !Number.isFinite(value)) &&
        typeof value !== 'string' &&
        typeof value !== 'boolean'
      ) {
        throw new ExecutionConfigError(
          `parameter '${key}' must be a finite number, string, boolean, or numeric range`,
        );
      }
      result[key] = value;
      continue;
    }
    result[key] = buildRange(
      mapping(pair.value as Node, `parameter '${key}'`),
      key,
    );
  }
  return Object.freeze(result);
}

function buildRange(
  map: YAMLMap<unknown, unknown>,
  parameter: string,
): NumericRange {
  fields(map, `parameter '${parameter}'`, ['range']);
  const range = requiredMap(map, 'range', `parameter '${parameter}'`);
  fields(range, `parameter '${parameter}'.range`, ['start', 'stop', 'step']);
  return object({
    range: object({
      start: finiteNumber(range, 'start', `parameter '${parameter}'.range`),
      stop: finiteNumber(range, 'stop', `parameter '${parameter}'.range`),
      step: finiteNumber(range, 'step', `parameter '${parameter}'.range`),
    }),
  });
}

function mapping(node: Node, label: string): YAMLMap<unknown, unknown> {
  if (!isMap(node)) {
    throw new ExecutionConfigError(`${label} must be a mapping`);
  }
  return node;
}

function requiredMap(
  map: YAMLMap<unknown, unknown>,
  key: string,
  label: string,
): YAMLMap<unknown, unknown> {
  const value = requiredNode(map, key, label);
  return mapping(value, `${label}.${key}`);
}

function optionalMap(
  map: YAMLMap<unknown, unknown>,
  key: string,
  label: string,
): YAMLMap<unknown, unknown> | undefined {
  const value = node(map, key);
  return value === undefined ? undefined : mapping(value, `${label}.${key}`);
}

function requiredNode(
  map: YAMLMap<unknown, unknown>,
  key: string,
  label: string,
): ParsedNode {
  const value = node(map, key);
  if (value === undefined) {
    throw new ExecutionConfigError(
      `${label} is missing required field '${key}'`,
    );
  }
  return value;
}

function node(
  map: YAMLMap<unknown, unknown>,
  key: string,
): ParsedNode | undefined {
  const pair = map.items.find(item => scalarKey(item) === key);
  return pair?.value === null
    ? undefined
    : (pair?.value as ParsedNode | undefined);
}

function optionalScalar(
  map: YAMLMap<unknown, unknown>,
  key: string,
): Scalar<unknown> | undefined {
  const value = node(map, key);
  if (value === undefined) return undefined;
  if (!isScalar(value)) {
    throw new ExecutionConfigError(`${key} must be a scalar`);
  }
  return value;
}

function literalString(
  map: YAMLMap<unknown, unknown>,
  key: string,
  label: string,
): string {
  const value = requiredNode(map, key, label);
  if (!isScalar(value) || typeof value.value !== 'string') {
    throw new ExecutionConfigError(`${label}.${key} must be a string`);
  }
  return value.value;
}

function nonemptyString(
  map: YAMLMap<unknown, unknown>,
  key: string,
  label: string,
): string {
  const value = literalString(map, key, label);
  if (value.length === 0) {
    throw new ExecutionConfigError(`${label}.${key} must not be empty`);
  }
  return value;
}

function finiteNumber(
  map: YAMLMap<unknown, unknown>,
  key: string,
  label: string,
): number {
  const value = requiredNode(map, key, label);
  if (
    !isScalar(value) ||
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value)
  ) {
    throw new ExecutionConfigError(`${label}.${key} must be a finite number`);
  }
  return value.value;
}

function optionalInteger(
  map: YAMLMap<unknown, unknown>,
  key: string,
  positive: boolean,
): Readonly<Record<string, number>> {
  const value = node(map, key);
  if (value === undefined) return {};
  if (
    !isScalar(value) ||
    typeof value.value !== 'number' ||
    !Number.isSafeInteger(value.value) ||
    value.value < (positive ? 1 : 0) ||
    value.value > MAX_U32
  ) {
    throw new ExecutionConfigError(
      `runtime.${key} must be a ${positive ? 'positive' : 'nonnegative'} u32 integer`,
    );
  }
  return {[key]: value.value};
}

function optionalTimeNow(
  map: YAMLMap<unknown, unknown>,
): Readonly<{timeNow?: number}> {
  const value = node(map, 'timeNow');
  if (value === undefined) return {};
  if (
    !isScalar(value) ||
    typeof value.value !== 'number' ||
    !Number.isSafeInteger(value.value)
  ) {
    throw new ExecutionConfigError(
      'execution.timeNow must be a finite safe epoch-ms integer',
    );
  }
  return {timeNow: value.value};
}

function optionalMaxExecutions(
  map: YAMLMap<unknown, unknown>,
): Readonly<{maxExecutions?: number}> {
  const value = node(map, 'maxExecutions');
  if (value === undefined) return {};
  if (
    !isScalar(value) ||
    typeof value.value !== 'number' ||
    !Number.isSafeInteger(value.value) ||
    value.value < 1
  ) {
    throw new ExecutionConfigError(
      'execution.maxExecutions must be a positive safe integer',
    );
  }
  if (value.value > MAX_EXECUTIONS) {
    throw new ExecutionConfigError(
      `execution.maxExecutions must not exceed ${MAX_EXECUTIONS}`,
    );
  }
  return {maxExecutions: value.value};
}

function fields(
  map: YAMLMap<unknown, unknown>,
  label: string,
  accepted: readonly string[],
): void {
  const allowed = new Set(accepted);
  for (const pair of map.items) {
    const key = scalarKey(pair);
    if (!allowed.has(key)) {
      throw new ExecutionConfigError(`${label} has unknown field '${key}'`);
    }
  }
}

function has(map: YAMLMap<unknown, unknown>, key: string): boolean {
  return map.items.some(pair => scalarKey(pair) === key);
}

function scalarKey(pair: Pair<unknown, unknown>): string {
  if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
    throw new ExecutionConfigError(
      'execution config mapping keys must be strings',
    );
  }
  return pair.key.value;
}

function object<T extends object>(value: T): T {
  return Object.freeze(Object.assign(Object.create(null), value)) as T;
}

function yamlError(error: unknown): ExecutionConfigError {
  return new ExecutionConfigError(
    `invalid execution config: ${error instanceof Error ? error.message : String(error)}`,
  );
}
