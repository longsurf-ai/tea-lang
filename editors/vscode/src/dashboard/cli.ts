// Purpose: Invoke Tea's one-shot, bounded JSON execution contract without a shell.

import {spawn} from 'node:child_process';
import type {Readable} from 'node:stream';
import type {MachineExecutionResult} from './protocol';
import {parseMachineExecutionResult} from './protocol';

const MAX_STDOUT_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
// The Bun GPU relay gives Dawn five seconds to stop. Killing the relay sooner
// could orphan that child, so the outer host waits beyond the relay's grace.
const TERMINATION_GRACE_MS = 6_500;

export interface TeaCliChild {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface TeaCliDependencies {
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly shell: false;
      readonly windowsHide: true;
      readonly stdio: ['ignore', 'pipe', 'pipe'];
    },
  ) => TeaCliChild;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly terminationGraceMs?: number;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}

export interface TeaCliRequest {
  readonly executable: string;
  readonly configPath: string;
  readonly cwd: string;
}

export interface TeaCliExecution {
  readonly result: Promise<MachineExecutionResult>;
  cancel(): void;
}

export class TeaCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeaCliError';
  }
}

export function executeTeaCli(
  request: TeaCliRequest,
  dependencies: TeaCliDependencies = {},
): TeaCliExecution {
  const child = (dependencies.spawn ?? defaultSpawn)(
    request.executable,
    teaCliArguments(request),
    {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let cancelled = false;
  let terminationTimer: NodeJS.Timeout | undefined;
  const schedule = dependencies.setTimer ?? setTimeout;
  const clear = dependencies.clearTimer ?? clearTimeout;
  const cancel = () => {
    if (cancelled || child.exitCode !== null || child.signalCode !== null)
      return;
    cancelled = true;
    child.kill('SIGTERM');
    terminationTimer = schedule(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }, dependencies.terminationGraceMs ?? TERMINATION_GRACE_MS);
    terminationTimer.unref();
  };
  return {
    cancel,
    result: collect(
      child,
      () => cancelled,
      cancel,
      dependencies.maxStdoutBytes ?? MAX_STDOUT_BYTES,
      dependencies.maxStderrBytes ?? MAX_STDERR_BYTES,
    ).finally(() => {
      if (terminationTimer !== undefined) clear(terminationTimer);
    }),
  };
}

export function teaCliArguments(request: TeaCliRequest): readonly string[] {
  return ['execute', request.configPath, '--json'];
}

async function collect(
  child: TeaCliChild,
  wasCancelled: () => boolean,
  cancel: () => void,
  maxStdoutBytes: number,
  maxStderrBytes: number,
): Promise<MachineExecutionResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow: string | null = null;

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > maxStdoutBytes) {
      overflow ??= `Tea CLI JSON exceeded the ${formatByteLimit(maxStdoutBytes)} result limit`;
      cancel();
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > maxStderrBytes) {
      overflow ??= `Tea CLI diagnostics exceeded the ${formatByteLimit(maxStderrBytes)} result limit`;
      cancel();
      return;
    }
    stderr.push(chunk);
  });

  const outcome = await new Promise<
    | {readonly kind: 'error'; readonly error: Error}
    | {
        readonly kind: 'close';
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }
  >(resolve => {
    child.once('error', error => resolve({kind: 'error', error}));
    child.once('close', (code, signal) =>
      resolve({kind: 'close', code, signal}),
    );
  });
  if (wasCancelled()) {
    throw new TeaCliError(overflow ?? 'Tea execution cancelled');
  }
  if (outcome.kind === 'error') {
    throw new TeaCliError(`could not start Tea CLI: ${outcome.error.message}`);
  }
  const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
  if (outcome.code !== 0) {
    throw new TeaCliError(
      diagnostic ||
        `Tea CLI exited ${outcome.signal === null ? `with code ${outcome.code}` : `on ${outcome.signal}`}`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  } catch {
    throw new TeaCliError('Tea CLI returned malformed JSON');
  }
  return parseMachineExecutionResult(decoded);
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly shell: false;
    readonly windowsHide: true;
    readonly stdio: ['ignore', 'pipe', 'pipe'];
  },
): TeaCliChild {
  return spawn(executable, args, options);
}

function formatByteLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} B`;
}
