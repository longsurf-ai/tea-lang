// Purpose: Keep native Dawn outside Bun by relaying GPU CLI verbs to an installed Node 22 host.

import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GpuDeviceError} from './dawn';

const RELAY_ENV = 'TEA_GPU_RELAYED';
const RELAY_CONFIG_HASH_ENV = 'TEA_GPU_CONFIG_SHA256';
const RELAY_TERMINATION_GRACE_MS = 5_000;

type RelaySignal = 'SIGINT' | 'SIGTERM';

interface RelaySignalSource {
  on(signal: RelaySignal, listener: () => void): unknown;
  off(signal: RelaySignal, listener: () => void): unknown;
}

interface RelayTimerHost {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

type RelayChild = Pick<ChildProcess, 'kill' | 'off' | 'once'>;

interface RelaySpawnOptions {
  readonly stdio: 'inherit';
  readonly env: NodeJS.ProcessEnv;
}

export interface GpuCliRelayDependencies {
  readonly isBun?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly findNode?: () => string | null;
  readonly spawnChild?: (
    command: string,
    args: readonly string[],
    options: RelaySpawnOptions,
  ) => RelayChild;
  readonly signals?: RelaySignalSource;
  readonly timers?: RelayTimerHost;
  readonly terminationGraceMs?: number;
}

export interface GpuCliHostSelection {
  readonly executionRuntime?: 'javascript' | 'webgpu';
  readonly configBytesHash?: string;
}

export function needsNodeGpuHost(
  args: readonly string[],
  selection: GpuCliHostSelection = {},
): boolean {
  const verb = args[0];
  if (args.includes('--help') || args.includes('-h')) return false;
  return (
    (verb === 'sweep' && !args.includes('--cpu')) ||
    (verb === 'run' && args.includes('--gpu')) ||
    (verb === 'execute' && selection.executionRuntime === 'webgpu')
  );
}

// Returns null when no relay is needed; otherwise the child CLI's exit code.
// The Bun parent performs no compilation, binding, or presentation work.
export async function relayGpuCliToNode(
  args: readonly string[],
  mainModuleUrl: string,
  selection: GpuCliHostSelection = {},
  dependencies: GpuCliRelayDependencies = {},
): Promise<number | null> {
  const environment = dependencies.environment ?? process.env;
  if (
    (dependencies.isBun ?? process.versions.bun !== undefined) === false ||
    environment[RELAY_ENV] === '1' ||
    !needsNodeGpuHost(args, selection)
  ) {
    return null;
  }
  const node = (dependencies.findNode ?? findNode22Executable)();
  if (node === null) {
    throw new GpuDeviceError(
      'GPU execution requires Node 22; install it or set TEA_GPU_NODE to its executable (or pass --cpu)',
    );
  }
  const child = (dependencies.spawnChild ?? spawn)(
    node,
    ['--import', 'tsx', fileURLToPath(mainModuleUrl), ...args],
    {
      stdio: 'inherit',
      env: {
        ...environment,
        [RELAY_ENV]: '1',
        ...(selection.configBytesHash === undefined
          ? {}
          : {[RELAY_CONFIG_HASH_ENV]: selection.configBytesHash}),
      },
    },
  );
  return await waitForRelayedChild(
    child,
    dependencies.signals ?? process,
    dependencies.timers ?? systemTimers,
    dependencies.terminationGraceMs ?? RELAY_TERMINATION_GRACE_MS,
  );
}

function waitForRelayedChild(
  child: RelayChild,
  signals: RelaySignalSource,
  timers: RelayTimerHost,
  terminationGraceMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let forwardedSignal: RelaySignal | null = null;
    let forceTimer: unknown | null = null;

    const cleanup = (): void => {
      signals.off('SIGINT', onSigint);
      signals.off('SIGTERM', onSigterm);
      child.off('error', onChildError);
      child.off('exit', onChildExit);
      if (forceTimer !== null) {
        timers.cancel(forceTimer);
        forceTimer = null;
      }
    };
    const succeed = (code: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const kill = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // A concurrent child exit can make kill throw. The exit/error event
        // remains the single settlement authority.
      }
    };
    const forward = (signal: RelaySignal): void => {
      if (settled) return;
      if (forwardedSignal !== null) {
        // A second cancellation request is an explicit escalation.
        kill('SIGKILL');
        return;
      }
      forwardedSignal = signal;
      kill(signal);
      forceTimer = timers.schedule(() => {
        if (!settled) kill('SIGKILL');
      }, terminationGraceMs);
    };
    const onSigint = (): void => forward('SIGINT');
    const onSigterm = (): void => forward('SIGTERM');
    const onChildError = (error: Error): void => {
      if (forwardedSignal !== null) {
        succeed(signalExitCode(forwardedSignal));
        return;
      }
      fail(error);
    };
    const onChildExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (forwardedSignal !== null) {
        succeed(signalExitCode(forwardedSignal));
        return;
      }
      if (signal !== null) {
        fail(new GpuDeviceError(`Node GPU host exited with signal ${signal}`));
        return;
      }
      succeed(code ?? 1);
    };

    signals.on('SIGINT', onSigint);
    signals.on('SIGTERM', onSigterm);
    child.once('error', onChildError);
    child.once('exit', onChildExit);
  });
}

function signalExitCode(signal: RelaySignal): number {
  return signal === 'SIGINT' ? 130 : 143;
}

const systemTimers: RelayTimerHost = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function expectedRelayedConfigHash(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const value = environment[RELAY_CONFIG_HASH_ENV];
  return value === undefined || value === '' ? null : value;
}

export function findNode22Executable(): string | null {
  const configured = process.env['TEA_GPU_NODE'];
  const candidates = configured === undefined ? [] : [configured];
  candidates.push('/opt/homebrew/opt/node@22/bin/node');
  candidates.push('/usr/local/opt/node@22/bin/node');
  candidates.push(...nvmNode22Candidates());
  candidates.push('node');
  for (const candidate of candidates) {
    if (candidate !== 'node' && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['--version'], {encoding: 'utf8'});
    if (result.status === 0 && /^v22\./.test(result.stdout.trim())) {
      return candidate;
    }
  }
  return null;
}

function nvmNode22Candidates(): string[] {
  const root = join(homedir(), '.nvm', 'versions', 'node');
  if (!existsSync(root)) return [];
  return readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^v22\./.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) =>
      right.localeCompare(left, undefined, {numeric: true}),
    )
    .map(version => join(root, version, 'bin', 'node'));
}
