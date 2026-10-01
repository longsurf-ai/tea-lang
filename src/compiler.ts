// Purpose: Pipeline driver — sole owner of stage order, phase barriers, and the per-compilation Errors instance: loadPackage (parse) → checkPackage (typecheck) → buildProgram (noding) → generate (lowering).

import {log} from './base/log';
import {Errors, type ErrorMsg} from './base/print';
import {generate} from './codegen/codegen';
import {checkGenerated} from './codegen/check';
import type {Program} from './ir/program';
import {checkPackage, type CheckedPackage} from './checker/check';
import {
  loadPackage,
  resolveImports,
  readSourceFile,
  type SourceInput,
} from './loader/loader';
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
  /** Files reached by import resolution, including missing or invalid libraries. */
  readonly dependencies: readonly string[];
  /** Semantic facts, present even when parsing or checking reported errors. */
  readonly checked: CheckedPackage;
  /** Null unless parse, check and noding all finished without an error. */
  readonly program: Program | null;
}

/** Source capture does not change compilation or import resolution. */
export interface CompileOptions {
  readonly includeSources?: boolean;
}

// The sole parse -> check -> node implementation, as two halves so that the
// parse barrier is the only thing the two entries below decide for
// themselves. Target lowerers consume its Program directly; no execution mode
// owns a parallel frontend.
function parseStage(
  inputs: readonly SourceInput[],
  errors: Errors,
  captured?: Map<string, string>,
): File[] {
  const parseDone = perf.startTimer('parse');
  const files = loadPackage(inputs, errors, captured);
  parseDone({files: files.length});
  return files;
}

function checkAndNode(
  files: readonly File[],
  errors: Errors,
  inputs: readonly SourceInput[],
  captured?: Map<string, string>,
): Compilation {
  // Import resolution is a driver stage: the loader loads and orders
  // libraries; the checker consumes them through the Importer and positions
  // any resolution errors at the import statements.
  const checkDone = perf.startTimer('check');
  const supplied = new Map(
    inputs.flatMap(input =>
      typeof input === 'string'
        ? []
        : [
            [input.filename, input.source] as const,
            ...Object.entries(input.imports ?? {}),
          ],
    ),
  );
  const snapshot = inputs.some(
    input => typeof input !== 'string' && input.imports !== undefined,
  );
  const importer = resolveImports(
    files,
    undefined,
    undefined,
    undefined,
    filename => {
      const source =
        supplied.get(filename) ??
        (snapshot ? undefined : readSourceFile(filename));
      if (source !== undefined) captured?.set(filename, source);
      return source;
    },
  );
  const checked = checkPackage(files, errors, importer);
  const dependencies = [
    ...new Set([
      ...files.map(file => file.pos.base.filename),
      ...importer.files,
    ]),
  ];
  checkDone();
  if (errors.count > 0) {
    return {files, checked, dependencies, program: null};
  }
  const nodeDone = perf.startTimer('buildProgram');
  const program = buildProgram(checked, errors);
  nodeDone();
  return {
    files,
    checked,
    dependencies,
    program: errors.count > 0 ? null : program,
  };
}

type ProgramWithSources = {
  readonly program: Program;
  readonly sources: Readonly<Record<string, string>>;
};

/**
 * Compile inputs through the existing parse/check/node pipeline. Errors are
 * recorded in `errors`; a failed stage returns null without running later stages.
 * `includeSources` additionally returns the exact entry/import texts used by
 * this compilation, excluding shipped libraries. Ordinary calls return Program.
 * @example compileToProgram([{filename: 'main.tea', source, imports}], errors);
 * @example compileToProgram(['main.tea'], errors, {includeSources: true});
 */
export function compileToProgram(
  inputs: readonly SourceInput[],
  errors: Errors,
  options: CompileOptions & {readonly includeSources: true},
): ProgramWithSources | null;
export function compileToProgram(
  inputs: readonly SourceInput[],
  errors: Errors,
  options?: CompileOptions & {readonly includeSources?: false},
): Program | null;
export function compileToProgram(
  inputs: readonly SourceInput[],
  errors: Errors,
  options: CompileOptions,
): Program | ProgramWithSources | null;
export function compileToProgram(
  inputs: readonly SourceInput[],
  errors: Errors,
  options: CompileOptions = {},
): Program | ProgramWithSources | null {
  const captured = options.includeSources
    ? new Map<string, string>()
    : undefined;
  const files = parseStage(inputs, errors, captured);
  const program =
    errors.count > 0
      ? null
      : checkAndNode(files, errors, inputs, captured).program;
  return program && captured
    ? {program, sources: Object.fromEntries(captured)}
    : program;
}

/**
 * The tooling entry: the same stages as {@link compileToProgram} without the
 * barrier after parsing, so a file that is broken on one line still yields
 * types, scopes and check errors for its other lines. The checker tolerates
 * the `BadExpr` and `BadStmt` nodes of a recovered parse. Noding keeps its
 * barrier and runs only when parse and check reported nothing.
 *
 * It is for editors and analysis only. Nothing that executes Tea may call it:
 * every backend consumes the `Program` of `compileToProgram`. `SourceInput.imports`
 * has the same contract as there.
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
  return checkAndNode(parseStage(inputs, errors), errors, inputs);
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
