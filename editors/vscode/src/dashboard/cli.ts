// Purpose: Invoke Tea's bounded machine-readable execution contract without a shell.

import {spawn} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';
import type {DashboardCliResult, MachineExecutionResult} from './protocol';
import {
  parseDashboardTrajectoryResult,
  parseMachineExecutionResult,
} from './protocol';

const MAX_STDOUT_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
// The Bun GPU relay gives Dawn five seconds to stop. Killing the relay sooner
// could orphan that child, so the outer host waits beyond the relay's grace.
const TERMINATION_GRACE_MS = 6_500;
const DASHBOARD_SCENARIO_SCHEMA = 'tea.dashboard-scenario/v1';

export interface TeaCliChild {
  readonly stdin: Writable | null;
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
      readonly stdio: ['pipe', 'pipe', 'pipe'];
    },
  ) => TeaCliChild;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly terminationGraceMs?: number;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
  // Test seam for the persistent dashboard protocol. Production enables the
  // session automatically when it owns the real spawn function.
  readonly dashboardSession?: boolean;
}

export interface TeaCliRequest {
  // One dashboard panel owns one native CLI session. This must not be derived
  // from config identity: two panels may intentionally inspect the same file.
  readonly ownerId?: string;
  readonly executable: string;
  readonly configPath: string;
  readonly cwd: string;
  readonly scenario?: {
    readonly bindingIndex: number;
    readonly configBytesHash: string;
    readonly programBytesHash: string;
    readonly providerBytesHash: string;
    readonly effectiveTimeNow: number;
  };
}

export interface TeaCliExecution {
  readonly result: Promise<DashboardCliResult>;
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
  // The real dashboard retains the CLI process after its initial sweep. This
  // removes Bun -> Node/Dawn startup from point selection while each request
  // is still revalidated by the CLI. Injected process doubles keep the simple
  // one-shot boundary used by unit tests.
  if (
    request.ownerId !== undefined &&
    (dependencies.spawn === undefined || dependencies.dashboardSession === true)
  ) {
    const key = request.ownerId;
    if (request.scenario === undefined) {
      dashboardSessions.get(key)?.close();
      const session = createDashboardSession(request, key, dependencies);
      dashboardSessions.set(key, session);
      return session.initialExecution;
    }
    const session = dashboardSessions.get(key);
    if (session?.matches(request.scenario) === true) {
      return session.execute(request.scenario);
    }
    session?.close();
    return rejectedExecution(
      new TeaCliError('Tea dashboard session is unavailable; rerun the sweep'),
    );
  }
  return executeOneShot(request, dependencies);
}

function executeOneShot(
  request: TeaCliRequest,
  dependencies: TeaCliDependencies,
): TeaCliExecution {
  const args = teaCliArguments(request);
  const child = (dependencies.spawn ?? defaultSpawn)(request.executable, args, {
    cwd: request.cwd,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  const args = ['execute', request.configPath, '--json'];
  if (request.scenario !== undefined) {
    args.push(
      '--scenario',
      String(request.scenario.bindingIndex),
      '--expected-config-sha256',
      request.scenario.configBytesHash,
      '--expected-program-sha256',
      request.scenario.programBytesHash,
      '--expected-provider-sha256',
      request.scenario.providerBytesHash,
      '--replay-time-now',
      String(request.scenario.effectiveTimeNow),
    );
  }
  return args;
}

function dashboardTeaCliArguments(request: TeaCliRequest): readonly string[] {
  return [...teaCliArguments(request), '--dashboard-session'];
}

interface DashboardSessionSnapshot {
  readonly configBytesHash: string;
  readonly programBytesHash: string;
  readonly providerBytesHash: string;
  readonly effectiveTimeNow: number;
}

interface PendingResponse {
  cancelled: boolean;
  settled: boolean;
  readonly requestLine: string | null;
  resolve(value: DashboardCliResult): void;
  reject(error: Error): void;
}

const dashboardSessions = new Map<string, DashboardTeaSession>();

class DashboardTeaSession {
  readonly initialExecution: TeaCliExecution;
  private inflight: PendingResponse | null = null;
  private queued: PendingResponse | null = null;
  private snapshot: DashboardSessionSnapshot | null = null;
  private readonly stdoutChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private readonly stderr: Buffer[] = [];
  private stderrBytes = 0;
  private terminationTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly key: string,
    private readonly child: TeaCliChild,
    private readonly maxStdoutBytes: number,
    private readonly maxStderrBytes: number,
  ) {
    this.child.stdout.on('data', chunk => this.onStdout(chunk as Buffer));
    this.child.stderr.on('data', chunk => this.onStderr(chunk as Buffer));
    this.child.stdin?.on('error', error => this.fail(error));
    this.child.once('error', error => this.fail(error));
    this.child.once('close', (code, signal) => this.onClose(code, signal));
    this.initialExecution = this.nextResponse(result => {
      this.snapshot = {
        configBytesHash: result.config.bytesHash,
        programBytesHash: result.config.programBytesHash,
        providerBytesHash: result.config.providerBytesHash,
        effectiveTimeNow: result.config.effectiveTimeNow,
      };
    }, null);
  }

  matches(snapshot: DashboardSessionSnapshot): boolean {
    return (
      !this.closed &&
      this.snapshot !== null &&
      this.snapshot.configBytesHash === snapshot.configBytesHash &&
      this.snapshot.programBytesHash === snapshot.programBytesHash &&
      this.snapshot.providerBytesHash === snapshot.providerBytesHash &&
      this.snapshot.effectiveTimeNow === snapshot.effectiveTimeNow
    );
  }

  execute(scenario: NonNullable<TeaCliRequest['scenario']>): TeaCliExecution {
    return this.nextResponse(
      undefined,
      `${JSON.stringify({
        schema: DASHBOARD_SCENARIO_SCHEMA,
        bindingIndex: scenario.bindingIndex,
        configBytesHash: scenario.configBytesHash,
        programBytesHash: scenario.programBytesHash,
        providerBytesHash: scenario.providerBytesHash,
        effectiveTimeNow: scenario.effectiveTimeNow,
      })}\n`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (dashboardSessions.get(this.key) === this) {
      dashboardSessions.delete(this.key);
    }
    const pending = [this.inflight, this.queued];
    this.inflight = null;
    this.queued = null;
    pending.forEach(response => {
      if (response !== null) {
        this.rejectResponse(
          response,
          new TeaCliError('Tea execution cancelled'),
        );
      }
    });
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      this.terminationTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill('SIGKILL');
        }
      }, TERMINATION_GRACE_MS);
      this.terminationTimer.unref();
    }
  }

  private nextResponse(
    accept?: (result: DashboardCliResult) => void,
    requestLine: string | null = null,
  ): TeaCliExecution {
    let response: PendingResponse;
    const result = new Promise<DashboardCliResult>((resolve, reject) => {
      response = {
        cancelled: false,
        settled: false,
        requestLine,
        resolve: value => {
          try {
            accept?.(value);
            resolve(value);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject,
      };
    });
    const pending = response!;
    if (requestLine === null) {
      if (this.inflight !== null || this.queued !== null) {
        throw new TeaCliError('Tea dashboard session already started');
      }
      this.inflight = pending;
    } else {
      this.enqueue(pending);
    }
    return {
      result,
      cancel: () => this.cancelResponse(pending),
    };
  }

  private enqueue(response: PendingResponse): void {
    if (this.closed) {
      this.rejectResponse(response, new TeaCliError('Tea execution cancelled'));
      return;
    }
    if (this.inflight === null) {
      this.inflight = response;
      this.writeRequest(response);
      return;
    }
    if (this.queued !== null) {
      this.rejectResponse(
        this.queued,
        new TeaCliError('Tea execution cancelled'),
      );
    }
    this.queued = response;
  }

  private cancelResponse(response: PendingResponse): void {
    if (response.settled) return;
    response.cancelled = true;
    if (this.queued === response) this.queued = null;
    this.rejectResponse(response, new TeaCliError('Tea execution cancelled'));
  }

  private rejectResponse(response: PendingResponse, error: Error): void {
    if (response.settled) return;
    response.settled = true;
    response.reject(error);
  }

  private writeRequest(response: PendingResponse): void {
    if (response.requestLine === null) return;
    const input = this.child.stdin;
    if (input === null) {
      this.fail(new TeaCliError('Tea dashboard session has no input stream'));
      return;
    }
    input.write(response.requestLine);
  }

  private advanceQueue(): void {
    if (this.closed || this.inflight !== null) return;
    const next = this.queued;
    this.queued = null;
    if (next === null) return;
    this.inflight = next;
    this.writeRequest(next);
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed) return;
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index);
      this.stdoutChunks.push(part);
      this.stdoutBytes += part.byteLength;
      if (!this.checkFrameSize()) return;
      const line = Buffer.concat(this.stdoutChunks, this.stdoutBytes);
      this.stdoutChunks.length = 0;
      this.stdoutBytes = 0;
      if (line.byteLength > 0) this.acceptLine(line);
      if (this.closed) return;
      start = index + 1;
    }
    if (start < chunk.byteLength) {
      const remainder = chunk.subarray(start);
      this.stdoutChunks.push(remainder);
      this.stdoutBytes += remainder.byteLength;
      this.checkFrameSize();
    }
  }

  private checkFrameSize(): boolean {
    if (this.stdoutBytes <= this.maxStdoutBytes) return true;
    this.fail(
      new TeaCliError(
        `Tea CLI JSON exceeded the ${formatByteLimit(this.maxStdoutBytes)} dashboard limit`,
      ),
    );
    return false;
  }

  private acceptLine(line: Buffer): void {
    const pending = this.inflight;
    if (pending === null) {
      this.fail(new TeaCliError('Tea CLI returned an unexpected result'));
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line.toString('utf8'));
    } catch {
      this.fail(new TeaCliError('Tea CLI returned malformed JSON'));
      return;
    }
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      !Array.isArray(decoded) &&
      (decoded as Record<string, unknown>)['schema'] ===
        'tea.dashboard-error/v1' &&
      typeof (decoded as Record<string, unknown>)['error'] === 'string'
    ) {
      this.inflight = null;
      if (!pending.cancelled && !pending.settled) {
        this.rejectResponse(
          pending,
          new TeaCliError((decoded as Record<string, string>)['error']!),
        );
      }
      this.advanceQueue();
      return;
    }
    let result: DashboardCliResult;
    try {
      result =
        pending.requestLine === null
          ? parseMachineExecutionResult(decoded)
          : parseDashboardTrajectoryResult(decoded);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.inflight = null;
    if (!pending.cancelled && !pending.settled) {
      pending.settled = true;
      pending.resolve(result);
    }
    this.advanceQueue();
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBytes += chunk.byteLength;
    if (this.stderrBytes > this.maxStderrBytes) {
      this.fail(
        new TeaCliError(
          `Tea CLI diagnostics exceeded the ${formatByteLimit(this.maxStderrBytes)} dashboard limit`,
        ),
      );
      return;
    }
    this.stderr.push(chunk);
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.terminationTimer !== null) clearTimeout(this.terminationTimer);
    this.terminationTimer = null;
    const wasClosed = this.closed;
    this.closed = true;
    if (dashboardSessions.get(this.key) === this) {
      dashboardSessions.delete(this.key);
    }
    if (this.inflight === null && this.queued === null) return;
    const diagnostic = Buffer.concat(this.stderr).toString('utf8').trim();
    const error = new TeaCliError(
      wasClosed
        ? 'Tea execution cancelled'
        : diagnostic ||
            `Tea CLI exited ${signal === null ? `with code ${code}` : `on ${signal}`}`,
    );
    const pending = [this.inflight, this.queued];
    this.inflight = null;
    this.queued = null;
    pending.forEach(response => {
      if (response !== null) this.rejectResponse(response, error);
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    const failure =
      error instanceof TeaCliError
        ? error
        : new TeaCliError(`Tea dashboard session failed: ${error.message}`);
    const pending = [this.inflight, this.queued];
    this.inflight = null;
    this.queued = null;
    pending.forEach(response => {
      if (response !== null) this.rejectResponse(response, failure);
    });
    this.close();
  }
}

function rejectedExecution(error: Error): TeaCliExecution {
  return {result: Promise.reject(error), cancel() {}};
}

function createDashboardSession(
  request: TeaCliRequest,
  key: string,
  dependencies: TeaCliDependencies,
): DashboardTeaSession {
  const child = (dependencies.spawn ?? defaultSpawn)(
    request.executable,
    dashboardTeaCliArguments(request),
    {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return new DashboardTeaSession(
    key,
    child,
    dependencies.maxStdoutBytes ?? MAX_STDOUT_BYTES,
    dependencies.maxStderrBytes ?? MAX_STDERR_BYTES,
  );
}

export function disposeTeaCliSession(ownerId: string): void {
  dashboardSessions.get(ownerId)?.close();
}

export function disposeTeaCliSessions(): void {
  [...dashboardSessions.values()].forEach(session => session.close());
  dashboardSessions.clear();
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
      overflow ??= `Tea CLI JSON exceeded the ${formatByteLimit(maxStdoutBytes)} dashboard limit`;
      cancel();
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > maxStderrBytes) {
      overflow ??= `Tea CLI diagnostics exceeded the ${formatByteLimit(maxStderrBytes)} dashboard limit`;
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
  if (wasCancelled())
    throw new TeaCliError(overflow ?? 'Tea execution cancelled');
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
    readonly stdio: ['pipe', 'pipe', 'pipe'];
  },
): TeaCliChild {
  return spawn(executable, args, options);
}

function formatByteLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} B`;
}
