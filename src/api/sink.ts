// Purpose: Schema-aware row sinks for files and incremental inspection.

import {
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import {once} from 'node:events';
import type {Observer} from 'rxjs';
import {parse as parseCSV} from 'csv-parse/sync';
import {stringify, type Stringifier} from 'csv-stringify';
import {Schema} from 'apache-arrow';
import {cloneSchema, validateRecord} from '../runtime/io';

export type OverflowMode = 'error' | 'drop-oldest' | 'drop-newest' | 'latest';

export type CSVMode = 'a' | 'w';

const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Write validated rows in Arrow field order, or infer columns from the first
 * row when no schema is supplied. Completion waits for the file to finish;
 * errors reject `completion`. Construction alone never opens the file.
 *
 * @example
 * ```ts
 * import {Field, Float64, Schema} from 'apache-arrow';
 * const schema = new Schema([new Field('close', new Float64(), false)]);
 * const sink = new CSVSink('prices.csv', schema);
 * sink.next({close: 12.5});
 * sink.complete();
 * await sink.completion; // File contains "close\n12.5\n".
 * ```
 */
export class CSVSink<T = Record<string, unknown>> implements Observer<T> {
  readonly completion: Promise<void>;
  private readonly resolve: () => void;
  private readonly reject: (error: unknown) => void;
  private readonly schema: Schema | undefined;
  private readonly mode: CSVMode;
  private readonly appendExisting: boolean;
  private columns: string[] | null;
  private csv?: Stringifier;
  private output?: WriteStream;
  private stopped = false;
  private settled = false;

  constructor(path: string, mode?: CSVMode);
  constructor(path: string, schema: Schema, mode?: CSVMode);
  constructor(
    readonly path: string,
    schemaOrMode: Schema | CSVMode = 'w',
    mode: CSVMode = 'w',
  ) {
    this.schema =
      typeof schemaOrMode === 'string' ? undefined : cloneSchema(schemaOrMode);
    this.mode = typeof schemaOrMode === 'string' ? schemaOrMode : mode;
    if (this.mode !== 'a' && this.mode !== 'w') {
      throw new TypeError(`unsupported CSV mode '${String(this.mode)}'`);
    }
    this.appendExisting =
      this.mode === 'a' && existsSync(path) && statSync(path).size > 0;
    this.columns = this.appendExisting
      ? readCSVHeader(path)
      : this.schema === undefined
        ? null
        : this.schema.fields.map(field => field.name);
    if (this.appendExisting && this.schema !== undefined) {
      assertColumns(
        this.columns!,
        this.schema.fields.map(field => field.name),
      );
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.completion = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.resolve = resolve;
    this.reject = reject;
  }

  /**
   * Accept one Observer value, rejecting `completion` if validation or writing fails.
   * @example `sink.next({close: 12.5})` appends one CSV row.
   */
  next(value: T): void {
    this.write(value);
  }

  /**
   * Write a row; await the returned Promise when the file applies backpressure.
   * @example `await sink.write({close: 12.5})` waits when the writer needs to drain.
   */
  write(value: T): void | Promise<void> {
    if (this.stopped) return;
    try {
      const row =
        this.schema === undefined ? value : validateRecord(this.schema, value);
      if (!isRecord(row)) throw new TypeError('CSV row must be an object');
      const keys = Object.keys(row);
      if (this.columns === null) this.columns = keys;
      if (this.schema === undefined) assertColumns(this.columns, keys);
      const csv = this.open();
      const accepted = csv.write(
        Object.fromEntries(
          this.columns.map(column => [column, encodeCSVCell(row[column])]),
        ),
      );
      if (!accepted) return once(csv, 'drain').then(() => undefined);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Stop writing and reject completion with the upstream error.
   * @example `sink.error(new Error('feed failed'))` rejects `sink.completion`.
   */
  error(error: unknown): void {
    this.fail(error);
  }

  /**
   * Finish the file, including a header-only file for an empty declared schema.
   * @example `sink.complete(); await sink.completion` waits for all bytes to flush.
   */
  complete(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.csv !== undefined) {
      this.csv.end();
      return;
    }
    if (this.appendExisting) {
      this.settled = true;
      this.resolve();
      return;
    }
    if (this.columns !== null) {
      this.open().end();
      return;
    }
    this.finishEmptyFile();
  }

  private open(): Stringifier {
    if (this.csv !== undefined) return this.csv;
    if (this.columns === null) {
      throw new Error('CSV columns are unavailable before the first row');
    }
    const csv = stringify({
      columns: this.columns,
      header: !this.appendExisting,
    });
    const output = createWriteStream(this.path, {flags: this.mode});
    csv.once('error', error => this.fail(error));
    output.once('error', error => this.fail(error));
    output.once('finish', () => this.succeed());
    csv.pipe(output);
    this.csv = csv;
    this.output = output;
    return csv;
  }

  private finishEmptyFile(): void {
    const output = createWriteStream(this.path, {flags: this.mode});
    output.once('error', error => this.fail(error));
    output.once('finish', () => this.succeed());
    this.output = output;
    output.end();
  }

  private succeed(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve();
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.stopped = true;
    this.settled = true;
    this.csv?.destroy();
    this.output?.destroy();
    this.reject(error);
  }
}

export class StdoutSink<T> implements Observer<T> {
  private stopped = false;

  constructor(
    private readonly format: (value: T) => string = value =>
      JSON.stringify(value),
    private readonly writeLine: (line: string) => void = line =>
      process.stdout.write(`${line}\n`),
  ) {}

  next(value: T): void {
    this.write(value);
  }

  write(value: T): void {
    if (this.stopped) return;
    try {
      this.writeLine(this.format(value));
    } catch (error) {
      this.error(error);
    }
  }

  error(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    throw error;
  }

  complete(): void {
    if (this.stopped) return;
    this.stopped = true;
  }
}

/**
 * Validate rows with Arrow and send JSON text through one bounded socket queue.
 * `completion` resolves after queued messages and the socket buffer drain.
 * JSON's limitations still apply: binary/BigInt/NaN need an appropriate wire
 * codec if their exact representation matters; Arrow IPC is a separate format.
 *
 * @example
 * ```ts
 * import {Field, Float64, Schema} from 'apache-arrow';
 * const schema = new Schema([new Field('close', new Float64(), false)]);
 * const sink = new WebSocketSink('ws://localhost:8080', schema);
 * sink.next({close: 12.5}); // Sends '{"close":12.5}' after the socket opens.
 * sink.complete();
 * await sink.completion;
 * ```
 */
export class WebSocketSink<T = Record<string, unknown>> implements Observer<T> {
  private readonly shape: Schema;
  readonly completion: Promise<void>;
  private readonly resolve: () => void;
  private readonly reject: (error: unknown) => void;
  private readonly socket: WebSocket;
  private readonly pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ending = false;
  private stopped = false;

  constructor(
    private readonly url: string,
    schema: Schema,
    readonly capacity = 1024,
    readonly overflow: OverflowMode = 'error',
    private readonly highWaterMark = 1024 * 1024,
    private readonly Socket: typeof WebSocket = globalThis.WebSocket,
  ) {
    this.shape = cloneSchema(schema);
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        'WebSocketSink capacity must be a positive safe integer',
      );
    }
    if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 0) {
      throw new RangeError(
        'WebSocketSink highWaterMark must be a non-negative safe integer',
      );
    }
    if (typeof Socket !== 'function') {
      throw new Error('this host provides no WebSocket implementation');
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.completion = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.resolve = resolve;
    this.reject = reject;
    this.socket = new this.Socket(url);
    this.socket.addEventListener('open', this.flush);
    this.socket.addEventListener('error', this.onError);
    this.socket.addEventListener('close', this.onClose);
  }

  /**
   * Return an independent Arrow schema; caller mutations do not affect sends.
   * @example `sink.schema.fields[0].name` is `'close'` in the example above.
   */
  get schema(): Schema {
    return cloneSchema(this.shape);
  }

  /**
   * Accept one Observer row for validated JSON delivery.
   * @example `sink.next({close: 12.5})` sends or queues one JSON text frame.
   */
  next(value: T): void {
    this.write(value);
  }

  /**
   * Send immediately when possible, otherwise apply the configured queue policy.
   * @example `sink.write({close: 12.5})` queues the row while the socket opens.
   */
  write(value: T): void {
    if (this.stopped || this.ending) return;
    try {
      const encoded = JSON.stringify(validateRecord(this.shape, value));
      if (encoded === undefined)
        throw new TypeError('WebSocket datum is not JSON-serializable');
      if (
        this.socket.readyState === this.Socket.OPEN &&
        this.pending.length === 0 &&
        this.socket.bufferedAmount <= this.highWaterMark
      ) {
        this.socket.send(encoded);
        return;
      }
      this.enqueue(encoded);
      this.flush();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Close the socket and reject completion with the supplied error.
   * @example `sink.error(new Error('feed failed'))` rejects `sink.completion`.
   */
  error(error: unknown): void {
    this.fail(error);
  }

  /**
   * Drain queued messages, close the socket, and then resolve completion.
   * @example `sink.complete(); await sink.completion` waits for the queue to drain.
   */
  complete(): void {
    if (this.stopped || this.ending) return;
    this.ending = true;
    this.flush();
  }

  private enqueue(value: string): void {
    if (this.pending.length < this.capacity) {
      this.pending.push(value);
      return;
    }
    switch (this.overflow) {
      case 'error':
        throw new RangeError(
          `WebSocketSink exceeded capacity ${this.capacity}`,
        );
      case 'drop-oldest':
        this.pending.shift();
        this.pending.push(value);
        return;
      case 'drop-newest':
        return;
      case 'latest':
        this.pending.splice(0, this.pending.length, value);
    }
  }

  private flush = (): void => {
    if (this.stopped || this.socket.readyState !== this.Socket.OPEN) return;
    while (
      this.pending.length > 0 &&
      this.socket.bufferedAmount <= this.highWaterMark
    ) {
      this.socket.send(this.pending.shift()!);
    }
    if (this.pending.length > 0 || this.socket.bufferedAmount > 0) {
      if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, 1);
      }
      return;
    }
    if (this.ending) this.socket.close();
  };

  private onError = (): void => {
    this.fail(new Error(`WebSocket sink '${this.url}' failed`));
  };

  private onClose = (): void => {
    this.clearTimer();
    if (this.stopped) return;
    this.stopped = true;
    if (this.ending && this.pending.length === 0) this.resolve();
    else
      this.reject(
        new Error(`WebSocket sink '${this.url}' closed before completion`),
      );
  };

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    this.socket.removeEventListener('open', this.flush);
    this.socket.removeEventListener('error', this.onError);
    this.socket.removeEventListener('close', this.onClose);
    if (
      this.socket.readyState === this.Socket.CONNECTING ||
      this.socket.readyState === this.Socket.OPEN
    ) {
      this.socket.close();
    }
    this.reject(error);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertColumns(expected: readonly string[], actual: readonly string[]) {
  if (
    expected.length !== actual.length ||
    expected.some(column => !actual.includes(column))
  ) {
    throw new Error(
      `CSV columns do not match: expected ${expected.join(', ')}, received ${actual.join(', ')}`,
    );
  }
}

function encodeCSVCell(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

function readCSVHeader(path: string): string[] {
  const size = Math.min(statSync(path).size, MAX_HEADER_BYTES);
  const buffer = Buffer.alloc(size);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  const rows = parseCSV(buffer.toString('utf8'), {
    bom: true,
    to_line: 1,
  }) as unknown[][];
  const header = rows[0];
  if (
    header === undefined ||
    header.length === 0 ||
    header.some(column => typeof column !== 'string' || column === '') ||
    new Set(header).size !== header.length
  ) {
    throw new Error(`CSV sink '${path}' has an invalid header`);
  }
  return header as string[];
}
