#!/usr/bin/env bun
// Purpose: CLI entry point — Commander argument parsing and process I/O only; all compilation lives in compile.ts. Sole owner of error printing and exit codes.

import {readFileSync, writeFileSync} from 'node:fs';
import {Command} from 'commander';
import {DEFAULT_COMPILE_CONFIG} from './base/config';
import {formatPos, newFileBase} from './base/pos';
import {Errors, type ErrorMsg} from './base/print';
import {UnimplementedError} from './base/unimplemented';
import {compile, compileToAst, compileToIr} from './compile';
import {dumpProgram} from './ir/dumper';
import {csvProvider} from './providers/csv';
import {BindError, type OutputSink, type Value} from './runtime/abi';
import {bind} from './runtime/kernel';
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

const tea = new Command('tea')
  .description('Tea language compiler and runner')
  .version('0.1.0');

tea
  .command('run')
  .description('Compile and execute a Tea script over a CSV dataset')
  .argument('<file>', 'Tea source file')
  .option('-i, --input <file>', 'CSV dataset to bind as the input series')
  .action((file: string, options: {input?: string}) => {
    runStage(() => {
      const result = compile([file], DEFAULT_COMPILE_CONFIG);
      if (!result.ok) {
        exitWithErrors(result.errors);
      }
      if (options.input === undefined) {
        console.error('tea: run requires --input <csv>');
        process.exit(1);
      }
      const module = loadModule(result.js);
      const sink: OutputSink = {
        declare(outputs) {
          outputs.forEach((output, oid) => {
            const statics = output.spec.staticArgs
              .map(a => `${a.name}=${formatValue(a.value)}`)
              .join(' ');
            const bounds = output.boundArgs
              .map(a => `${a.name}=${formatValue(a.value)}`)
              .join(' ');
            console.log(
              `# output[${oid}] ${output.spec.effect}` +
                (statics.length > 0 ? ` ${statics}` : '') +
                (bounds.length > 0 ? ` bound{${bounds}}` : ''),
            );
          });
        },
        emit(row, oid, channels, provisional) {
          console.log(
            `${row} ${oid}${provisional ? ' ?' : ''} ${channels.map(formatValue).join(' ')}`,
          );
        },
      };
      try {
        const bound = bind(module, {
          params: {},
          provider: csvProvider(readFileSync(options.input, 'utf8')),
          sink,
        });
        bound.runAll();
      } catch (error) {
        if (error instanceof BindError) {
          console.error(`tea: ${error.message}`);
          process.exit(1);
        }
        throw error;
      }
    });
  });

function formatValue(v: Value): string {
  if (typeof v === 'number') {
    return Number.isNaN(v) ? 'na' : String(v);
  }
  return String(v);
}

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

tea.parse();
