import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const MAIN = join(ROOT, 'src/main.ts');
const SOURCE = join(ROOT, 'tests/fixtures/cli/parameter-report.tea');
const DATA = join(ROOT, 'tests/fixtures/cli/data.csv');
const RUN_CONFIG = join(ROOT, 'tests/fixtures/cli/configs/run.yaml');
const SWEEP_CONFIG = join(ROOT, 'tests/fixtures/cli/configs/sweep.json');

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function invokeCli(...args: readonly string[]): CliResult {
  const result = spawnSync(
    process.env['TEA_TEST_NODE'] ?? 'node',
    ['--import', import.meta.resolve('tsx'), MAIN, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function cli(...args: readonly string[]): string {
  const result = invokeCli(...args);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('CLI execution host', () => {
  test('run discovers a source parameter and renders logical effects', () => {
    const output = cli('run', SOURCE, '-i', DATA, '-scale', '3');
    expect(output).toContain('# System');
    expect(output).toMatch(/^backend\s+cpu$/m);
    expect(output).toMatch(/^numeric profile\s+js-f64$/m);
    expect(output).toContain('# Parameters');
    expect(output).toContain('scale');
    expect(output).toContain('scaled close');
    expect(output).toContain('@entry.Sample');
    expect(output).toContain('{"value":6}');
  });

  test('run preserves negative values and long dynamic parameter names', () => {
    const output = cli(
      'run',
      SOURCE,
      '-i',
      DATA,
      '-scale',
      '-0.5',
      '--initial_cash',
      '2',
    );
    expect(output).toContain('scale');
    expect(output).toContain('-0.5');
    expect(output).toContain('initial_cash');
    expect(output).toContain('{"value":1.5}');
  });

  test('sweep --cpu expands ranges and retains bounded summaries', () => {
    const output = cli(
      'sweep',
      SOURCE,
      '-i',
      DATA,
      '--cpu',
      '--scale',
      '1:2:0.5',
    );
    expect(output).toMatch(/^bindings\s+3$/m);
    expect(output).toContain('# Sweep Results');
    expect(output).not.toContain('# Sweep Effect Counts');
    expect(output).toMatch(/0\s+2\s+1\s+2/);
    expect(output).toMatch(/2\s+2\s+2\s+0\s+4/);
  });

  test('execute runs a YAML CPU config with config-relative source and CSV paths', () => {
    const output = cli('execute', RUN_CONFIG);
    expect(output).toContain('# System');
    expect(output).toMatch(/^backend\s+cpu$/m);
    expect(output).toMatch(/^numeric profile\s+js-f64$/m);
    expect(output).toMatch(/^bindings\s+1$/m);
    expect(output).toContain('# Parameters');
    expect(output).toMatch(/^0\s+scale\s+3\s+true$/m);
    expect(output).toMatch(/^0\s+initial_cash\s+1\s+true$/m);
    expect(output).toContain('# Dense Outputs');
    expect(output).toMatch(/^0\s+4$/m);
    expect(output).toMatch(/^1\s+7$/m);
    expect(output).toContain('{"value":4}');
    expect(output).toContain('{"value":7}');
  });

  test('execute runs a JSON CPU sweep and reports its axis', () => {
    const output = cli('execute', SWEEP_CONFIG);
    expect(output).toMatch(/^backend\s+cpu$/m);
    expect(output).toMatch(/^numeric profile\s+js-f64$/m);
    expect(output).toMatch(/^bindings\s+3$/m);
    expect(output).toContain('# Sweep Results');
    expect(output).toMatch(
      /^binding\s+rows\s+scale\s+initial_cash\s+scaled close$/m,
    );
    expect(output).toMatch(/^0\s+2\s+1\s+1\s+3$/m);
    expect(output).toMatch(/^1\s+2\s+1\.5\s+1\s+4$/m);
    expect(output).toMatch(/^2\s+2\s+2\s+1\s+5$/m);
  });

  test('execute --json exposes stable sweep and trajectory contracts', () => {
    const sweep = JSON.parse(cli('execute', SWEEP_CONFIG, '--json'));
    expect(sweep.schema).toBe('tea.execution-result/v2');
    expect(sweep.snapshot).toEqual({
      programSource: SOURCE,
      providerHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      timeNow: 1_700_000_000_000,
    });
    expect(sweep.system).toMatchObject({
      kind: 'sweep',
      backend: 'cpu',
      numericProfile: 'js-f64',
      executions: 3,
      rows: 6,
    });
    expect(sweep.sweep.scenarios).toHaveLength(3);
    expect(sweep.trajectories).toHaveLength(3);
    expect(sweep.trajectories[1]).toMatchObject({
      bindingIndex: 1,
      rows: 2,
      time: [100, 200],
      parameters: [
        {id: 'parameter:scale', value: 1.5},
        {id: 'parameter:initial_cash', value: 1},
      ],
      outputs: [{id: 'output:1:0', values: [2.5, 4]}],
      effectSchemas: [
        {id: 'effect:0', effectId: 0, payload: {typeId: '@entry.Sample'}},
      ],
      effects: [
        {row: 0, effectId: 'effect:0', payload: {value: 2.5}},
        {row: 1, effectId: 'effect:0', payload: {value: 4}},
      ],
    });

    const run = JSON.parse(cli('execute', RUN_CONFIG, '--json'));
    expect(run.system.kind).toBe('run');
    expect(run.trajectory.time).toEqual([100, 200]);
    expect(run.sweep).toBeUndefined();
  });

  test('config execution matches the direct run and sweep entry points', () => {
    const configuredRun = cli('execute', RUN_CONFIG);
    const directRun = cli(
      'run',
      SOURCE,
      '-i',
      DATA,
      '--scale',
      '3',
      '--initial_cash',
      '1',
    );
    expect(reportSection(configuredRun, '# Parameters')).toBe(
      reportSection(directRun, '# Parameters'),
    );

    const configuredSweep = cli('execute', SWEEP_CONFIG);
    const directSweep = cli(
      'sweep',
      SOURCE,
      '-i',
      DATA,
      '--cpu',
      '--scale',
      '1:2:0.5',
      '--initial_cash',
      '1',
      '--max-scenarios',
      '3',
    );
    expect(reportSection(configuredSweep, '# Sweep Results')).toBe(
      reportSection(directSweep, '# Sweep Results'),
    );
  });

  test('execute exposes no runtime or presentation overrides', () => {
    for (const flag of ['--trace', '--view', '--scenario']) {
      const result = invokeCli('execute', SWEEP_CONFIG, flag);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`unknown option '${flag}'`);
    }
    const unknown = invokeCli('execute', '--runtime', 'javascript', RUN_CONFIG);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown option '--runtime'");
  });
});

function reportSection(output: string, heading: string): string {
  const start = output.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  return output.slice(start);
}
