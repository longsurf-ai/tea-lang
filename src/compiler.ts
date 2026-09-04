// Purpose: Pipeline driver — sole owner of stage order, phase barriers, and the per-compilation Errors instance: loadPackage (parse) → checkPackage (typecheck) → buildProgram (noding) → generate (lowering).

import {log} from './base/log';
import {Errors, type ErrorMsg} from './base/print';
import {generate} from './codegen/codegen';
import type {Program} from './ir/program';
import {checkPackage} from './checker/check';
import {loadPackage, resolveImports, type SourceInput} from './loader/loader';
import {buildProgram} from './noder/noder';

// Compilation either emits JavaScript or fails with the flushed, ordered
// error batch — never both, never a partial emit.
export type CompileResult =
  | {readonly ok: true; readonly js: string}
  | {readonly ok: false; readonly errors: readonly ErrorMsg[]};

// Compiler performance events, one per phase (TEA_LOG=debug shows them).
const perf = log.child('compile');

// The sole parse -> check -> node implementation. Target lowerers consume its
// Program directly; no execution mode owns a parallel frontend.
export function compileToProgram(
  inputs: readonly SourceInput[],
  errors: Errors,
): Program | null {
  const parseDone = perf.startTimer('parse');
  const files = loadPackage(inputs, errors);
  parseDone({files: files.length});
  if (errors.count > 0) {
    return null;
  }
  // Import resolution is a driver stage: the loader loads and orders
  // libraries; the checker consumes them through the Importer and positions
  // any resolution errors at the import statements.
  const checkDone = perf.startTimer('check');
  const importer = resolveImports(files);
  const checked = checkPackage(files, errors, importer);
  checkDone();
  if (errors.count > 0) {
    return null;
  }
  const nodeDone = perf.startTimer('buildProgram');
  const program = buildProgram(checked, errors);
  nodeDone();
  return errors.count > 0 ? null : program;
}

export function compile(filenames: readonly string[]): CompileResult {
  const errors = new Errors();
  const program = compileToProgram(filenames, errors);
  if (program === null) {
    return {ok: false, errors: errors.flushErrors()};
  }
  const generateDone = perf.startTimer('generate');
  const js = generate(program);
  generateDone({bytes: js.length});
  return {ok: true, js};
}
