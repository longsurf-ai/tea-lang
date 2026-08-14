import {describe, expect, test} from 'bun:test';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {
  expectedRelayedConfigHash,
  needsNodeGpuHost,
  relayGpuCliToNode,
  type GpuCliRelayDependencies,
} from './node-host';

describe('Node GPU CLI host selection', () => {
  test('relays only GPU execution verbs', () => {
    expect(needsNodeGpuHost(['sweep', 'x.tea', '-i', 'x.csv'])).toBe(true);
    expect(needsNodeGpuHost(['sweep', 'x.tea', '-i', 'x.csv', '--cpu'])).toBe(
      false,
    );
    expect(needsNodeGpuHost(['run', 'x.tea', '--gpu'])).toBe(true);
    expect(needsNodeGpuHost(['run', 'x.tea'])).toBe(false);
    expect(
      needsNodeGpuHost(['execute', 'run.yaml'], {
        executionRuntime: 'webgpu',
      }),
    ).toBe(true);
    expect(
      needsNodeGpuHost(['execute', 'run.yaml'], {
        executionRuntime: 'javascript',
      }),
    ).toBe(false);
    expect(
      needsNodeGpuHost(['execute', '--help'], {
        executionRuntime: 'webgpu',
      }),
    ).toBe(false);
    expect(needsNodeGpuHost(['sweep', '--help'])).toBe(false);
  });

  test('exposes the private relayed config hash', () => {
    expect(
      expectedRelayedConfigHash({TEA_GPU_CONFIG_SHA256: 'a'.repeat(64)}),
    ).toBe('a'.repeat(64));
    expect(expectedRelayedConfigHash({})).toBeNull();
  });
});

describe('Node GPU CLI host cancellation', () => {
  test('forwards SIGTERM, awaits the child, and removes every listener', async () => {
    const harness = relayHarness();
    const result = harness.start();

    expect(harness.signals.listenerCount('SIGINT')).toBe(1);
    expect(harness.signals.listenerCount('SIGTERM')).toBe(1);
    harness.signals.emit('SIGTERM');
    expect(harness.child.kills).toEqual(['SIGTERM']);
    expect(harness.scheduledDelay).toBe(5_000);

    harness.child.emit('exit', null, 'SIGTERM');
    expect(await result).toBe(143);
    expect(harness.signals.listenerCount('SIGINT')).toBe(0);
    expect(harness.signals.listenerCount('SIGTERM')).toBe(0);
    expect(harness.child.listenerCount('error')).toBe(0);
    expect(harness.child.listenerCount('exit')).toBe(0);
    expect(harness.cancelledTimers).toBe(1);
  });

  test('forwards SIGINT and reports the conventional cancellation code', async () => {
    const harness = relayHarness();
    const result = harness.start();

    harness.signals.emit('SIGINT');
    harness.child.emit('exit', 0, null);

    expect(await result).toBe(130);
    expect(harness.child.kills).toEqual(['SIGINT']);
  });

  test('escalates an unresponsive child and still settles as cancellation', async () => {
    const harness = relayHarness();
    const result = harness.start();

    harness.signals.emit('SIGTERM');
    harness.fireTerminationTimer();
    expect(harness.child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    harness.child.emit('exit', null, 'SIGKILL');

    expect(await result).toBe(143);
  });

  test('a second parent signal escalates immediately', async () => {
    const harness = relayHarness();
    const result = harness.start();

    harness.signals.emit('SIGINT');
    harness.signals.emit('SIGTERM');
    expect(harness.child.kills).toEqual(['SIGINT', 'SIGKILL']);
    harness.child.emit('exit', null, 'SIGKILL');

    expect(await result).toBe(130);
  });

  test('unexpected child failures reject and clean parent signal handlers', async () => {
    const harness = relayHarness();
    const result = harness.start();

    harness.child.emit('exit', null, 'SIGKILL');

    await expect(result).rejects.toThrow(
      'Node GPU host exited with signal SIGKILL',
    );
    expect(harness.signals.listenerCount('SIGINT')).toBe(0);
    expect(harness.signals.listenerCount('SIGTERM')).toBe(0);
  });

  test('passes the private relay state to the child environment', async () => {
    const harness = relayHarness();
    const hash = 'b'.repeat(64);
    const result = harness.start({configBytesHash: hash});

    expect(harness.spawnEnvironment).toMatchObject({
      EXISTING: 'kept',
      TEA_GPU_RELAYED: '1',
      TEA_GPU_CONFIG_SHA256: hash,
    });
    harness.child.emit('exit', 7, null);
    expect(await result).toBe(7);
  });
});

class FakeRelayChild extends EventEmitter {
  readonly kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    return true;
  }
}

function relayHarness() {
  const signals = new EventEmitter();
  const child = new FakeRelayChild();
  let scheduled: (() => void) | null = null;
  let scheduledDelay: number | null = null;
  let cancelledTimers = 0;
  let spawnEnvironment: NodeJS.ProcessEnv | null = null;
  const dependencies: GpuCliRelayDependencies = {
    isBun: true,
    environment: {EXISTING: 'kept'},
    findNode: () => '/fake/node22',
    spawnChild: (_command, _args, options) => {
      spawnEnvironment = options.env;
      return child as unknown as ChildProcess;
    },
    signals,
    timers: {
      schedule(callback, delayMs) {
        scheduled = callback;
        scheduledDelay = delayMs;
        return callback;
      },
      cancel() {
        cancelledTimers++;
        scheduled = null;
      },
    },
  };
  return {
    child,
    signals,
    get scheduledDelay() {
      return scheduledDelay;
    },
    get cancelledTimers() {
      return cancelledTimers;
    },
    get spawnEnvironment() {
      return spawnEnvironment;
    },
    fireTerminationTimer() {
      const callback = scheduled;
      if (callback === null) throw new Error('no termination timer scheduled');
      callback();
    },
    start(selection: {readonly configBytesHash?: string} = {}) {
      return relayGpuCliToNode(
        ['execute', '/workspace/sweep.yaml'],
        'file:///workspace/src/main.ts',
        {executionRuntime: 'webgpu', ...selection},
        dependencies,
      );
    },
  };
}
