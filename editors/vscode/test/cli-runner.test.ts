// Purpose: Exercise process failure, bounds, and cancellation at the dashboard CLI boundary.

import {describe, expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {
  disposeTeaCliSession,
  disposeTeaCliSessions,
  executeTeaCli,
  type TeaCliChild,
  type TeaCliDependencies,
  type TeaCliRequest,
} from '../src/dashboard/cli';

const REQUEST: TeaCliRequest = {
  ownerId: 'test-panel',
  executable: 'tea',
  configPath: '/work/sweep.yaml',
  cwd: '/work',
};

describe('Tea dashboard CLI runner', () => {
  test('reuses one framed CLI process and survives a request error', async () => {
    const child = new FakeChild({closeOnSignal: true});
    const dependencies: TeaCliDependencies = {
      dashboardSession: true,
      spawn: () => child,
    };
    try {
      const initial = executeTeaCli(REQUEST, dependencies);
      child.stdout.write(`${JSON.stringify(machineSweep())}\n`);
      const sweep = await initial.result;
      expect(sweep.schema).toBe('tea.execution-result/v1');
      if (sweep.schema !== 'tea.execution-result/v1') {
        throw new Error('expected initial sweep envelope');
      }
      expect(sweep.system.kind).toBe('sweep');

      const writes: string[] = [];
      child.stdin.on('data', chunk => writes.push(String(chunk)));
      const scenario = {
        bindingIndex: 7,
        configBytesHash: '0'.repeat(64),
        programBytesHash: '1'.repeat(64),
        providerBytesHash: '2'.repeat(64),
        effectiveTimeNow: 123,
      };
      const rejected = executeTeaCli({...REQUEST, scenario}, dependencies);
      expect(JSON.parse(writes[0]!)).toMatchObject({
        schema: 'tea.dashboard-scenario/v1',
        bindingIndex: 7,
      });
      child.stdout.write(
        `${JSON.stringify({schema: 'tea.dashboard-error/v1', error: 'bad selection'})}\n`,
      );
      await expect(rejected.result).rejects.toThrow('bad selection');

      const accepted = executeTeaCli({...REQUEST, scenario}, dependencies);
      child.stdout.write(`${JSON.stringify(machineTrajectory(7))}\n`);
      expect((await accepted.result).trajectory?.bindingIndex).toBe(7);
      expect(child.signals).toEqual([]);
    } finally {
      disposeTeaCliSessions();
    }
  });

  test('isolates two panels that open the same config', async () => {
    const first = new FakeChild({closeOnSignal: true});
    const second = new FakeChild({closeOnSignal: true});
    const children = [first, second];
    let spawns = 0;
    const dependencies: TeaCliDependencies = {
      dashboardSession: true,
      spawn: () => children[spawns++]!,
    };
    const firstRequest = {...REQUEST, ownerId: 'panel-a'};
    const secondRequest = {...REQUEST, ownerId: 'panel-b'};
    try {
      const firstSweep = executeTeaCli(firstRequest, dependencies);
      const secondSweep = executeTeaCli(secondRequest, dependencies);
      first.stdout.write(`${JSON.stringify(machineSweep())}\n`);
      second.stdout.write(`${JSON.stringify(machineSweep())}\n`);
      await Promise.all([firstSweep.result, secondSweep.result]);
      expect(spawns).toBe(2);

      const firstWrites: string[] = [];
      const secondWrites: string[] = [];
      first.stdin.on('data', chunk => firstWrites.push(String(chunk)));
      second.stdin.on('data', chunk => secondWrites.push(String(chunk)));
      const firstScenario = executeTeaCli(
        {...firstRequest, scenario: scenario(1)},
        dependencies,
      );
      const secondScenario = executeTeaCli(
        {...secondRequest, scenario: scenario(2)},
        dependencies,
      );
      expect(JSON.parse(firstWrites[0]!).bindingIndex).toBe(1);
      expect(JSON.parse(secondWrites[0]!).bindingIndex).toBe(2);
      first.stdout.write(`${JSON.stringify(machineTrajectory(1))}\n`);
      second.stdout.write(`${JSON.stringify(machineTrajectory(2))}\n`);
      await Promise.all([firstScenario.result, secondScenario.result]);

      disposeTeaCliSession('panel-a');
      expect(first.signals).toEqual(['SIGTERM']);
      expect(second.signals).toEqual([]);
      const stillWarm = executeTeaCli(
        {...secondRequest, scenario: scenario(3)},
        dependencies,
      );
      second.stdout.write(`${JSON.stringify(machineTrajectory(3))}\n`);
      expect((await stillWarm.result).trajectory?.bindingIndex).toBe(3);
      expect(spawns).toBe(2);
    } finally {
      disposeTeaCliSessions();
    }
  });

  test('explicitly closes a settled idle panel session', async () => {
    const child = new FakeChild({closeOnSignal: true});
    const dependencies: TeaCliDependencies = {
      dashboardSession: true,
      spawn: () => child,
    };
    const request = {...REQUEST, ownerId: 'idle-panel'};
    const initial = executeTeaCli(request, dependencies);
    child.stdout.write(`${JSON.stringify(machineSweep())}\n`);
    await initial.result;

    disposeTeaCliSession('idle-panel');
    expect(child.signals).toEqual(['SIGTERM']);
  });

  test('never falls back to an expensive one-shot replay after its archive session is gone', async () => {
    const child = new FakeChild({closeOnSignal: true});
    let spawns = 0;
    const dependencies: TeaCliDependencies = {
      dashboardSession: true,
      spawn: () => {
        spawns += 1;
        return child;
      },
    };
    const request = {...REQUEST, ownerId: 'closed-panel'};
    const initial = executeTeaCli(request, dependencies);
    child.stdout.write(`${JSON.stringify(machineSweep())}\n`);
    await initial.result;
    disposeTeaCliSession('closed-panel');

    const selected = executeTeaCli(
      {...request, scenario: scenario(1)},
      dependencies,
    );
    await expect(selected.result).rejects.toThrow(
      'dashboard session is unavailable',
    );
    expect(spawns).toBe(1);
  });

  test('an old child close cannot unregister its replacement', async () => {
    const first = new FakeChild();
    const replacement = new FakeChild({closeOnSignal: true});
    const children = [first, replacement];
    let spawns = 0;
    const dependencies: TeaCliDependencies = {
      dashboardSession: true,
      spawn: () => children[spawns++]!,
    };
    const request = {...REQUEST, ownerId: 'replacement-panel'};
    try {
      const oldSweep = executeTeaCli(request, dependencies);
      first.stdout.write(`${JSON.stringify(machineSweep())}\n`);
      await oldSweep.result;

      const newSweep = executeTeaCli(request, dependencies);
      expect(first.signals).toEqual(['SIGTERM']);
      first.close(0, null);
      replacement.stdout.write(`${JSON.stringify(machineSweep())}\n`);
      await newSweep.result;

      const writes: string[] = [];
      replacement.stdin.on('data', chunk => writes.push(String(chunk)));
      const selected = executeTeaCli(
        {...request, scenario: scenario(4)},
        dependencies,
      );
      expect(JSON.parse(writes[0]!).bindingIndex).toBe(4);
      replacement.stdout.write(`${JSON.stringify(machineTrajectory(4))}\n`);
      expect((await selected.result).trajectory?.bindingIndex).toBe(4);
      expect(spawns).toBe(2);
    } finally {
      disposeTeaCliSessions();
    }
  });

  test('rapid selection keeps one in flight and sends only the latest queued request', async () => {
    const child = new FakeChild({closeOnSignal: true});
    const dependencies: TeaCliDependencies = {
      dashboardSession: true,
      spawn: () => child,
    };
    const request = {...REQUEST, ownerId: 'rapid-panel'};
    try {
      const initial = executeTeaCli(request, dependencies);
      child.stdout.write(`${JSON.stringify(machineSweep())}\n`);
      await initial.result;

      const writes: string[] = [];
      child.stdin.on('data', chunk => writes.push(String(chunk)));
      const first = executeTeaCli(
        {...request, scenario: scenario(5)},
        dependencies,
      );
      const firstResult = captureError(first.result);
      first.cancel();
      const obsolete = executeTeaCli(
        {...request, scenario: scenario(6)},
        dependencies,
      );
      const obsoleteResult = captureError(obsolete.result);
      const latest = executeTeaCli(
        {...request, scenario: scenario(7)},
        dependencies,
      );
      expect((await firstResult).message).toBe('Tea execution cancelled');
      expect((await obsoleteResult).message).toBe('Tea execution cancelled');
      expect(writes.map(line => JSON.parse(line).bindingIndex)).toEqual([5]);

      child.stdout.write(`${JSON.stringify(machineTrajectory(5))}\n`);
      expect(writes.map(line => JSON.parse(line).bindingIndex)).toEqual([5, 7]);
      child.stdout.write(`${JSON.stringify(machineTrajectory(7))}\n`);
      expect((await latest.result).trajectory?.bindingIndex).toBe(7);
      expect(child.signals).toEqual([]);

      const next = executeTeaCli(
        {...request, scenario: scenario(8)},
        dependencies,
      );
      child.stdout.write(`${JSON.stringify(machineTrajectory(8))}\n`);
      expect((await next.result).trajectory?.bindingIndex).toBe(8);
      expect(child.signals).toEqual([]);
    } finally {
      disposeTeaCliSessions();
    }
  });

  test('assembles a large JSON frame from fragmented chunks', async () => {
    const child = new FakeChild({closeOnSignal: true});
    const dependencies: TeaCliDependencies = {
      dashboardSession: true,
      spawn: () => child,
    };
    const request = {...REQUEST, ownerId: 'fragment-panel'};
    try {
      const initial = executeTeaCli(request, dependencies);
      child.stdout.write(`${JSON.stringify(machineSweep())}\n`);
      await initial.result;

      const selected = executeTeaCli(
        {...request, scenario: scenario(8)},
        dependencies,
      );
      const frame = Buffer.from(
        `${JSON.stringify(machineTrajectory(8, 50_000))}\n`,
      );
      expect(frame.byteLength).toBeGreaterThan(500_000);
      for (let offset = 0; offset < frame.byteLength; offset += 257) {
        child.stdout.write(frame.subarray(offset, offset + 257));
      }
      expect((await selected.result).trajectory).toMatchObject({
        bindingIndex: 8,
        rows: 50_000,
      });
      expect(child.signals).toEqual([]);
    } finally {
      disposeTeaCliSessions();
    }
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
        `Tea CLI ${label} exceeded the 8 B dashboard limit`,
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

function machineConfig() {
  return {
    bytesHash: '0'.repeat(64),
    programSource: '/work/program.tea',
    programBytesHash: '1'.repeat(64),
    providerBytesHash: '2'.repeat(64),
    effectiveTimeNow: 123,
  };
}

function machineSweep() {
  return {
    schema: 'tea.execution-result/v1',
    config: machineConfig(),
    system: {
      kind: 'sweep',
      backend: 'cpu',
      numericProfile: 'js-f64',
      executions: 0,
      rows: 0,
      timing: {loweringMs: 0, executionMs: 0, totalMs: 0},
    },
    sweep: {
      axes: [],
      parameters: [],
      outputs: [],
      metrics: [],
      scenarios: [],
    },
  };
}

function scenario(bindingIndex: number) {
  return {
    bindingIndex,
    configBytesHash: '0'.repeat(64),
    programBytesHash: '1'.repeat(64),
    providerBytesHash: '2'.repeat(64),
    effectiveTimeNow: 123,
  };
}

function machineTrajectory(bindingIndex: number, rows = 0) {
  return {
    schema: 'tea.dashboard-trajectory/v1',
    config: machineConfig(),
    trajectory: {
      bindingIndex,
      rows,
      time: Array.from({length: rows}, () => null),
      parameters: [],
      outputs:
        rows === 0
          ? []
          : [
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
  };
}

function execute(child: FakeChild, dependencies: TeaCliDependencies = {}) {
  return executeTeaCli(REQUEST, {
    ...dependencies,
    spawn: () => child,
  });
}

function captureError<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected promise to reject');
    },
    error => (error instanceof Error ? error : new Error(String(error))),
  );
}

class FakeChild extends EventEmitter implements TeaCliChild {
  readonly stdin = new PassThrough();
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
    if (typeof signal !== 'string')
      throw new Error('test expects named signal');
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
  readonly delays: number[];
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
