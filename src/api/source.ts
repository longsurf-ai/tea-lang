// Purpose: External data sources for the RxJS-backed public runtime API.

import {createReadStream} from 'node:fs';
import {from, Observable} from 'rxjs';
import {parse, type Options, type Parser} from 'csv-parse';
import * as z from 'zod';
import {i, type Clock} from './clock';
import {DataStream} from './stream';

export interface Source<T extends z.ZodType> {
  readonly schema: T;
  stream(): DataStream<z.output<T>>;
}

/* CSV Source */

export type CSVRow = Readonly<Record<string, string>>;
export type CSVSchema = z.ZodObject<Record<string, z.ZodString>>;

export class CSVSource<T extends z.ZodType> implements Source<T> {
  constructor(
    readonly path: string,
    readonly schema: T,
    readonly clock: Clock = i,
    readonly indices: number | null = null,
  ) {}

  /** Inspect the header and finite index count before creating a cold source. */
  static async open<T extends z.ZodType = CSVSchema>(
    path: string,
    schema?: T,
    clock: Clock = i,
  ): Promise<CSVSource<T>> {
    const inspected = await inspectCSV(path);
    return new CSVSource(
      path,
      (schema ?? inspected.schema) as T,
      clock,
      inspected.indices,
    );
  }

  /** Return a cold stream; every subscription opens its own file reader. */
  stream(): DataStream<z.output<T>> {
    return new DataStream<z.output<T>>(
      this.schema as z.ZodType<z.output<T>>,
      from(csvRows<z.output<T>>(this.path)),
      this.clock,
      this.indices,
    );
  }
}

/** CSV headers identify columns but do not provide authoritative scalar types. */
export async function discoverCSVSchema(path: string): Promise<CSVSchema> {
  return (await inspectCSV(path)).schema;
}

async function inspectCSV(
  path: string,
): Promise<{readonly schema: CSVSchema; readonly indices: number}> {
  const parser = openCSV(path, {bom: true, skip_empty_lines: true});
  try {
    let schema: CSVSchema | null = null;
    let indices = 0;
    for await (const record of parser) {
      if (schema === null) {
        if (
          !Array.isArray(record) ||
          record.length === 0 ||
          record.some(header => typeof header !== 'string' || header === '') ||
          new Set(record).size !== record.length
        ) {
          throw new Error(`CSV source '${path}' has an invalid header`);
        }
        schema = z.strictObject(
          Object.fromEntries(record.map(header => [header, z.string()])),
        );
      } else {
        indices += 1;
      }
    }
    if (schema === null) throw new Error(`CSV source '${path}' has no header`);
    return {schema, indices};
  } finally {
    parser.destroy();
  }
}

export async function fromCSV<T extends z.ZodType = CSVSchema>(
  path: string,
  schema?: T,
  clock: Clock = i,
): Promise<DataStream<z.output<T>>> {
  return (await CSVSource.open(path, schema, clock)).stream();
}

async function* csvRows<T>(path: string): AsyncGenerator<T> {
  const parser = openCSV(path, {
    bom: true,
    columns: true,
    group_columns_by_name: true,
    skip_empty_lines: true,
  });
  try {
    for await (const record of parser) {
      yield record as T;
    }
  } finally {
    parser.destroy();
  }
}

function openCSV(path: string, options: Options): Parser {
  const input = createReadStream(path);
  const parser = parse(options);
  input.once('error', error => parser.destroy(error));
  parser.once('close', () => input.destroy());
  return input.pipe(parser);
}

/* WebSocket Source */

export class WebSocketSource<T extends z.ZodType> implements Source<T> {
  constructor(
    private readonly url: string,
    readonly schema: T,
    readonly clock: Clock = i,
    private readonly Socket: typeof WebSocket = globalThis.WebSocket,
  ) {}

  stream(): DataStream<z.output<T>> {
    return new DataStream<z.output<T>>(
      this.schema as z.ZodType<z.output<T>>,
      new Observable(subscriber => {
        if (typeof this.Socket !== 'function') {
          subscriber.error(
            new Error('this host provides no WebSocket implementation'),
          );
          return;
        }
        const socket = new this.Socket(this.url);
        const message = (event: MessageEvent) => {
          if (typeof event.data !== 'string') {
            subscriber.error(
              new TypeError('WebSocketSource accepts text frames only'),
            );
            return;
          }
          try {
            subscriber.next(JSON.parse(event.data));
          } catch (error) {
            subscriber.error(error);
          }
        };
        const error = () =>
          subscriber.error(new Error(`WebSocket source '${this.url}' failed`));
        const close = (event: CloseEvent) => {
          if (event.wasClean) subscriber.complete();
          else
            subscriber.error(
              new Error(`WebSocket source '${this.url}' closed uncleanly`),
            );
        };
        socket.addEventListener('message', message);
        socket.addEventListener('error', error);
        socket.addEventListener('close', close);
        return () => {
          socket.removeEventListener('message', message);
          socket.removeEventListener('error', error);
          socket.removeEventListener('close', close);
          if (
            socket.readyState === WebSocket.CONNECTING ||
            socket.readyState === WebSocket.OPEN
          ) {
            socket.close();
          }
        };
      }),
      this.clock,
    );
  }
}

export function fromWS<T extends z.ZodType>(
  url: string,
  schema: T,
  clock: Clock = i,
): DataStream<z.output<T>> {
  return new WebSocketSource(url, schema, clock).stream();
}
