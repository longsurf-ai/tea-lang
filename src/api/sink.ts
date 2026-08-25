// Purpose: External data sinks for the RxJS-backed public runtime API.

import {createWriteStream, type WriteStream} from 'node:fs';
import type {Observer} from 'rxjs';
import {stringify, type Stringifier} from 'csv-stringify';
import * as z from 'zod';

export interface Sink<T> extends Observer<T> {
  readonly completion: Promise<void>;
  write(value: T): void;
}

export class CSVSink<T extends z.ZodObject> implements Sink<z.output<T>> {
  readonly completion: Promise<void>;
  private readonly resolve: () => void;
  private readonly reject: (error: unknown) => void;
  private csv?: Stringifier;
  private output?: WriteStream;
  private stopped = false;
  private settled = false;

  constructor(
    readonly path: string,
    readonly schema: T,
  ) {
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

  write(value: z.output<T>): void {
    if (this.stopped) return;
    try {
      const row = this.schema.parse(value);
      this.open().write(row);
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
    this.open().end();
  }

  private open(): Stringifier {
    if (this.csv !== undefined) return this.csv;

    const csv = stringify({
      columns: Object.keys(this.schema.shape),
      header: true,
    });
    const output = createWriteStream(this.path);
    csv.once('error', error => this.fail(error));
    output.once('error', error => this.fail(error));
    output.once('finish', () => {
      if (this.settled) return;
      this.settled = true;
      this.resolve();
    });
    csv.pipe(output);
    this.csv = csv;
    this.output = output;
    return csv;
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
