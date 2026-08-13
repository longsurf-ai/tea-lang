import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const MAIN = join(ROOT, 'src/main.ts');
const SOURCE = join(ROOT, 'testdata/cli/parameter-report.tea');
const DATA = join(ROOT, 'testdata/cli/data.csv');

function cli(...args: readonly string[]): string {
  const result = spawnSync(process.execPath, [MAIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('CLI execution host', () => {
  test('run discovers a source parameter and renders logical effects', () => {
    const output = cli('run', SOURCE, '-i', DATA, '-scale', '3');
    expect(output).toContain('# System');
    expect(output).toContain('backend     cpu');
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
    expect(output).toContain('bindings    3');
    expect(output).toContain('# Sweep Results');
    expect(output).not.toContain('# Sweep Effect Counts');
    expect(output).toMatch(/0\s+2\s+1\s+2/);
    expect(output).toMatch(/2\s+2\s+2\s+0\s+4/);
  });
});
