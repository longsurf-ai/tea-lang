// Purpose: Prove execution configuration parsing is closed, bounded, and path-stable.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  ExecutionConfigError,
  MAX_EXECUTION_CONFIG_BYTES,
  loadConfig,
} from './config';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tea-execution-config-'));
  mkdirSync(join(directory, 'programs'));
  mkdirSync(join(directory, 'data'));
  writeFileSync(join(directory, 'programs/strategy.tea'), 'indicator("x")\n');
  writeFileSync(join(directory, 'data/bars.csv'), 'time,close\n0,1\n');
});

afterEach(() => {
  rmSync(directory, {recursive: true, force: true});
});

describe('execution config loader', () => {
  test('loads one config and resolves paths from its directory', () => {
    const hash = 'AB'.repeat(32);
    const source = `schema: tea.execution/v1
program:
  source: ./programs/strategy.tea
runtime:
  kind: webgpu
  maxRowsPerChunk: 65536
  effectRecordsPerExecution: 0
  maxGpuBytes: 1073741824
  maxCacheBytesPerWorkgroup: 0
execution:
  kind: sweep
  provider:
    kind: csv
    path: ./data/bars.csv
    sha256: ${hash}
  parameters:
    enabled: true
    label: trial
    cash: 100000
    length:
      range: {start: 2, stop: 20, step: 2}
  maxExecutions: 10000
  timeNow: 1786579200000
`;
    const path = writeConfig(source);
    const config = loadConfig(path);

    expect(config).toEqual({
      schema: 'tea.execution/v1',
      program: {source: join(directory, 'programs/strategy.tea')},
      runtime: {
        kind: 'webgpu',
        maxRowsPerChunk: 65536,
        effectRecordsPerExecution: 0,
        maxGpuBytes: 1073741824,
        maxCacheBytesPerWorkgroup: 0,
      },
      execution: {
        kind: 'sweep',
        provider: {
          kind: 'csv',
          path: join(directory, 'data/bars.csv'),
          sha256: hash.toLowerCase(),
        },
        parameters: {
          enabled: true,
          label: 'trial',
          cash: 100000,
          length: {range: {start: 2, stop: 20, step: 2}},
        },
        maxExecutions: 10000,
        timeNow: 1786579200000,
      },
    });
    expect(Object.getPrototypeOf(config)).toBeNull();
    expect(Object.getPrototypeOf(config.execution.parameters)).toBeNull();
    expect(Object.getPrototypeOf(config.execution.provider)).toBeNull();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.execution.parameters)).toBe(true);
  });

  test('accepts JSON and defaults an omitted parameter map to empty', () => {
    const path = writeConfig(
      JSON.stringify({
        schema: 'tea.execution/v1',
        program: {source: './programs/strategy.tea'},
        runtime: {kind: 'javascript'},
        execution: {
          kind: 'run',
          provider: {kind: 'csv', path: './data/bars.csv'},
        },
      }),
    );

    const config = loadConfig(path);
    expect(config.runtime).toEqual({kind: 'javascript'});
    expect(config.execution.parameters).toEqual({});
    expect(Object.getPrototypeOf(config.execution.parameters)).toBeNull();
    expect(Object.isFrozen(config.execution.parameters)).toBe(true);
  });

  test('keeps prototype-looking parameter names as ordinary own fields', () => {
    const path = writeConfig(
      validRun().replace(
        'parameters: {}',
        'parameters: {__proto__: 1, constructor: 2}',
      ),
    );

    const parameters = loadConfig(path).execution.parameters;
    expect(Object.keys(parameters)).toEqual(['__proto__', 'constructor']);
    expect(parameters['__proto__']).toBe(1);
    expect(parameters['constructor']).toBe(2);
    expect(Object.getPrototypeOf(parameters)).toBeNull();
  });

  test('uses the configuration directory rather than the process cwd', () => {
    const nested = join(directory, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'strategy.tea'), 'indicator("nested")\n');
    writeFileSync(join(nested, 'bars.csv'), 'time,close\n0,2\n');
    const path = writeConfig(validRun('./strategy.tea', './bars.csv'), nested);

    const config = loadConfig(path);
    expect(config.program.source).toBe(join(nested, 'strategy.tea'));
    expect(config.execution.provider.path).toBe(join(nested, 'bars.csv'));
  });

  test('requires config, program, and provider paths to be regular files', () => {
    expect(() => loadConfig(directory)).toThrow('not a regular file');
    expect(() =>
      loadConfig(writeConfig(validRun('./programs', './data/bars.csv'))),
    ).toThrow('program.source');
    expect(() =>
      loadConfig(writeConfig(validRun('./programs/strategy.tea', './data'))),
    ).toThrow('execution.provider.path');
    expect(() => loadConfig(join(directory, 'does-not-exist.yaml'))).toThrow(
      'is not readable',
    );
  });

  test('rejects oversized and invalid UTF-8 config bytes', () => {
    const oversized = join(directory, 'oversized.yaml');
    writeFileSync(
      oversized,
      Buffer.alloc(MAX_EXECUTION_CONFIG_BYTES + 1, 0x20),
    );
    expect(() => loadConfig(oversized)).toThrow('byte limit');

    const invalid = join(directory, 'invalid.yaml');
    writeFileSync(invalid, Buffer.from([0xff]));
    expect(() => loadConfig(invalid)).toThrow('valid UTF-8');
  });
});

describe('closed schema', () => {
  test.each([
    ['root', `${validRun()}\nextra: true`, "unknown field 'extra'"],
    [
      'program',
      validRun().replace(
        'source: ./programs',
        'extra: true\n  source: ./programs',
      ),
      "program has unknown field 'extra'",
    ],
    [
      'runtime',
      validRun().replace(
        'kind: javascript',
        'kind: javascript\n  maxGpuBytes: 1',
      ),
      "runtime has unknown field 'maxGpuBytes'",
    ],
    [
      'execution',
      validRun().replace('kind: run', 'kind: run\n  output: report'),
      "execution has unknown field 'output'",
    ],
    [
      'provider',
      validRun().replace('kind: csv', 'kind: csv\n    symbol: BTC'),
      "execution.provider has unknown field 'symbol'",
    ],
    [
      'range',
      validRun().replace(
        'parameters: {}',
        'parameters: {x: {range: {start: 1, stop: 2, step: 1, extra: 3}}}',
      ),
      "parameter 'x'.range has unknown field 'extra'",
    ],
  ])('rejects an unknown %s field', (_label, source, message) => {
    expect(() => loadConfig(writeConfig(source))).toThrow(message);
  });

  test.each([
    [
      'schema',
      validRun().replace('tea.execution/v1', 'tea.execution/v2'),
      'unsupported',
    ],
    ['runtime', validRun().replace('javascript', 'cuda'), 'runtime.kind'],
    [
      'execution',
      validRun().replace('kind: run', 'kind: scan'),
      'execution.kind',
    ],
    [
      'provider',
      validRun().replace('kind: csv', 'kind: yahoo'),
      'provider.kind',
    ],
  ])('rejects an unsupported %s discriminator', (_label, source, message) => {
    expect(() => loadConfig(writeConfig(source))).toThrow(message);
  });

  test('requires every top-level section and its required fields', () => {
    for (const field of ['schema', 'program', 'runtime', 'execution']) {
      const source = validRun()
        .split('\n')
        .filter(line => !line.startsWith(`${field}:`))
        .join('\n');
      expect(() => loadConfig(writeConfig(source))).toThrow();
    }
    expect(() =>
      loadConfig(
        writeConfig(
          validRun().replace('  source: ./programs/strategy.tea\n', ''),
        ),
      ),
    ).toThrow('program must be a mapping');
  });

  test('run rejects maxExecutions while sweep accepts a bounded positive integer', () => {
    expect(() =>
      loadConfig(
        writeConfig(
          validRun().replace(
            '  parameters: {}',
            '  parameters: {}\n  maxExecutions: 2',
          ),
        ),
      ),
    ).toThrow('run execution does not accept maxExecutions');

    for (const value of ['0', '-1', '1.5', '9007199254740992']) {
      expect(() =>
        loadConfig(writeConfig(validSweep(`  maxExecutions: ${value}\n`))),
      ).toThrow('positive safe integer');
    }
    expect(() =>
      loadConfig(writeConfig(validSweep('  maxExecutions: 10001\n'))),
    ).toThrow('execution.maxExecutions must not exceed 10000');
  });

  test.each([
    ['maxRowsPerChunk', '0', 'positive'],
    ['maxRowsPerChunk', '1.5', 'positive'],
    ['effectRecordsPerExecution', '-1', 'nonnegative'],
    ['maxGpuBytes', '4294967296', 'positive'],
    ['maxCacheBytesPerWorkgroup', '-1', 'nonnegative'],
  ])('validates WebGPU option %s', (field, value, message) => {
    expect(() =>
      loadConfig(writeConfig(validWebGpu(`  ${field}: ${value}\n`))),
    ).toThrow(message);
  });

  test('validates timeNow, provider hash, parameter scalars, and range shape', () => {
    for (const value of ['null', '.nan', '.inf', '1.5', '9007199254740992']) {
      expect(() =>
        loadConfig(
          writeConfig(
            validRun().replace(
              '  parameters: {}',
              `  parameters: {}\n  timeNow: ${value}`,
            ),
          ),
        ),
      ).toThrow('finite safe epoch-ms integer');
    }
    expect(() =>
      loadConfig(
        writeConfig(
          validRun().replace(
            '    path: ./data/bars.csv',
            '    path: ./data/bars.csv\n    sha256: abc',
          ),
        ),
      ),
    ).toThrow('64 hexadecimal');
    for (const parameters of [
      'x: null',
      'x: [1, 2]',
      'x: .nan',
      'x: {start: 1, stop: 2, step: 1}',
      'x: {range: {start: 1, stop: 2}}',
      'x: {range: {start: one, stop: 2, step: 1}}',
    ]) {
      expect(() =>
        loadConfig(
          writeConfig(
            validRun().replace(
              '  parameters: {}',
              `  parameters: {${parameters}}`,
            ),
          ),
        ),
      ).toThrow();
    }
  });
});

describe('YAML trust boundary', () => {
  test.each([
    ['multiple documents', `${validRun()}\n---\n${validRun()}`, 'exactly one'],
    [
      'duplicate keys',
      validRun().replace(
        '  kind: javascript',
        '  kind: javascript\n  kind: javascript',
      ),
      'Map keys must be unique',
    ],
    [
      'anchor',
      validRun().replace('kind: javascript', 'kind: &runtime javascript'),
      'anchors',
    ],
    [
      'alias',
      validRun()
        .replace('kind: javascript', 'kind: &runtime javascript')
        .replace('kind: run', 'kind: *runtime'),
      'anchors',
    ],
    [
      'merge key',
      validRun().replace('  source:', '  <<: {}\n  source:'),
      'merge keys',
    ],
    [
      'explicit tag',
      validRun().replace('kind: javascript', 'kind: !!str javascript'),
      'explicit YAML tags',
    ],
    [
      'custom tag',
      validRun().replace('kind: javascript', 'kind: !runtime javascript'),
      'Unresolved tag',
    ],
    [
      'YAML directive',
      `%YAML 1.2\n---\n${validRun()}`,
      'explicit YAML directives',
    ],
    [
      'tag directive',
      `%TAG !e! tag:example.com,2026:\n---\n${validRun()}`,
      'explicit YAML directives',
    ],
    [
      'complex key',
      `? [schema, other]\n: tea.execution/v1\n${validRun().split('\n').slice(1).join('\n')}`,
      'keys must be strings',
    ],
  ])('rejects %s', (_label, source, message) => {
    expect(() => loadConfig(writeConfig(source))).toThrow(message);
  });

  test('enforces depth, node, and per-collection entry limits', () => {
    let nested = 'value';
    for (let index = 0; index < 70; index++) nested = `{level: ${nested}}`;
    expect(() =>
      loadConfig(
        writeConfig(
          validRun().replace('parameters: {}', `parameters: {x: ${nested}}`),
        ),
      ),
    ).toThrow('depth limit');

    const entries = Array.from(
      {length: 10_001},
      (_, index) => `x${index}: 1`,
    ).join(',');
    expect(() =>
      loadConfig(
        writeConfig(
          validRun().replace('parameters: {}', `parameters: {${entries}}`),
        ),
      ),
    ).toThrow('entry limit');

    const sequence = Array.from(
      {length: 5_001},
      (_, index) => `x${index}: 1`,
    ).join(',');
    expect(() =>
      loadConfig(
        writeConfig(
          validRun().replace(
            'parameters: {}',
            `parameters: {x: {range: {${sequence}}}}`,
          ),
        ),
      ),
    ).toThrow('node limit');
  });
});

test('configuration errors have one stable public type', () => {
  try {
    loadConfig(writeConfig('schema: tea.execution/v1'));
    throw new Error('expected config error');
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionConfigError);
    expect((error as Error).name).toBe('ExecutionConfigError');
  }
});

function writeConfig(
  source: string | Uint8Array,
  destination = directory,
): string {
  const path = join(destination, 'execution.yaml');
  writeFileSync(path, source);
  return path;
}

function validRun(
  source = './programs/strategy.tea',
  provider = './data/bars.csv',
): string {
  return `schema: tea.execution/v1
program:
  source: ${source}
runtime:
  kind: javascript
execution:
  kind: run
  provider:
    kind: csv
    path: ${provider}
  parameters: {}`;
}

function validSweep(extra = ''): string {
  return `schema: tea.execution/v1
program:
  source: ./programs/strategy.tea
runtime:
  kind: javascript
execution:
  kind: sweep
  provider:
    kind: csv
    path: ./data/bars.csv
  parameters: {}
${extra}`;
}

function validWebGpu(extra = ''): string {
  return `schema: tea.execution/v1
program:
  source: ./programs/strategy.tea
runtime:
  kind: webgpu
${extra}execution:
  kind: run
  provider:
    kind: csv
    path: ./data/bars.csv
  parameters: {}`;
}
