import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const MAIN = join(ROOT, 'src/main.ts');
const SOURCE = join(ROOT, 'testdata/cli/parameter-report.tea');
const DATA = join(ROOT, 'testdata/cli/data.csv');
const RUN_CONFIG = join(ROOT, 'testdata/cli/configs/run.yaml');
const SWEEP_CONFIG = join(ROOT, 'testdata/cli/configs/sweep.json');

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function invokeCli(...args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [MAIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
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

  test('execute --trace prints a run trace instead of the report', () => {
    const output = cli('execute', RUN_CONFIG, '--trace');
    expect(output).toContain('# output[1] plot title=scaled close');
    expect(output).toContain('# effect[0] type=@entry.Sample');
    expect(output).toMatch(/^0 1 4$/m);
    expect(output).toMatch(/^1 1 7$/m);
    expect(output).toContain('0 effect[0] {"kind":"user-type","fields":[4]}');
    expect(output).not.toContain('# System');
  });

  test('config execution matches the legacy run and sweep adapters', () => {
    const configuredTrace = cli('execute', RUN_CONFIG, '--trace');
    const legacyTrace = cli(
      'run',
      SOURCE,
      '-i',
      DATA,
      '--trace',
      '--scale',
      '3',
      '--initial_cash',
      '1',
    );
    expect(configuredTrace).toBe(legacyTrace);

    const configuredSweep = cli('execute', SWEEP_CONFIG);
    const legacySweep = cli(
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
      reportSection(legacySweep, '# Sweep Results'),
    );
  });

  test('execute rejects presentation flags that do not match config mode', () => {
    const traceSweep = invokeCli('execute', SWEEP_CONFIG, '--trace');
    expect(traceSweep.status).toBe(1);
    expect(traceSweep.stderr).toContain(
      'tea: --trace requires a run execution config',
    );

    const viewRun = invokeCli('execute', RUN_CONFIG, '--view');
    expect(viewRun.status).toBe(1);
    expect(viewRun.stderr).toContain(
      'tea: --view requires a sweep execution config',
    );

    const mutuallyExclusive = invokeCli(
      'execute',
      RUN_CONFIG,
      '--view',
      '--trace',
    );
    expect(mutuallyExclusive.status).toBe(1);
    expect(mutuallyExclusive.stderr).toContain(
      'tea: --view and --trace cannot be used together',
    );

    const unknown = invokeCli('execute', '--runtime', 'javascript', RUN_CONFIG);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("tea: unknown execute option '--runtime'");
  });
});

function reportSection(output: string, heading: string): string {
  const start = output.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  return output.slice(start);
}
