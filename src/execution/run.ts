// Purpose: Execute one compiled Program from a validated execution configuration and host dependencies.

import type {ErrorMsg, Errors} from '../base/print';
import {compileToProgram, hashProgramSourceClosure} from '../compile';
import {executeProgram, type ExecutionSummary} from '../execute';
import type {Program} from '../ir/program';
import {ExecutionConfigError, type ExecutionConfig} from './config';
import {resolveExecutionContext, type ExecutionDependencies} from './context';
import {acquireBackend} from './backend';
import type {SweepRange} from './parameters';

export interface RunResult {
  readonly kind: 'run' | 'sweep';
  readonly ranges: readonly SweepRange[];
  readonly summary: ExecutionSummary;
  readonly device?: string;
  readonly timeNow: number;
  readonly providerHash?: string;
}

export interface ConfigRunSuccess {
  readonly ok: true;
  readonly run: RunResult;
  // Hash of the root source plus every compiler-shipped Tea library source.
  readonly programHash: string;
}

export type ConfigRunResult =
  | ConfigRunSuccess
  | {readonly ok: false; readonly errors: readonly ErrorMsg[]};

// The config selects host inputs and a runtime; the Program remains the one
// canonical Core product. Runtime resources are always released here.
export async function runProgram(
  program: Program,
  config: ExecutionConfig,
  dependencies: ExecutionDependencies,
): Promise<RunResult> {
  const context = await resolveExecutionContext(program, config, dependencies);
  const lease = await acquireBackend(context.runtime);
  try {
    const summary = await executeProgram(
      program,
      context.bindings,
      lease.backend,
    );
    return {
      kind: context.kind,
      ranges: context.ranges,
      summary,
      timeNow: context.timeNow,
      ...(context.providerHash === undefined
        ? {}
        : {providerHash: context.providerHash}),
      ...(lease.device === undefined ? {} : {device: lease.device}),
    };
  } finally {
    await lease.dispose();
  }
}

// Compile the config's source once, then enter the same Program execution path
// used by direct run/sweep commands.
export async function runConfig(
  config: ExecutionConfig,
  errors: Errors,
  dependencies: ExecutionDependencies,
): Promise<ConfigRunResult> {
  const programHash = hashProgramSnapshot(config.program.source);
  const program = compileToProgram([config.program.source], errors);
  verifyProgramSnapshot(config.program.source, programHash);
  if (program === null) {
    return {ok: false, errors: errors.flushErrors()};
  }
  return {
    ok: true,
    programHash,
    run: await runProgram(program, config, dependencies),
  };
}

function hashProgramSnapshot(path: string): string {
  try {
    return hashProgramSourceClosure([path]);
  } catch (error) {
    throw new ExecutionConfigError(
      `cannot read program source closure rooted at '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function verifyProgramSnapshot(path: string, expected: string): void {
  const actual = hashProgramSnapshot(path);
  if (actual !== expected) {
    throw new ExecutionConfigError(
      `program source closure changed during compilation: SHA-256 ${actual}, expected ${expected}`,
    );
  }
}
