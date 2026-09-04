// Purpose: CLI-only parse, inspection, and JavaScript artifact commands.

import {readFileSync, writeFileSync} from 'node:fs';
import {newFileBase} from '../base/pos';
import {Errors} from '../base/print';
import {compile, compileToProgram} from '../compiler';
import {dumpProgram} from '../ir/dumper';
import {loadPackage} from '../loader/loader';
import {dumpFile, dumpTokens} from '../syntax/dumper';
import {tokenize} from '../syntax/syntax';
import type {CliResult} from './result';

export function buildCommand(file: string, out?: string): CliResult {
  const result = compile([file]);
  if (!result.ok) {
    return {ok: false, kind: 'diagnostics', errors: result.errors};
  }
  if (out === undefined) {
    console.log(result.js);
  } else {
    writeFileSync(out, result.js);
  }
  return {ok: true};
}

export function parseCommand(
  file: string,
  options: {
    readonly tokens: boolean;
    readonly ast: boolean;
    readonly ir: boolean;
  },
): CliResult {
  const errors = new Errors();
  const wantAst = options.ast || (!options.tokens && !options.ir);

  if (options.tokens) {
    const source = readFileSync(file, 'utf8');
    const tokens = tokenize(newFileBase(file), source, (pos, message) =>
      errors.errorAt(pos, message),
    );
    console.log(dumpTokens(tokens));
  }
  if (wantAst) console.log(dumpFile(loadPackage([file], errors)[0]));
  if (options.ir) {
    const program = compileToProgram([file], errors);
    if (program !== null) console.log(dumpProgram(program));
  }
  return errors.count === 0
    ? {ok: true}
    : {ok: false, kind: 'diagnostics', errors: errors.flushErrors()};
}
