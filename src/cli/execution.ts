// Purpose: Run one Tea file through the public finite Batch Recipe.

import {from, firstValueFrom, toArray} from 'rxjs';
import {Field, Float64, Int64, Schema} from 'apache-arrow';
import {i} from '../api/clock';
import {createNode} from '../api/node';
import {CSVSource} from '../api/source';
import {DataStream} from '../api/stream';
import {Errors} from '../base/print';
import {generate} from '../codegen/codegen';
import {compileToProgram} from '../compiler';
import {pineBuiltinSupplier} from '../extension/pine';
import {batchRecipe} from '../recipe/batch';
import {loadModule} from '../runtime/load';
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

  const loaded = loadModule(generate(program));
  const parameters = parseRunParameters(
    loaded.parameters,
    dynamicTokens,
    RUN_RESERVED_PARAMETERS,
  );
  const node = createNode(
    loaded.bind(parameters),
    pineBuiltinSupplier(host.now),
  );

  const declaration = node.module.outputs;
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
          for (const line of traceDatum(datum, declaration.schema))
            host.print(line);
        } else {
          publications.push(datum);
        }
      },
    }).execute();
  }

  if (!options.trace) {
    host.print(
      renderRunReport(declaration, publications, node.module.parameters, {
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
  const fields = discovered.schema.fields.map(
    ({name}) =>
      new Field(name, name === 'time' ? new Int64() : new Float64(), false),
  );
  const source = new CSVSource(path, new Schema(fields), i);
  const input = await firstValueFrom(
    source.stream().asObservable().pipe(toArray()),
  );
  const rows = input.map(value => {
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
    return Object.freeze(row);
  });
  for (const name of ['hl2', 'hlc3', 'ohlc4', 'hlcc4']) {
    if (
      !fields.some(field => field.name === name) &&
      rows.some(row => Object.hasOwn(row, name))
    ) {
      fields.push(new Field(name, new Float64(), false));
    }
  }
  return new DataStream(new Schema(fields), from(rows), i);
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
