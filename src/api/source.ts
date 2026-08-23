// Purpose: External data sources for the RxJS-backed public runtime API.

import {createReadStream} from 'node:fs';
import {from} from 'rxjs';
import {parse, type Options, type Parser} from 'csv-parse';
import * as z from 'zod';
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
  ) {}

  /** Discover string-valued columns from the header when schema is omitted. */
  static async open<T extends z.ZodType = CSVSchema>(
    path: string,
    schema?: T,
  ): Promise<CSVSource<T>> {
    return new CSVSource(
      path,
      (schema ?? (await discoverCSVSchema(path))) as T,
    );
  }

  /** Return a cold stream; every subscription opens its own file reader. */
  stream(): DataStream<z.output<T>> {
    return new DataStream(this.schema, subscriber =>
      from(csvRows(this.path, this.schema)).subscribe(subscriber),
    );
  }
}

/** CSV headers identify columns but do not provide authoritative scalar types. */
export async function discoverCSVSchema(path: string): Promise<CSVSchema> {
  const parser = openCSV(path, {bom: true, skip_empty_lines: true});
  try {
    for await (const record of parser) {
      if (
        !Array.isArray(record) ||
        record.length === 0 ||
        record.some(header => typeof header !== 'string' || header === '') ||
        new Set(record).size !== record.length
      ) {
        throw new Error(`CSV source '${path}' has an invalid header`);
      }
      return z.strictObject(
        Object.fromEntries(record.map(header => [header, z.string()])),
      );
    }
    throw new Error(`CSV source '${path}' has no header`);
  } finally {
    parser.destroy();
  }
}

export async function fromCSV<T extends z.ZodType = CSVSchema>(
  path: string,
  schema?: T,
): Promise<DataStream<z.output<T>>> {
  return (await CSVSource.open(path, schema)).stream();
}

async function* csvRows<T extends z.ZodType>(
  path: string,
  schema: T,
): AsyncGenerator<z.output<T>> {
  const parser = openCSV(path, {
    bom: true,
    columns: true,
    group_columns_by_name: true,
    skip_empty_lines: true,
  });
  try {
    for await (const record of parser) {
      yield schema.parse(record);
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

export class WebSocketSource implements Source<z.ZodUnknown> {
  readonly schema = z.unknown();

  constructor(private readonly url: string) {}

  stream(): DataStream<unknown> {
    throw new Error(`WebSocketSource is not implemented for '${this.url}'`);
  }
}

export function fromWS(url: string): DataStream<unknown> {
  return new WebSocketSource(url).stream();
}
