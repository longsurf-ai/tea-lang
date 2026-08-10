// Purpose: Pipeline driver — sole owner of stage order, phase barriers, and the per-compilation Errors instance: loadPackage (parse) → checkPackage (typecheck) → buildProgram (noding) → generate (lowering).

import type {CompileConfig} from './base/config';
import {log} from './base/log';
import {Errors, type ErrorMsg} from './base/print';
import {generate} from './codegen/codegen';
import type {Program} from './ir/program';
import {checkPackage} from './checker/check';
import {loadPackage, resolveImports} from './loader/loader';
import {buildProgram} from './noder/noder';
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

// Null when an earlier phase failed: the IR exists only for error-free
// compilations, so there is no Program to return — the caller reports the
// queued errors.
export function compileToIr(filename: string, errors: Errors): Program | null {
  const files = loadPackage([filename], errors);
  if (errors.count > 0) {
    return null;
  }
  // Import resolution is a driver stage: the loader loads and orders
  // libraries; the checker consumes them through the Importer and positions
  // any resolution errors at the import statements.
  const importer = resolveImports(files);
  const checked = checkPackage(files, errors, importer);
  if (errors.count > 0) {
    return null;
  }
  const program = buildProgram(checked, errors);
  return errors.count > 0 ? null : program;
}

// Compiler performance events, one per phase (TEA_LOG=debug shows them).
const perf = log.child('compile');

export function compile(
  filenames: readonly string[],
  config: CompileConfig,
): CompileResult {
  const errors = new Errors();

  // Phase barriers: later phases never run against a compilation that has
  // already failed.
  const parseDone = perf.startTimer('parse');
  const files = loadPackage(filenames, errors);
  parseDone({files: files.length});
  if (errors.count > 0) {
    return {ok: false, errors: errors.flushErrors()};
  }
  const checkDone = perf.startTimer('check');
  const importer = resolveImports(files);
  const checked = checkPackage(files, errors, importer);
  checkDone();
  if (errors.count > 0) {
    return {ok: false, errors: errors.flushErrors()};
  }
  const nodeDone = perf.startTimer('buildProgram');
  const program = buildProgram(checked, errors);
  nodeDone();
  if (errors.count > 0) {
    return {ok: false, errors: errors.flushErrors()};
  }
  const generateDone = perf.startTimer('generate');
  const js = generate(program, config, errors);
  generateDone({bytes: js.length});
  if (errors.count > 0) {
    return {ok: false, errors: errors.flushErrors()};
  }
  return {ok: true, js};
}
