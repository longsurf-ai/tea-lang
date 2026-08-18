// Purpose: Execute one compiled Program from a validated execution configuration and host dependencies.

import type {ErrorMsg, Errors} from '../base/print';
import {compileToProgram, hashProgramSourceClosure} from '../compile';
import {executeProgram, type ExecutionSummary} from '../execute';
import type {Program} from '../ir/program';
import {
  ExecutionConfigError,
  type LoadedExecutionConfig,
  type ExecutionConfig,
} from './config';
import {
  resolveExecutionContext,
  type ExecutionContextDependencies,
} from './context';
import {
  acquireExecutionTarget,
  type ExecutionTargetDependencies,
} from './target';
import type {ResolvedParameterAxis} from './parameters';

export interface ConfiguredExecutionDependencies extends ExecutionContextDependencies {
  readonly target?: ExecutionTargetDependencies;
}

export interface ConfiguredExecutionResult {
  readonly kind: 'run' | 'sweep';
  readonly axes: readonly ResolvedParameterAxis[];
  readonly summary: ExecutionSummary;
  readonly device?: string;
  readonly timeNow: number;
  readonly providerBytesHash?: string;
}

export interface LoadedExecutionSuccess {
  readonly ok: true;
  readonly execution: ConfiguredExecutionResult;
  // Hash of the root source plus every compiler-shipped Tea library source.
  readonly programBytesHash: string;
}

export type LoadedExecutionResult =
  | LoadedExecutionSuccess
  | {readonly ok: false; readonly errors: readonly ErrorMsg[]};

// The config selects host inputs and a runtime; the Program remains the one
// canonical Core product. Runtime resources are always released here.
export async function executeConfiguredProgram(
  program: Program,
  config: ExecutionConfig,
  dependencies: ConfiguredExecutionDependencies,
): Promise<ConfiguredExecutionResult> {
  const context = await resolveExecutionContext(program, config, dependencies);
  const lease = await acquireExecutionTarget(
    context.runtime,
    dependencies.target,
  );
  try {
    const summary = await executeProgram(
      program,
      context.bindings,
      lease.target,
    );
    return {
      kind: context.kind,
      axes: context.axes,
      summary,
      timeNow: context.timeNow,
      ...(context.providerBytesHash === undefined
        ? {}
        : {providerBytesHash: context.providerBytesHash}),
      ...(lease.device === undefined ? {} : {device: lease.device}),
    };
  } finally {
    await lease.dispose();
  }
}

// Canonical file-config entry: compile once through compileToProgram(), then
// enter the same configured execution path used by direct run/sweep commands.
export async function executeLoadedConfig(
  loaded: LoadedExecutionConfig,
  errors: Errors,
  dependencies: ConfiguredExecutionDependencies,
): Promise<LoadedExecutionResult> {
  const programBytesHash = hashProgramSnapshot(loaded.config.program.source);
  const program = compileToProgram([loaded.config.program.source], errors);
  verifyProgramSnapshot(loaded.config.program.source, programBytesHash);
  if (program === null) {
    return {ok: false, errors: errors.flushErrors()};
  }
  return {
    ok: true,
    programBytesHash,
    execution: await executeConfiguredProgram(
      program,
      loaded.config,
      dependencies,
    ),
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
