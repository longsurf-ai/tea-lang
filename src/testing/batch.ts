// Purpose: Test helpers execute explicit finite DataStreams through Batch Recipe.

import {parse} from 'csv-parse/sync';
import {from} from 'rxjs';
import * as z from 'zod';
import {i} from '../api/clock';
import {createNode, type BindingInput} from '../api/node';
import {DataStream} from '../api/stream';
import {generate} from '../codegen/codegen';
import {pineBuiltinSupplier} from '../extension/pine';
import type {Program} from '../ir/program';
import {batchRecipe} from '../recipe/batch';
import type {BoundInput} from '../runtime/binding';
import {loadModule} from '../runtime/load';
import {
  boundInputs,
  moduleBindings,
  moduleDeclaration,
  withModuleBindings,
} from '../runtime/module-binding';
import type {JSModule} from '../runtime/module-abi';
import type {OutputSink} from '../runtime/output';
import {resolveParamValues} from '../runtime/params';

export async function executeTestProgram(
  program: Program,
  options: {
    readonly stream: DataStream<unknown>;
    readonly requests?: Readonly<Record<string, DataStream<unknown>>>;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly sink: OutputSink;
    readonly timeNow?: number;
  },
): Promise<{readonly indices: number; readonly inputs: readonly BoundInput[]}> {
  return executeTestModule(loadModule(generate(program)), options);
}

export async function executeTestModule(
  module: JSModule,
  options: {
    readonly stream: DataStream<unknown>;
    readonly requests?: Readonly<Record<string, DataStream<unknown>>>;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly sink: OutputSink;
    readonly timeNow?: number;
  },
): Promise<{readonly indices: number; readonly inputs: readonly BoundInput[]}> {
  const node = createNode(
    withModuleBindings(module, moduleBindings(module)),
    pineBuiltinSupplier(() => options.timeNow ?? 0),
  );
  const bindings: BindingInput[] = [];
  const values = resolveParamValues(
    module.manifest.params,
    options.params ?? {},
  );
  const parameters = Object.fromEntries(
    module.manifest.params.flatMap((spec, index) =>
      spec.bindable === false ? [] : [[spec.name, values[index]]],
    ),
  );
  if (Object.keys(parameters).length !== 0) {
    node.bind(parameters);
  }
  options.sink.declare(moduleDeclaration(node.module));
  bindings.push(options.stream);
  if (options.requests !== undefined && Object.keys(options.requests).length) {
    bindings.push(options.requests);
  }
  const result = await batchRecipe(node, bindings, {
    next: datum => options.sink.publish(datum),
  }).execute();
  return {...result, inputs: boundInputs(node.module)};
}

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
    const row: Record<string, number | bigint> = {};
    for (const name of names) {
      const raw = input[name];
      if (raw === undefined) {
        throw new Error(`CSV input has no value for '${name}'`);
      }
      if (name === 'time' || name === 'time_close') {
        if (raw === '') throw new Error(`CSV input has no value for '${name}'`);
        row[name] = BigInt(raw);
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
      const time = row.time as bigint;
      const next = parsed[index + 1]?.['time'];
      const previous = parsed[index - 1]?.['time'];
      const span =
        next !== undefined
          ? BigInt(next) - time
          : previous !== undefined
            ? time - BigInt(previous)
            : 0n;
      row.time_close = time + span;
    }
    return Object.freeze(row);
  });
  const shape: Record<string, z.ZodType> = {};
  for (const name of new Set(rows.flatMap(row => Object.keys(row)))) {
    shape[name] =
      name === 'time' || name === 'time_close'
        ? z.bigint()
        : z.union([z.number(), z.nan()]);
  }
  return new DataStream(z.object(shape), from(rows), i, rows.length);
}

export function finiteStream<T extends Readonly<Record<string, unknown>>>(
  schema: z.ZodType<T>,
  values: readonly T[],
): DataStream<T> {
  return new DataStream(schema, from(values), i, values.length);
}

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
    const row: Record<string, number | bigint> = Object.fromEntries(
      Object.entries(series).map(([name, values]) => [name, values[index]!]),
    );
    if (time !== undefined) {
      row.time = BigInt(time[index]!);
      const span =
        index + 1 < time.length
          ? time[index + 1]! - time[index]!
          : index > 0
            ? time[index]! - time[index - 1]!
            : 0;
      row.time_close = BigInt(time[index]! + span);
    }
    return Object.freeze(row);
  });
  const shape: Record<string, z.ZodType> = Object.fromEntries(
    Object.keys(series).map(name => [name, z.union([z.number(), z.nan()])]),
  );
  if (time !== undefined) {
    shape.time = z.bigint();
    shape.time_close = z.bigint();
  }
  return new DataStream(z.object(shape), from(rows), i, indices);
}

function csvHeaders(text: string): readonly string[] {
  const [header = ''] = text.split(/\r?\n/, 1);
  return header
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
}

function derivePrices(row: Record<string, number | bigint>): void {
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
