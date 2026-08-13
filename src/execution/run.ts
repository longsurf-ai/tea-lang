// Purpose: Execute one compiled Program from a validated execution configuration and host dependencies.

import type {ErrorMsg, Errors} from '../base/print';
import {compileToProgram} from '../compile';
import {executeProgram, type ExecutionSummary} from '../execute';
import type {Program} from '../ir/program';
import type {LoadedExecutionConfig, ExecutionConfig} from './config';
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
}

export type LoadedExecutionResult =
  | {readonly ok: true; readonly execution: ConfiguredExecutionResult}
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
      ...(lease.device === undefined ? {} : {device: lease.device}),
    };
  } finally {
    await lease.dispose();
  }
}

// Canonical file-config entry: compile once through compileToProgram(), then
// enter the same configured execution path used by legacy CLI adapters.
export async function executeLoadedConfig(
  loaded: LoadedExecutionConfig,
  errors: Errors,
  dependencies: ConfiguredExecutionDependencies,
): Promise<LoadedExecutionResult> {
  const program = compileToProgram([loaded.config.program.source], errors);
  if (program === null) {
    return {ok: false, errors: errors.flushErrors()};
  }
  return {
    ok: true,
    execution: await executeConfiguredProgram(
      program,
      loaded.config,
      dependencies,
    ),
  };
}
