// Purpose: Structured logging — scoped loggers emitting typed events over a pluggable sink; the package's single diagnostics surface (user-facing errors stay in print.ts, program output is separate).

// One severity ladder. Levels gate emission; they never change semantics —
// logging reports, it must never swallow or replace a typed error path.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// The unit of logging: a structured event, not a formatted string. `message`
// is the human phrase; everything machine-readable rides in `fields`, so
// sinks can render text, JSON lines, or forward to a host telemetry system
// without parsing prose.
export interface LogEvent {
  readonly time: number; // epoch ms
  readonly level: LogLevel;
  readonly scope: string; // dot path: 'source.yahoo', 'compile.check'
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

// Where events go. Hosts swap this: the CLI writes stderr lines, tests
// capture arrays, and embedding hosts can forward to their own telemetry.
export interface LogSink {
  emit(event: LogEvent): void;
}

export interface LogConfig {
  // Events below this level are dropped (cheaply, before construction).
  readonly level: LogLevel;
  // Per-scope overrides; the longest matching dot-prefix wins
  // ('source.yahoo' beats 'source' beats the root level).
  readonly scopes: Readonly<Record<string, LogLevel>>;
  readonly sink: LogSink;
}

// The default sink: single-line text on stderr — stdout belongs to program
// output, so logging never pollutes goldens or pipes.
export function stderrSink(write: (line: string) => void): LogSink {
  return {
    emit(event) {
      const fields = Object.entries(event.fields)
        .map(([key, value]) => `${key}=${formatField(value)}`)
        .join(' ');
      write(
        `[${event.level}] ${event.scope}: ${event.message}` +
          (fields.length > 0 ? ` (${fields})` : ''),
      );
    },
  };
}

function formatField(value: unknown): string {
  if (typeof value === 'string') {
    return value.includes(' ') ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

// Test double: collects events instead of writing anywhere.
export function captureSink(): {sink: LogSink; events: LogEvent[]} {
  const events: LogEvent[] = [];
  return {sink: {emit: event => events.push(event)}, events};
}

// The shared configuration box. Loggers hold a reference, so reconfiguring
// at a host boundary (CLI flags, embedding-host settings, a test) takes effect
// everywhere immediately — scopes are cheap identities, config is the one
// mutable point.
const config: {current: LogConfig} = {
  current: {
    level: 'warn',
    scopes: {},
    sink: stderrSink(line => console.error(line)),
  },
};

// Reconfigure the process-wide logging (host boundaries only: main.ts,
// embedding hosts, tests). Partial: unspecified parts keep their value.
export function configureLog(partial: Partial<LogConfig>): void {
  config.current = {...config.current, ...partial};
}

export function logConfig(): LogConfig {
  return config.current;
}

function effectiveLevel(scope: string): LogLevel {
  const {level, scopes} = config.current;
  let best = level;
  let bestLength = -1;
  for (const [prefix, scoped] of Object.entries(scopes)) {
    if (
      (scope === prefix || scope.startsWith(`${prefix}.`)) &&
      prefix.length > bestLength
    ) {
      best = scoped;
      bestLength = prefix.length;
    }
  }
  return best;
}

export class Logger {
  private constructor(private readonly scope: string) {}

  // The root: modules derive their own scope from it. Never instantiated
  // per call — scopes are stable identities created at module load.
  static root(): Logger {
    return new Logger('');
  }

  child(scope: string): Logger {
    return new Logger(this.scope === '' ? scope : `${this.scope}.${scope}`);
  }

  enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[effectiveLevel(this.scope)];
  }

  debug(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.emit('error', message, fields);
  }

  // Perf instrumentation: const done = log.startTimer('check'); ...;
  // done({files: 3}) emits a debug event carrying elapsed ms.
  startTimer(
    message: string,
  ): (fields?: Readonly<Record<string, unknown>>) => void {
    const start = Date.now();
    return (fields = {}) => {
      this.emit('debug', message, {...fields, ms: Date.now() - start});
    };
  }

  private emit(
    level: LogLevel,
    message: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    if (!this.enabled(level)) {
      return;
    }
    config.current.sink.emit({
      time: Date.now(),
      level,
      scope: this.scope,
      message,
      fields,
    });
  }
}

// The package root logger; modules create scoped children at load:
//   const logger = log.child('source.yahoo');
export const log = Logger.root();

// Parses a host-supplied level name ('TEA_LOG=debug'); null for anything
// unrecognized so hosts can decide whether to complain.
export function parseLogLevel(name: string): LogLevel | null {
  return name === 'debug' ||
    name === 'info' ||
    name === 'warn' ||
    name === 'error'
    ? name
    : null;
}
