// Purpose: Exercise one-shot process failure, result bounds, and cancellation at the editor CLI boundary.

import {describe, expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {
  executeTeaCli,
  teaCliArguments,
  type TeaCliChild,
  type TeaCliDependencies,
  type TeaCliRequest,
} from '../src/dashboard/cli';

const REQUEST: TeaCliRequest = {
  executable: 'tea',
  configPath: '/work/sweep.yaml',
  cwd: '/work',
};

describe('Tea editor CLI runner', () => {
  test('invokes the generic one-shot JSON contract', () => {
    expect(teaCliArguments(REQUEST)).toEqual([
      'execute',
      '/work/sweep.yaml',
      '--json',
    ]);
  });

  test('collects one complete sweep result', async () => {
    const child = new FakeChild();
    const execution = execute(child);
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify(machineSweep()));
      child.close(0, null);
    });
    const result = await execution.result;
    expect(result.system.kind).toBe('sweep');
    expect(result.trajectories).toEqual([]);
  });

  test('assembles a large JSON result from fragmented chunks', async () => {
    const child = new FakeChild();
    const execution = execute(child);
    const frame = Buffer.from(JSON.stringify(machineSweep(50_000)));
    expect(frame.byteLength).toBeGreaterThan(500_000);
    queueMicrotask(() => {
      for (let offset = 0; offset < frame.byteLength; offset += 257) {
        child.stdout.write(frame.subarray(offset, offset + 257));
      }
      child.close(0, null);
    });
    expect((await execution.result).trajectories?.[0]).toMatchObject({
      bindingIndex: 0,
      rows: 50_000,
    });
  });

  test('reports a spawn error', async () => {
    const child = new FakeChild();
    const execution = execute(child);
    queueMicrotask(() => child.emit('error', new Error('spawn tea ENOENT')));
    await expect(execution.result).rejects.toThrow(
      'could not start Tea CLI: spawn tea ENOENT',
    );
  });

  test('reports bounded stderr for a nonzero exit', async () => {
    const child = new FakeChild();
    const execution = execute(child);
    queueMicrotask(() => {
      child.stderr.write('tea: invalid execution config\n');
      child.close(1, null);
    });
    await expect(execution.result).rejects.toThrow(
      'tea: invalid execution config',
    );
  });

  test.each(['not json', '{}{}'])(
    'rejects malformed or surplus JSON: %s',
    async output => {
      const child = new FakeChild();
      const execution = execute(child);
      queueMicrotask(() => {
        child.stdout.write(output);
        child.close(0, null);
      });
      await expect(execution.result).rejects.toThrow(
        'Tea CLI returned malformed JSON',
      );
    },
  );

  test.each([
    ['stdout', 'JSON', 'maxStdoutBytes'] as const,
    ['stderr', 'diagnostics', 'maxStderrBytes'] as const,
  ])(
    'terminates the child when %s exceeds its bound',
    async (stream, label, limit) => {
      const child = new FakeChild({closeOnSignal: true});
      const execution = execute(child, {[limit]: 8});
      queueMicrotask(() => child[stream].write('123456789'));
      await expect(execution.result).rejects.toThrow(
        `Tea CLI ${label} exceeded the 8 B result limit`,
      );
      expect(child.signals).toEqual(['SIGTERM']);
    },
  );

  test('cancels normally and clears the pending escalation', async () => {
    const child = new FakeChild({closeOnSignal: true});
    const clock = fakeClock();
    const execution = execute(child, clock.dependencies);
    execution.cancel();
    await expect(execution.result).rejects.toThrow('Tea execution cancelled');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(clock.delays).toEqual([6_500]);
    expect(clock.cleared).toBe(1);
  });

  test('escalates a stuck cancellation and clears the timer', async () => {
    const child = new FakeChild({closeOnKill: true});
    const clock = fakeClock();
    const execution = execute(child, clock.dependencies);
    execution.cancel();
    expect(child.signals).toEqual(['SIGTERM']);
    clock.fire();
    await expect(execution.result).rejects.toThrow('Tea execution cancelled');
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(clock.cleared).toBe(1);
  });
});

function machineSweep(rows = 0) {
  const scenarios =
    rows === 0 ? [] : [{bindingIndex: 0, rows, parameters: {}, metrics: {}}];
  const trajectories =
    rows === 0
      ? []
      : [
          {
            bindingIndex: 0,
            rows,
            time: Array.from({length: rows}, () => null),
            parameters: [],
            outputs: [
              {
                id: 'output:0:0',
                outputId: 0,
                channel: 0,
                label: 'value',
                type: 'float',
                values: Array.from({length: rows}, () => null),
              },
            ],
            effectSchemas: [],
            effects: [],
          },
        ];
  return {
    schema: 'tea.execution-result/v1',
    config: {
      bytesHash: '0'.repeat(64),
      programSource: '/work/program.tea',
      programBytesHash: '1'.repeat(64),
      providerBytesHash: '2'.repeat(64),
      effectiveTimeNow: 123,
    },
    system: {
      kind: 'sweep',
      backend: 'cpu',
      numericProfile: 'js-f64',
      executions: scenarios.length,
      rows,
      timing: {loweringMs: 0, executionMs: 0, totalMs: 0},
    },
    sweep: {
      axes: [],
      parameters: [],
      outputs: [],
      metrics: [],
      scenarios,
    },
    trajectories,
  };
}

function execute(child: FakeChild, dependencies: TeaCliDependencies = {}) {
  return executeTeaCli(REQUEST, {
    ...dependencies,
    spawn: () => child,
  });
}

class FakeChild extends EventEmitter implements TeaCliChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(
    private readonly behavior: {
      readonly closeOnSignal?: boolean;
      readonly closeOnKill?: boolean;
    } = {},
  ) {
    super();
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (typeof signal !== 'string') throw new Error('expected named signal');
    this.signals.push(signal);
    if (
      this.behavior.closeOnSignal === true ||
      (this.behavior.closeOnKill === true && signal === 'SIGKILL')
    ) {
      this.signalCode = signal;
      queueMicrotask(() => this.close(null, signal));
    }
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

function fakeClock(): {
  readonly dependencies: TeaCliDependencies;
  readonly delays: readonly number[];
  readonly cleared: number;
  fire(): void;
} {
  let callback: (() => void) | undefined;
  let cleared = 0;
  const delays: number[] = [];
  const handle = {unref() {}} as NodeJS.Timeout;
  return {
    dependencies: {
      setTimer: ((next: () => void, delay?: number) => {
        callback = next;
        delays.push(delay ?? 0);
        return handle;
      }) as typeof setTimeout,
      clearTimer: (() => {
        cleared++;
      }) as typeof clearTimeout,
    },
    delays,
    get cleared() {
      return cleared;
    },
    fire() {
      callback?.();
    },
  };
}
