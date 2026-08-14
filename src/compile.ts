// Purpose: Pipeline driver — sole owner of stage order, phase barriers, and the per-compilation Errors instance: loadPackage (parse) → checkPackage (typecheck) → buildProgram (noding) → generate (lowering).

import {createHash, type Hash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {log} from './base/log';
import {Errors, type ErrorMsg} from './base/print';
import {generate} from './codegen/codegen';
import type {Program} from './ir/program';
import {checkPackage} from './checker/check';
import {
  compilerSourceClosureFiles,
  loadPackage,
  resolveImports,
} from './loader/loader';
import {buildProgram} from './noder/noder';
import type {File} from './syntax/nodes';

// Compilation either emits JavaScript or fails with the flushed, ordered
// error batch — never both, never a partial emit.
export type CompileResult =
  | {readonly ok: true; readonly js: string}
  | {readonly ok: false; readonly errors: readonly ErrorMsg[]};

// Syntax inspection stops after parsing and preserves the parser's recovered
// File even when it queued errors. Full compilation enters through
// compileToProgram below.
export function parseFile(filename: string, errors: Errors): File {
  return loadPackage([filename], errors)[0];
}

// Compiler performance events, one per phase (TEA_LOG=debug shows them).
const perf = log.child('compile');

// Hash the exact, canonical source closure that can affect the Program:
// ordered entry-file bytes plus the conservative full set of compiler-shipped
// Tea library bytes. Length framing makes the multi-file byte stream
// unambiguous, while stable logical ids keep host file paths out of identity.
export function hashProgramSourceClosure(filenames: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of compilerSourceClosureFiles(filenames)) {
    updateFramed(hash, Buffer.from(file.id, 'utf8'));
    updateFramed(hash, readFileSync(file.filename));
  }
  return hash.digest('hex');
}

function updateFramed(hash: Hash, bytes: Uint8Array): void {
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

// The sole parse -> check -> node implementation. Target lowerers consume its
// Program directly; no execution mode owns a parallel frontend.
export function compileToProgram(
  filenames: readonly string[],
  errors: Errors,
): Program | null {
  const parseDone = perf.startTimer('parse');
  const files = loadPackage(filenames, errors);
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
