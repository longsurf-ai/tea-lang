// Purpose: External data sources for the RxJS-backed public runtime API.

import {createReadStream} from 'node:fs';
import {defer, from, Observable} from 'rxjs';
import {parse, type Options, type Parser} from 'csv-parse';
import {DataType, Field, Schema, Utf8} from 'apache-arrow';
import {cloneSchema} from '../runtime/io';
import {i, type Clock} from './clock';
import {DataStream} from './stream';

/**
 * A source owns decoding and an Arrow schema; its DataStream owns validation.
 * @example `(await CSVSource.open('prices.csv')).stream()` opens the file on subscription.
 */
export interface Source<T = Record<string, unknown>> {
  readonly schema: Schema;
  stream(): DataStream<T>;
}

/* CSV Source */

export type CSVRow = Readonly<Record<string, string>>;

/**
 * A cold CSV source with declared Arrow fields. CSV text is converted to each
 * field's scalar type before validation; undeclared CSV columns are ignored.
 * No file is opened by the constructor. `open()` additionally inspects extent.
 *
 * @example
 * ```ts
 * import {Field, Float64, Schema} from 'apache-arrow';
 * const schema = new Schema([new Field('close', new Float64(), false)]);
 * const source = await CSVSource.open('prices.csv', schema);
 * // A CSV row `12.5` is emitted as {close: 12.5}, not {close: '12.5'}.
 * ```
 */
export class CSVSource<T = Record<string, unknown>> implements Source<T> {
  private readonly shape: Schema;
  constructor(
    readonly path: string,
    schema: Schema,
    readonly clock: Clock = i,
  ) {
    this.shape = cloneSchema(schema);
  }

  /**
   * Return a defensive schema copy; modifying it never changes future reads.
   * @example `source.schema.fields[0].name` is `'close'` for the example above.
   */
  get schema(): Schema {
    return cloneSchema(this.shape);
  }

  /**
   * Inspect the header, then return a cold source. Without an explicit schema
   * every discovered field is non-nullable Arrow Utf8.
   * @example `(await CSVSource.open('prices.csv')).schema.fields[0].name` is the first header.
   */
  static async open<T = Record<string, unknown>>(
    path: string,
    schema?: Schema,
    clock: Clock = i,
  ): Promise<CSVSource<T>> {
    return new CSVSource<T>(path, schema ?? (await inspectCSV(path)), clock);
  }

  /**
   * Return a cold stream; every subscription opens its own file reader and
   * cancellation closes that reader.
   * @example `source.stream().subscribe({next: row => console.log(row)})` prints decoded rows.
   */
  stream(): DataStream<T> {
    return new DataStream<T>(
      this.shape,
      defer(() => from(csvRows<T>(this.path, this.shape))),
      this.clock,
    );
  }
}

/**
 * Read CSV column names as non-nullable Arrow Utf8 fields. Headers establish
 * names, not numeric types; supply an explicit schema to request conversion.
 * @example `(await discoverCSVSchema('prices.csv')).fields[0].type` is a Utf8 instance.
 */
export async function discoverCSVSchema(path: string): Promise<Schema> {
  return inspectCSV(path);
}

async function inspectCSV(path: string): Promise<Schema> {
  const parser = openCSV(path, {bom: true, skip_empty_lines: true});
  try {
    let schema: Schema | null = null;
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
        schema = new Schema(
          record.map(header => new Field(header, new Utf8(), false)),
        );
        break;
      }
    }
    if (schema === null) throw new Error(`CSV source '${path}' has no header`);
    return schema;
  } finally {
    parser.destroy();
  }
}

/**
 * Inspect a CSV file and create its finite, cold DataStream.
 * @example
 * ```ts
 * import {Field, Float64, Schema} from 'apache-arrow';
 * const prices = await fromCSV('prices.csv', new Schema([
 *   new Field('close', new Float64(), false),
 * ]));
 * prices.subscribe({next: row => console.log(row.close)}); // CSV '12.5' becomes 12.5.
 * ```
 */
export async function fromCSV<T = Record<string, unknown>>(
  path: string,
  schema?: Schema,
  clock: Clock = i,
): Promise<DataStream<T>> {
  return (await CSVSource.open<T>(path, schema, clock)).stream();
}

async function* csvRows<T>(path: string, schema: Schema): AsyncGenerator<T> {
  const parser = openCSV(path, {
    bom: true,
    columns: true,
    group_columns_by_name: true,
    skip_empty_lines: true,
  });
  try {
    for await (const record of parser) {
      yield Object.fromEntries(
        schema.fields.map(field => [
          field.name,
          csvCell(field, record[field.name]),
        ]),
      ) as T;
    }
  } finally {
    parser.destroy();
  }
}

function csvCell(field: Field, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (field.nullable && value === '') return null;
  const type = field.type;
  if (DataType.isUtf8(type) || DataType.isLargeUtf8(type)) return value;
  if (DataType.isInt(type) && type.bitWidth === 64) return BigInt(value);
  if (
    DataType.isFloat(type) ||
    DataType.isInt(type) ||
    DataType.isTimestamp(type)
  ) {
    const number = Number(value);
    if (!Number.isFinite(number) && value.trim() !== 'NaN') {
      throw new TypeError(`CSV field '${field.name}' must be numeric`);
    }
    return number;
  }
  if (DataType.isBool(type)) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new TypeError(`CSV field '${field.name}' must be true or false`);
  }
  return JSON.parse(value);
}

function openCSV(path: string, options: Options): Parser {
  const input = createReadStream(path);
  const parser = parse(options);
  input.once('error', error => parser.destroy(error));
  parser.once('close', () => input.destroy());
  return input.pipe(parser);
}

/* WebSocket Source */

/**
 * A cold JSON text source. Each subscription owns one socket and closes it on
 * completion, error, or cancellation. JSON values must already match the Arrow
 * schema; domain conversions belong in the producer or an RxJS map.
 *
 * @example
 * ```ts
 * import {Field, Float64, Schema} from 'apache-arrow';
 * const schema = new Schema([new Field('close', new Float64(), false)]);
 * new WebSocketSource('ws://localhost:8080', schema).stream()
 *   .subscribe({next: row => console.log(row)}); // {close: 12.5}
 * ```
 */
export class WebSocketSource<T = Record<string, unknown>> implements Source<T> {
  private readonly shape: Schema;
  constructor(
    private readonly url: string,
    schema: Schema,
    readonly clock: Clock = i,
    private readonly Socket: typeof WebSocket = globalThis.WebSocket,
  ) {
    this.shape = cloneSchema(schema);
  }

  /**
   * Return an independent Arrow schema without changing socket validation.
   * @example `source.schema.fields[0].name` is `'close'` for the example above.
   */
  get schema(): Schema {
    return cloneSchema(this.shape);
  }

  /**
   * Create a stream without opening a connection; subscribing opens the socket.
   * @example `source.stream().subscribe({next: row => console.log(row)})` receives parsed JSON rows.
   */
  stream(): DataStream<T> {
    return new DataStream<T>(
      this.shape,
      new Observable<T>(subscriber => {
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
            socket.readyState === this.Socket.CONNECTING ||
            socket.readyState === this.Socket.OPEN
          ) {
            socket.close();
          }
        };
      }),
      this.clock,
    );
  }
}

/**
 * Create a cold JSON WebSocket stream validated against an Arrow schema.
 * @example
 * ```ts
 * import {Field, Float64, Schema} from 'apache-arrow';
 * const prices = fromWS('ws://localhost:8080', new Schema([
 *   new Field('close', new Float64(), false),
 * ]));
 * prices.subscribe({next: row => console.log(row.close)}); // {"close":12.5} emits 12.5.
 * ```
 */
export function fromWS<T = Record<string, unknown>>(
  url: string,
  schema: Schema,
  clock: Clock = i,
): DataStream<T> {
  return new WebSocketSource<T>(url, schema, clock).stream();
}
