import type {Module} from '../runtime/module-binding';
// Purpose: Test helpers execute explicit finite DataStreams through Batch Recipe.

import {parse} from 'csv-parse/sync';
import {from} from 'rxjs';
import {Field, Float64, Schema, TimestampMillisecond} from 'apache-arrow';
import {i} from '../api/clock';
import {createNode, type BindingInput} from '../api/node';
import {DataStream} from '../api/stream';
import {generate} from '../codegen/codegen';
import {pineBuiltinSupplier} from '../extension/pine';
import type {Program} from '../ir/program';
import {batchRecipe} from '../recipe/batch';
import {loadModule} from '../runtime/load';
import {requireConcreteModule} from '../runtime/module-binding';

import type {OutputCapture} from './output';

export async function executeTestProgram(
  program: Program,
  options: {
    readonly stream: DataStream<unknown>;
    readonly requests?: Readonly<Record<string, DataStream<unknown>>>;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly sink: OutputCapture;
    readonly timeNow?: number;
  },
): Promise<{
  readonly indices: number;
  readonly inputs: Module['parameters'];
}> {
  return executeTestModule(loadModule(generate(program)), options);
}

export async function executeTestModule(
  module: Module,
  options: {
    readonly stream: DataStream<unknown>;
    readonly requests?: Readonly<Record<string, DataStream<unknown>>>;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly sink: OutputCapture;
    readonly timeNow?: number;
  },
): Promise<{
  readonly indices: number;
  readonly inputs: Module['parameters'];
}> {
  const node = createNode(
    module.clone().bind(options.params ?? {}),
    pineBuiltinSupplier(() => options.timeNow ?? 0),
  );
  const bindings: BindingInput[] = [];
  options.sink.declare(node.module.outputs);
  bindings.push(options.stream);
  if (options.requests !== undefined && Object.keys(options.requests).length) {
    bindings.push(options.requests);
  }
  const result = await batchRecipe(node, bindings, {
    next: datum => options.sink.publish(datum),
  }).execute();
  return {...result, inputs: requireConcreteModule(node.module).parameters};
}

/**
 * Adapt a numeric conformance CSV to a finite Arrow stream. Time columns use
 * exact epoch-millisecond numbers; common OHLC derived prices are filled in.
 *
 * @example `csvStream('time,close\n1000,12').indices` is 1 and its time field
 * is TimestampMillisecond, with a Float64 close field.
 */
export function csvStream(
  text: string,
  trailingIndices?: number,
): DataStream<unknown> {
  const all = parse(text, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as readonly Readonly<Record<string, string>>[];
  const parsed =
    trailingIndices === undefined || trailingIndices >= all.length
      ? all
      : all.slice(all.length - trailingIndices);
  const names =
    parsed.length === 0 ? csvHeaders(text) : Object.keys(parsed[0]!);
  const rows = parsed.map((input, index) => {
    const row: Record<string, number> = {};
    for (const name of names) {
      const raw = input[name];
      if (raw === undefined) {
        throw new Error(`CSV input has no value for '${name}'`);
      }
      if (name === 'time' || name === 'time_close') {
        if (raw === '') throw new Error(`CSV input has no value for '${name}'`);
        row[name] = epoch(raw);
      } else {
        const value = Number(raw);
        if (raw !== '' && !Number.isFinite(value)) {
          throw new Error(`CSV input '${name}' is not finite`);
        }
        row[name] = raw === '' ? Number.NaN : value;
      }
    }
    derivePrices(row);
    if ('time' in row && !('time_close' in row)) {
      const time = row.time!;
      const next = parsed[index + 1]?.['time'];
      const previous = parsed[index - 1]?.['time'];
      const span =
        next !== undefined
          ? epoch(next) - time
          : previous !== undefined
            ? time - epoch(previous)
            : 0;
      row.time_close = time + span;
    }
    return Object.freeze(row);
  });
  const schema = new Schema(
    [...new Set([...names, ...rows.flatMap(row => Object.keys(row))])].map(
      name =>
        new Field(
          name,
          name === 'time' || name === 'time_close'
            ? new TimestampMillisecond()
            : new Float64(),
          false,
        ),
    ),
  );
  return new DataStream(schema, from(rows), i, rows.length);
}

/**
 * Give immutable test values an explicit Arrow schema and exact extent.
 * @example `finiteStream(new Schema([new Field('close', new Float64())]), [{close: 12}])`
 * emits one record and reports `indices === 1`.
 */
export function finiteStream<T extends Readonly<Record<string, unknown>>>(
  schema: Schema,
  values: readonly T[],
): DataStream<T> {
  return new DataStream(schema, from(values), i, values.length);
}

/**
 * Zip equal-length numeric columns into a finite stream. Optional times declare
 * TimestampMillisecond fields; missing times leave the stream untimed.
 * @example `arrayStream({close: [10, 12]}, [1000, 2000]).indices` is 2.
 */
export function arrayStream(
  series: Readonly<Record<string, readonly number[]>>,
  time?: readonly number[],
): DataStream<unknown> {
  const indices = Object.values(series)[0]?.length ?? time?.length ?? 0;
  for (const [name, values] of Object.entries(series)) {
    if (values.length !== indices) {
      throw new Error(
        `array series '${name}' has ${values.length} values for ${indices} indices`,
      );
    }
  }
  if (time !== undefined && time.length !== indices) {
    throw new Error(
      `array time has ${time.length} values for ${indices} indices`,
    );
  }
  const rows = Array.from({length: indices}, (_, index) => {
    const row: Record<string, number> = Object.fromEntries(
      Object.entries(series).map(([name, values]) => [name, values[index]!]),
    );
    if (time !== undefined) {
      row.time = time[index]!;
      const span =
        index + 1 < time.length
          ? time[index + 1]! - time[index]!
          : index > 0
            ? time[index]! - time[index - 1]!
            : 0;
      row.time_close = time[index]! + span;
    }
    return Object.freeze(row);
  });
  const fields: Field[] = Object.keys(series).map(
    name => new Field(name, new Float64(), false),
  );
  if (time !== undefined) {
    fields.push(new Field('time', new TimestampMillisecond(), false));
    fields.push(new Field('time_close', new TimestampMillisecond(), false));
  }
  return new DataStream(new Schema(fields), from(rows), i, indices);
}

function epoch(raw: string): number {
  const value = Number(BigInt(raw));
  if (!Number.isSafeInteger(value))
    throw new Error(`CSV time '${raw}' is not a safe epoch millisecond`);
  return value;
}

function csvHeaders(text: string): readonly string[] {
  const [header = ''] = text.split(/\r?\n/, 1);
  return header
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
}

function derivePrices(row: Record<string, number>): void {
  const numeric = (name: string): number | null =>
    typeof row[name] === 'number' ? row[name] : null;
  const high = numeric('high');
  const low = numeric('low');
  const close = numeric('close');
  const open = numeric('open');
  if (row.hl2 === undefined && high !== null && low !== null) {
    row.hl2 = (high + low) / 2;
  }
  if (
    row.hlc3 === undefined &&
    high !== null &&
    low !== null &&
    close !== null
  ) {
    row.hlc3 = (high + low + close) / 3;
  }
  if (
    row.ohlc4 === undefined &&
    open !== null &&
    high !== null &&
    low !== null &&
    close !== null
  ) {
    row.ohlc4 = (open + high + low + close) / 4;
  }
  if (
    row.hlcc4 === undefined &&
    high !== null &&
    low !== null &&
    close !== null
  ) {
    row.hlcc4 = (high + low + close + close) / 4;
  }
}
