#!/usr/bin/env bun
// Purpose: CLI entry point — Commander argument parsing and process I/O only; all compilation lives in compile.ts. Sole owner of error printing and exit codes; run presentation is delegated to providers sinks.

import {readFileSync, writeFileSync} from 'node:fs';
import {Command} from 'commander';
import {DEFAULT_COMPILE_CONFIG} from './base/config';
import {formatPos, newFileBase} from './base/pos';
import {Errors, type ErrorMsg} from './base/print';
import {UnimplementedError} from './base/unimplemented';
import {compile, compileToAst, compileToIr} from './compile';
import {dumpProgram} from './ir/dumper';
import {csvProvider} from './providers/data/csv';
import {fredProvider} from './providers/data/fred';
import {registryProvider} from './providers/data/registry';
import {stooqProvider} from './providers/data/stooq';
import {yahooProvider} from './providers/data/yahoo';
import {TableSink} from './providers/sinks/table-sink';
import {TraceSink} from './providers/sinks/trace-sink';
import {BindError, type DataProvider} from './runtime/abi';
import {bind} from './runtime/js-runtime';
import {loadModule} from './runtime/load';
import {dumpFile, dumpTokens} from './syntax/dumper';
import {tokenize} from './syntax/syntax';

// Exit 1: the Tea source had errors. The batch arrives sorted and deduped
// from flushErrors(); this is the only place errors are printed.
function exitWithErrors(errors: readonly ErrorMsg[]): never {
  for (const e of errors) {
    console.error(`${formatPos(e.pos)}: ${e.msg}`);
  }
  process.exit(1);
}

// Exit 2: an unimplemented stage was reached (distinct from exit 1 for Tea
// source errors); everything else is an internal failure and propagates
// loudly with a stack.
function runStage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof UnimplementedError) {
      console.error(`tea: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

// The async variant for verbs that bind: context resolution awaits.
async function runStageAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnimplementedError) {
      console.error(`tea: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

// The CLI's source registry (host configuration, docs/requests.md): the
// empty symbol is the csv file (the primary context the user handed us);
// any other unprefixed symbol defaults to yahoo, and prefixes route to
// their drivers. API keys arrive via environment, never Tea source.
function cliProvider(csvText: string): DataProvider {
  const fredKey = process.env['FRED_API_KEY'] ?? '';
  const fred: DataProvider =
    fredKey === ''
      ? {
          resolveContext: () =>
            Promise.resolve({
              error: 'unknownSource' as const,
              detail: 'set FRED_API_KEY to use FRED: symbols',
            }),
        }
      : fredProvider({apiKey: fredKey});
  const csv = csvProvider(csvText);
  const yahoo = yahooProvider();
  return registryProvider({
    defaultSource: {
      resolveContext: (symbol, timeframe, range) =>
        symbol === ''
          ? csv.resolveContext(symbol, timeframe, range)
          : yahoo.resolveContext(symbol, timeframe, range),
    },
    sources: {
      YAHOO: yahoo,
      STOOQ: stooqProvider(),
      FRED: fred,
    },
  });
}

const tea = new Command('tea')
  .description('Tea language compiler and runner')
  .version('0.1.0');

tea
  .command('run')
  .description('Compile and execute a Tea script over a CSV dataset')
  .argument('<file>', 'Tea source file')
  .option('-i, --input <file>', 'CSV dataset to bind as the input series')
  .option(
    '--trace',
    'print the machine trace format (golden-compatible) instead of a table',
  )
  .action(async (file: string, options: {input?: string; trace?: boolean}) => {
    await runStageAsync(async () => {
      const result = compile([file], DEFAULT_COMPILE_CONFIG);
      if (!result.ok) {
        exitWithErrors(result.errors);
      }
      if (options.input === undefined) {
        console.error('tea: run requires --input <csv>');
        process.exit(1);
      }
      const module = loadModule(result.js);
      const table =
        options.trace === true
          ? null
          : new TableSink(text => console.log(text));
      const sink = table ?? new TraceSink(line => console.log(line));
      try {
        const exec = await bind(module, {
          params: {},
          provider: cliProvider(readFileSync(options.input, 'utf8')),
          sink,
        });
        exec.runAll();
        table?.flush();
      } catch (error) {
        if (error instanceof BindError) {
          console.error(`tea: ${error.message}`);
          process.exit(1);
        }
        throw error;
      }
    });
  });

tea
  .command('build')
  .description('Compile a Tea script and emit JavaScript')
  .argument('<file>', 'Tea source file')
  .option('-o, --out <file>', 'write emitted JavaScript here instead of stdout')
  .action((file: string, options: {out?: string}) => {
    const result = runStage(() => compile([file], DEFAULT_COMPILE_CONFIG));
    if (!result.ok) {
      exitWithErrors(result.errors);
    }
    if (options.out === undefined) {
      console.log(result.js);
    } else {
      writeFileSync(options.out, result.js);
    }
  });

tea
  .command('parse')
  .description('Run the frontend and dump intermediate artifacts')
  .argument('<file>', 'Tea source file')
  .option('--tokens', 'dump the token stream')
  .option('--ast', 'dump the syntax tree (default)')
  .option('--ir', 'dump the lowered IR')
  .action(
    (
      file: string,
      options: {tokens?: boolean; ast?: boolean; ir?: boolean},
    ) => {
      const errors = new Errors();
      const wantTokens = options.tokens === true;
      const wantIr = options.ir === true;
      const wantAst = options.ast === true || (!wantTokens && !wantIr);

      runStage(() => {
        if (wantTokens) {
          const src = readFileSync(file, 'utf8');
          const tokens = tokenize(newFileBase(file), src, (pos, msg) =>
            errors.errorAt(pos, msg),
          );
          console.log(dumpTokens(tokens));
        }
        if (wantAst) {
          console.log(dumpFile(compileToAst(file, errors)));
        }
        if (wantIr) {
          const program = compileToIr(file, errors);
          if (program !== null) {
            console.log(dumpProgram(program));
          }
        }
      });
      if (errors.count > 0) {
        exitWithErrors(errors.flushErrors());
      }
    },
  );

await tea.parseAsync();
