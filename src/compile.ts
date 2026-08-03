// Purpose: Pipeline driver — sole owner of stage order, phase barriers, and the per-compilation Errors instance: loadPackage (parse) → [typecheck reserved] → buildProgram → generate (lowering).

import type {CompileConfig} from './base/config';
import {Errors, type ErrorMsg} from './base/print';
import {generate} from './codegen/codegen';
import type {Program} from './ir/program';
import {buildProgram, loadPackage} from './noder/noder';
import type {File} from './syntax/nodes';

// Compilation either emits JavaScript or fails with the flushed, ordered
// error batch — never both, never a partial emit.
export type CompileResult =
  | {readonly ok: true; readonly js: string}
  | {readonly ok: false; readonly errors: readonly ErrorMsg[]};

// Partial entry points run the pipeline through the named stage against a
// caller-owned Errors instance; the CLI picks the deepest stage a subcommand
// needs. compile() is the full pipeline and owns its own instance.

export function compileToAst(filename: string, errors: Errors): File {
  return loadPackage([filename], errors)[0];
}

export function compileToIr(filename: string, errors: Errors): Program {
  return buildProgram(loadPackage([filename], errors), errors);
}

export function compile(
  filenames: readonly string[],
  config: CompileConfig,
): CompileResult {
  const errors = new Errors();

  // Phase barriers: later phases never run against a compilation that has
  // already failed.
  const files = loadPackage(filenames, errors);
  if (errors.count > 0) {
    return {ok: false, errors: errors.flushErrors()};
  }
  const program = buildProgram(files, errors);
  if (errors.count > 0) {
    return {ok: false, errors: errors.flushErrors()};
  }
  const js = generate(program, config, errors);
  if (errors.count > 0) {
    return {ok: false, errors: errors.flushErrors()};
  }
  return {ok: true, js};
}
