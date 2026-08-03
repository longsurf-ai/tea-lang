#!/usr/bin/env bun
// Purpose: CLI entry point — Commander argument parsing and process I/O only; all compilation lives in compile.ts.

import {readFileSync, writeFileSync} from 'node:fs';
import {Command} from 'commander';
import {DEFAULT_COMPILE_CONFIG} from './base/config';
import {DiagnosticBag} from './base/diagnostics';
import {formatPos} from './base/pos';
import {TeaUnimplementedError, unimplemented} from './base/unimplemented';
import {
  compile,
  compileToIr,
  compileToSyntax,
  compileToTokens,
} from './compile';
import {dumpSyntaxFile, dumpTokens} from './syntax/dumper';
import {sourceFile, type SourceFile} from './syntax/source';

function loadSource(path: string): SourceFile {
  return sourceFile(path, readFileSync(path, 'utf8'));
}

function reportDiagnostics(diagnostics: DiagnosticBag): void {
  for (const d of diagnostics.all) {
    const where = d.span === null ? '' : `${formatPos(d.span.start)}: `;
    console.error(`${d.severity}: ${where}${d.message}`);
  }
  if (diagnostics.hasErrors) {
    process.exit(1);
  }
}

// Unimplemented stages exit 2 (distinct from exit 1 for Tea source errors);
// everything else is an internal failure and propagates loudly.
function runStage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TeaUnimplementedError) {
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
  .description('Compile and execute a Tea script')
  .argument('<file>', 'Tea source file')
  .option('-i, --input <file>', 'CSV dataset to bind as the input series')
  .action((file: string, options: {input?: string}) => {
    runStage(() => {
      const result = compile(loadSource(file), DEFAULT_COMPILE_CONFIG);
      return unimplemented('runtime: execute', result, options.input);
    });
  });

tea
  .command('build')
  .description('Compile a Tea script and emit JavaScript')
  .argument('<file>', 'Tea source file')
  .option('-o, --out <file>', 'write emitted JavaScript here instead of stdout')
  .action((file: string, options: {out?: string}) => {
    const result = runStage(() =>
      compile(loadSource(file), DEFAULT_COMPILE_CONFIG),
    );
    if (options.out === undefined) {
      console.log(result.emit.js);
    } else {
      writeFileSync(options.out, result.emit.js);
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
      const source = loadSource(file);
      const diagnostics = new DiagnosticBag();
      const wantTokens = options.tokens === true;
      const wantIr = options.ir === true;
      const wantAst = options.ast === true || (!wantTokens && !wantIr);

      runStage(() => {
        if (wantTokens) {
          console.log(dumpTokens(compileToTokens(source, diagnostics)));
        }
        if (wantAst) {
          console.log(dumpSyntaxFile(compileToSyntax(source, diagnostics)));
        }
        if (wantIr) {
          console.log(
            JSON.stringify(compileToIr(source, diagnostics), null, 2),
          );
        }
      });
      reportDiagnostics(diagnostics);
    },
  );

tea.parse();
