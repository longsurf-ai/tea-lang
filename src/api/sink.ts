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
import * as z from 'zod';

export type OverflowMode = 'error' | 'drop-oldest' | 'drop-newest' | 'latest';

export type CSVMode = 'a' | 'w';

const MAX_HEADER_BYTES = 64 * 1024;

export class CSVSink<T extends z.ZodObject = z.ZodObject> implements Observer<
  z.output<T>
> {
  readonly completion: Promise<void>;
  private readonly resolve: () => void;
  private readonly reject: (error: unknown) => void;
  private readonly schema: T | undefined;
  private readonly mode: CSVMode;
  private readonly appendExisting: boolean;
  private columns: string[] | null;
  private csv?: Stringifier;
  private output?: WriteStream;
  private stopped = false;
  private settled = false;

  constructor(path: string, mode?: CSVMode);
  constructor(path: string, schema: T, mode?: CSVMode);
  constructor(
    readonly path: string,
    schemaOrMode: T | CSVMode = 'w',
    mode: CSVMode = 'w',
  ) {
    this.schema = typeof schemaOrMode === 'string' ? undefined : schemaOrMode;
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
        : Object.keys(this.schema.shape);
    if (this.appendExisting && this.schema !== undefined) {
      assertColumns(this.columns!, Object.keys(this.schema.shape));
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

  next(value: z.output<T>): void {
    this.write(value);
  }

  write(value: z.output<T>): void | Promise<void> {
    if (this.stopped) return;
    try {
      const row = this.schema?.parse(value) ?? value;
      if (!isRecord(row)) throw new TypeError('CSV row must be an object');
      const keys = Object.keys(row);
      if (this.columns === null) this.columns = keys;
      assertColumns(this.columns, keys);
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

  error(error: unknown): void {
    this.fail(error);
  }

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

export class WebSocketSink<T extends z.ZodType> implements Observer<
  z.output<T>
> {
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
    readonly schema: T,
    readonly capacity = 1024,
    readonly overflow: OverflowMode = 'error',
    private readonly highWaterMark = 1024 * 1024,
    private readonly Socket: typeof WebSocket = globalThis.WebSocket,
  ) {
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

  next(value: z.output<T>): void {
    this.write(value);
  }

  write(value: z.output<T>): void {
    if (this.stopped || this.ending) return;
    try {
      const encoded = JSON.stringify(this.schema.parse(value));
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

  error(error: unknown): void {
    this.fail(error);
  }

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
