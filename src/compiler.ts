// Purpose: Pipeline driver — sole owner of stage order, phase barriers, and the per-compilation Errors instance: loadPackage (parse) → checkPackage (typecheck) → buildProgram (noding) → generate (lowering).

import {log} from './base/log';
import {Errors, type ErrorMsg} from './base/print';
import {generate} from './codegen/codegen';
import {checkGenerated} from './codegen/check';
import type {Program} from './ir/program';
import {checkPackage, type CheckedPackage} from './checker/check';
import {loadPackage, resolveImports, type SourceInput} from './loader/loader';
import {buildProgram} from './noder/noder';
import type {File} from './syntax/nodes';

// Compilation either emits TypeScript or fails with the flushed, ordered
// error batch — never both, never a partial emit.
export type CompileResult =
  | {readonly ok: true; readonly source: string}
  | {readonly ok: false; readonly errors: readonly ErrorMsg[]};

// Compiler performance events, one per phase (TEA_LOG=debug shows them).
const perf = log.child('compile');

/**
 * One run of the frontend with every stage's result kept: what tooling reads
 * instead of the `Program` alone. The run's errors are in the `Errors` the
 * caller passed.
 */
export interface Compilation {
  /** The parsed entry files; partial where the parser recovered. */
  readonly files: readonly File[];
  /** Semantic facts, present even when parsing or checking reported errors. */
  readonly checked: CheckedPackage;
  /** Null unless parse, check and noding all finished without an error. */
  readonly program: Program | null;
}

// The sole parse -> check -> node implementation, as two halves so that the
// parse barrier is the only thing the two entries below decide for
// themselves. Target lowerers consume its Program directly; no execution mode
// owns a parallel frontend.
function parseStage(inputs: readonly SourceInput[], errors: Errors): File[] {
  const parseDone = perf.startTimer('parse');
  const files = loadPackage(inputs, errors);
  parseDone({files: files.length});
  return files;
}

function checkAndNode(files: readonly File[], errors: Errors): Compilation {
  // Import resolution is a driver stage: the loader loads and orders
  // libraries; the checker consumes them through the Importer and positions
  // any resolution errors at the import statements.
  const checkDone = perf.startTimer('check');
  const importer = resolveImports(files);
  const checked = checkPackage(files, errors, importer);
  checkDone();
  if (errors.count > 0) {
    return {files, checked, program: null};
  }
  const nodeDone = perf.startTimer('buildProgram');
  const program = buildProgram(checked, errors);
  nodeDone();
  return {files, checked, program: errors.count > 0 ? null : program};
}

// The compiling entry: a phase barrier after every stage, so a failed parse
// reports parse errors only.
export function compileToProgram(
  inputs: readonly SourceInput[],
  errors: Errors,
): Program | null {
  const files = parseStage(inputs, errors);
  return errors.count > 0 ? null : checkAndNode(files, errors).program;
}

/**
 * The tooling entry: the same stages as {@link compileToProgram} without the
 * barrier after parsing, so a file that is broken on one line still yields
 * types, scopes and check errors for its other lines. The checker tolerates
 * the `BadExpr` and `BadStmt` nodes of a recovered parse. Noding keeps its
 * barrier and runs only when parse and check reported nothing.
 *
 * It is for editors and analysis only. Nothing that executes Tea may call it:
 * every backend consumes the `Program` of `compileToProgram`.
 *
 * User errors queue in `errors`; an `InternalError` thrown from here is a
 * compiler defect.
 *
 * @example
 * ```ts
 * const errors = new Errors();
 * const {files, checked} = compileForTooling(
 *   [{filename: 'rsi.tea', source: 'x = 1 +\ny = close + "a"\n'}],
 *   errors,
 * );
 * errors.flushErrors(); // the parse error on line 1 and the type error on line 2
 * ```
 */
export function compileForTooling(
  inputs: readonly SourceInput[],
  errors: Errors,
): Compilation {
  return checkAndNode(parseStage(inputs, errors), errors);
}

export function compile(filenames: readonly string[]): CompileResult {
  const errors = new Errors();
  const program = compileToProgram(filenames, errors);
  if (program === null) {
    return {ok: false, errors: errors.flushErrors()};
  }
  const generateDone = perf.startTimer('generate');
  const source = generate(program);
  generateDone({bytes: source.length});
  checkGenerated(source);
  return {ok: true, source};
}
