import {describe, expect, test} from 'bun:test';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
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

  test('execute --json exposes stable sweep and trajectory contracts', () => {
    const sweep = JSON.parse(cli('execute', SWEEP_CONFIG, '--json'));
    expect(sweep.schema).toBe('tea.execution-result/v1');
    expect(sweep.config).toEqual({
      bytesHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      programSource: SOURCE,
      programBytesHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      providerBytesHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      effectiveTimeNow: 1_700_000_000_000,
    });
    expect(sweep.system).toMatchObject({
      kind: 'sweep',
      backend: 'cpu',
      numericProfile: 'js-f64',
      executions: 3,
      rows: 6,
    });
    expect(sweep.sweep.scenarios).toHaveLength(3);

    const trajectory = JSON.parse(
      cli(
        'execute',
        '--json',
        '--scenario',
        '1',
        '--expected-config-sha256',
        sweep.config.bytesHash,
        '--expected-program-sha256',
        sweep.config.programBytesHash,
        '--expected-provider-sha256',
        sweep.config.providerBytesHash,
        '--replay-time-now',
        String(sweep.config.effectiveTimeNow),
        SWEEP_CONFIG,
      ),
    );
    expect(trajectory.system).toMatchObject({
      kind: 'run',
      executions: 1,
      rows: 2,
    });
    expect(trajectory.config).toEqual(sweep.config);
    expect(trajectory.trajectory).toMatchObject({
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

  test('dashboard session keeps one framed process across scenario requests and errors', async () => {
    const child = spawn(
      process.execPath,
      [MAIN, 'execute', SWEEP_CONFIG, '--json', '--dashboard-session'],
      {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']},
    );
    if (
      child.stdin === null ||
      child.stdout === null ||
      child.stderr === null
    ) {
      throw new Error('dashboard session did not expose process pipes');
    }
    const lines = createInterface({input: child.stdout})[
      Symbol.asyncIterator
    ]();
    const stderr: Buffer[] = [];
    child.stderr.on('data', chunk => stderr.push(chunk as Buffer));
    try {
      const sweep = JSON.parse(await nextLine(lines, stderr));
      expect(sweep.system.kind).toBe('sweep');

      child.stdin.write('not json\n');
      expect(JSON.parse(await nextLine(lines, stderr))).toEqual({
        schema: 'tea.dashboard-error/v1',
        error: 'dashboard scenario request must be one JSON object per line',
      });

      child.stdin.write(
        `${JSON.stringify({
          schema: 'tea.dashboard-scenario/v1',
          bindingIndex: 1,
          configBytesHash: sweep.config.bytesHash,
          programBytesHash: sweep.config.programBytesHash,
          providerBytesHash: sweep.config.providerBytesHash,
          effectiveTimeNow: sweep.config.effectiveTimeNow,
        })}\n`,
      );
      const trajectory = JSON.parse(await nextLine(lines, stderr));
      expect(trajectory.schema).toBe('tea.dashboard-trajectory/v1');
      expect(trajectory.config).toEqual(sweep.config);
      expect(trajectory.system).toBeUndefined();
      expect(trajectory.trajectory).toMatchObject({
        bindingIndex: 1,
        time: [100, 200],
      });
    } finally {
      child.stdin.end();
      await new Promise<void>(resolve => child.once('close', () => resolve()));
    }
  });

  test('scenario replay rejects stale config, program closure, provider, and clock snapshots', () => {
    const sweep = JSON.parse(cli('execute', SWEEP_CONFIG, '--json'));
    const common = [
      'execute',
      SWEEP_CONFIG,
      '--json',
      '--scenario',
      '1',
      '--expected-config-sha256',
      sweep.config.bytesHash,
      '--expected-program-sha256',
      sweep.config.programBytesHash,
      '--expected-provider-sha256',
      sweep.config.providerBytesHash,
      '--replay-time-now',
      String(sweep.config.effectiveTimeNow),
    ];

    const staleConfig = invokeCli(
      ...common.map(value =>
        value === sweep.config.bytesHash ? '0'.repeat(64) : value,
      ),
    );
    expect(staleConfig.status).toBe(1);
    expect(staleConfig.stdout).toBe('');
    expect(staleConfig.stderr).toContain(
      'execution config does not match the selected sweep snapshot',
    );

    const programIndex = common.indexOf(sweep.config.programBytesHash);
    const staleProgramArgs = [...common];
    staleProgramArgs[programIndex] = '0'.repeat(64);
    const staleProgram = invokeCli(...staleProgramArgs);
    expect(staleProgram.status).toBe(1);
    expect(staleProgram.stdout).toBe('');
    expect(staleProgram.stderr).toContain(
      'program source closure changed after sweep',
    );

    const providerIndex = common.indexOf(sweep.config.providerBytesHash);
    const staleProviderArgs = [...common];
    staleProviderArgs[providerIndex] = '0'.repeat(64);
    const staleProvider = invokeCli(...staleProviderArgs);
    expect(staleProvider.status).toBe(1);
    expect(staleProvider.stdout).toBe('');
    expect(staleProvider.stderr).toContain('changed after sweep');

    const clockIndex = common.indexOf(String(sweep.config.effectiveTimeNow));
    const staleClockArgs = [...common];
    staleClockArgs[clockIndex] = '1700000000001';
    const staleClock = invokeCli(...staleClockArgs);
    expect(staleClock.status).toBe(1);
    expect(staleClock.stdout).toBe('');
    expect(staleClock.stderr).toContain(
      '--replay-time-now does not match execution.timeNow',
    );
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

async function nextLine(
  lines: AsyncIterator<string>,
  stderr: readonly Buffer[],
): Promise<string> {
  const next = await lines.next();
  if (next.done) {
    throw new Error(
      `dashboard session closed before its response: ${Buffer.concat(stderr).toString('utf8')}`,
    );
  }
  return next.value;
}

function reportSection(output: string, heading: string): string {
  const start = output.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  return output.slice(start);
}
