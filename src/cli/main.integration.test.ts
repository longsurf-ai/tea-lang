import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const MAIN = join(ROOT, 'src/main.ts');
const SOURCE = join(ROOT, 'tests/fixtures/cli/parameter-report.tea');
const DATA = join(ROOT, 'tests/fixtures/cli/data.csv');

type Result = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function invokeCli(...args: readonly string[]): Result {
  const result = spawnSync(
    process.env['TEA_TEST_NODE'] ?? 'node',
    ['--import', import.meta.resolve('tsx'), MAIN, ...args],
    {cwd: ROOT, encoding: 'utf8'},
  );
  return {status: result.status, stdout: result.stdout, stderr: result.stderr};
}

function cli(...args: readonly string[]): string {
  const result = invokeCli(...args);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('CLI Batch Recipe', () => {
  test('help exposes only the concrete command surface', () => {
    const result = invokeCli('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run');
    expect(result.stdout).toContain('build');
    expect(result.stdout).toContain('parse');
    expect(result.stdout).toContain('docs');
    expect(result.stdout).not.toMatch(/^\s+execute\b/m);
    expect(result.stdout).not.toMatch(/^\s+sweep\b/m);
    expect(result.stderr).toBe('');
  });

  test('run binds a CSV DataStream and source parameters', () => {
    const output = cli('run', SOURCE, '-i', DATA, '-scale', '3');
    expect(output).toContain('# System');
    expect(output).toMatch(/^indices\s+2$/m);
    expect(output).toMatch(/^compilation\s+\d+\.\d{2} ms$/m);
    expect(output).toMatch(/^execution\s+\d+\.\d{2} ms$/m);
    expect(output).toContain('# Parameters');
    expect(output).toContain('scale');
    expect(output).toContain('# Outputs');
    expect(output).toContain('scaled close');
    expect(output).toContain('@entry.Sample');
    expect(output).toContain('{"value":6}');
  });

  test('run preserves negative values and long parameter names', () => {
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

  test('expected failures are concise and do not expose stacks', () => {
    const result = invokeCli('run', SOURCE, '-i', DATA, '--missing', '1');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("tea: unknown parameter option '--missing'\n");
    expect(result.stderr).not.toContain('\n    at ');
  });
  test('reports semantic parameter failures from module.bind without a stack', () => {
    const result = invokeCli('run', SOURCE, '-i', DATA, '--scale', '5');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("tea: parameter 'scale' above maxval 4\n");
    expect(result.stderr).not.toContain('\n    at ');
  });
});
