// Purpose: Execute one compiled Program from a validated execution configuration and host dependencies.

import {executeProgram, type ExecutionSummary} from '../execute';
import type {Program} from '../ir/program';
import type {ExecutionConfig} from './config';
import {createExecutionContext, type ExecutionDependencies} from './context';
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

// The config selects host inputs and a runtime; the Program remains the one
// canonical Core product. Runtime resources are always released here.
export async function runProgram(
  program: Program,
  config: ExecutionConfig,
  dependencies: ExecutionDependencies,
): Promise<RunResult> {
  const context = await createExecutionContext(program, config, dependencies);
  const lease = await acquireBackend(config.runtime);
  try {
    const summary = await executeProgram(
      program,
      context.bindings,
      lease.backend,
    );
    return {
      kind: config.execution.kind,
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
