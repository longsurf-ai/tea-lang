// Purpose: Run one Tea file through the public finite Batch Recipe.

import {from, firstValueFrom, toArray} from 'rxjs';
import * as z from 'zod';
import {i} from '../api/clock';
import {createNode} from '../api/node';
import {CSVSource} from '../api/source';
import {DataStream} from '../api/stream';
import {Errors} from '../base/print';
import {generate} from '../codegen/codegen';
import {paramSpecsOf} from '../codegen/params';
import {compileToProgram} from '../compiler';
import {pineBuiltinSupplier} from '../extension/pine';
import {batchRecipe} from '../recipe/batch';
import {loadModule} from '../runtime/load';
import {
  boundInputs,
  moduleBindings,
  moduleDeclaration,
  withModuleBindings,
} from '../runtime/module-binding';
import type {Datum} from '../runtime/output';
import {renderRunReport, traceDatum, traceDeclaration} from './output';
import {parseRunParameters} from './parameters';
import type {CliResult} from './result';

const RUN_RESERVED_PARAMETERS = new Set([
  'input',
  'i',
  'trace',
  'help',
  'h',
  'version',
  'V',
]);

export type CliExecutionHost = Readonly<{
  now: () => number;
  print(line: string): void;
}>;

/** Compiles and runs one finite CSV-backed Node through `batchRecipe()`. */
export async function runCommand(
  file: string,
  input: string,
  options: {readonly trace: boolean},
  dynamicTokens: readonly string[],
  host: CliExecutionHost,
): Promise<CliResult> {
  let compilationMs = 0;
  let program;
  {
    using _timer = elapsed(value => {
      compilationMs = value;
    });
    const errors = new Errors();
    program = compileToProgram([file], errors);
    if (program === null) {
      return {
        ok: false,
        kind: 'diagnostics',
        errors: errors.flushErrors(),
      };
    }
  }

  const parameters = parseRunParameters(
    paramSpecsOf(program.params),
    dynamicTokens,
    RUN_RESERVED_PARAMETERS,
  );
  const loaded = loadModule(generate(program));
  const node = createNode(
    withModuleBindings(loaded, moduleBindings(loaded)),
    pineBuiltinSupplier(host.now),
  );
  if (Object.keys(parameters).length !== 0) node.bind(parameters);

  const declaration = moduleDeclaration(node.module);
  const publications: Datum[] = [];
  if (options.trace) {
    for (const line of traceDeclaration(declaration)) host.print(line);
  }
  const stream = await csvBatchStream(input);

  let executionMs = 0;
  let result;
  {
    using _timer = elapsed(value => {
      executionMs = value;
    });
    result = await batchRecipe(node, [stream], {
      next: datum => {
        if (options.trace) {
          for (const line of traceDatum(datum)) host.print(line);
        } else {
          publications.push(datum);
        }
      },
    }).execute();
  }

  if (!options.trace) {
    host.print(
      renderRunReport(declaration, publications, boundInputs(node.module), {
        indices: result.indices,
        compilationMs,
        executionMs,
      }),
    );
  }
  return {ok: true};
}

async function csvBatchStream(
  path: string,
): Promise<DataStream<Readonly<Record<string, unknown>>>> {
  const discovered = await CSVSource.open(path);
  const inputShape: Record<string, z.ZodType> = Object.fromEntries(
    Object.keys(discovered.schema.shape).map(name => [
      name,
      name === 'time' || name === 'time_close'
        ? z.coerce.bigint()
        : z.coerce.number(),
    ]),
  );
  const source = new CSVSource(
    path,
    z.strictObject(inputShape),
    i,
    discovered.indices,
  );
  const input = await firstValueFrom(
    source.stream().asObservable().pipe(toArray()),
  );
  const rows = input.map((value, index) => {
    const row = {...value} as Record<string, unknown>;
    derivePrice(row, 'hl2', ['high', 'low'], values => divide(sum(values), 2));
    derivePrice(row, 'hlc3', ['high', 'low', 'close'], values =>
      divide(sum(values), 3),
    );
    derivePrice(row, 'ohlc4', ['open', 'high', 'low', 'close'], values =>
      divide(sum(values), 4),
    );
    derivePrice(row, 'hlcc4', ['high', 'low', 'close'], values =>
      divide(sum(values) + values[2]!, 4),
    );
    if (Object.hasOwn(row, 'time') && !Object.hasOwn(row, 'time_close')) {
      const time = row.time as bigint;
      const next = input[index + 1]?.time;
      const previous = input[index - 1]?.time;
      const span =
        typeof next === 'bigint'
          ? next - time
          : typeof previous === 'bigint'
            ? time - previous
            : 0n;
      row.time_close = time + span;
    }
    return Object.freeze(row);
  });
  const outputShape: Record<string, z.ZodType> = {...inputShape};
  if ('time' in inputShape && !('time_close' in outputShape)) {
    outputShape.time_close = z.bigint();
  }
  for (const name of ['hl2', 'hlc3', 'ohlc4', 'hlcc4']) {
    if (rows.some(row => Object.hasOwn(row, name)))
      outputShape[name] = z.number();
  }
  return new DataStream(
    z.strictObject(outputShape),
    from(rows),
    i,
    rows.length,
  );
}

function derivePrice(
  row: Record<string, unknown>,
  output: string,
  inputs: readonly string[],
  calculate: (values: readonly number[]) => number,
): void {
  if (Object.hasOwn(row, output)) return;
  const values = inputs.map(name => row[name]);
  if (values.every(value => typeof value === 'number')) {
    row[output] = calculate(values as number[]);
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function divide(value: number, divisor: number): number {
  return value / divisor;
}

function elapsed(set: (milliseconds: number) => void): Disposable {
  const started = performance.now();
  return {
    [Symbol.dispose]() {
      set(performance.now() - started);
    },
  };
}
