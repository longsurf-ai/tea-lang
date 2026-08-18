// Purpose: Versioned machine-readable execution envelope shared by CLI and editor hosts.

import type {ExecutionSummary} from '../execute';
import type {RunResult} from '../execution/run';
import type {SweepResult} from './sweep';
import type {TrajectoryResult} from './trajectory';

export const EXECUTION_RESULT_SCHEMA = 'tea.execution-result/v2' as const;

export interface ExecutionSystemResult {
  readonly kind: 'run' | 'sweep';
  readonly backend: 'cpu' | 'gpu';
  readonly numericProfile: ExecutionSummary['numericProfile'];
  readonly device?: string;
  readonly executions: number;
  readonly rows: number;
  readonly timing: ExecutionSummary['timing'];
  readonly gpu?: {
    readonly chunks: number;
    readonly dispatches: number;
    readonly cache: Extract<
      ExecutionSummary,
      {readonly backend: 'gpu'}
    >['cache'];
  };
}

export interface ExecutionSnapshot {
  // Absolute source path resolved from the canonical execution config.
  readonly programSource: string;
  readonly providerHash: string;
  readonly timeNow: number;
}

interface ExecutionMachineResultBase {
  readonly schema: typeof EXECUTION_RESULT_SCHEMA;
  readonly snapshot: ExecutionSnapshot;
  readonly system: ExecutionSystemResult;
}

export interface SweepMachineResult extends ExecutionMachineResultBase {
  readonly sweep: SweepResult;
  // Complete results captured by the same sweep execution. Visualization
  // consumers select locally; Tea does not retain an editor session or rerun
  // a selected binding.
  readonly trajectories: readonly TrajectoryResult[];
}

export interface TrajectoryMachineResult extends ExecutionMachineResultBase {
  readonly trajectory: TrajectoryResult;
}

export type ExecutionMachineResult =
  | SweepMachineResult
  | TrajectoryMachineResult;

export function buildExecutionSystemResult(
  execution: RunResult,
): ExecutionSystemResult {
  const summary = execution.summary;
  return {
    kind: execution.kind,
    backend: summary.backend,
    numericProfile: summary.numericProfile,
    ...(execution.device === undefined ? {} : {device: execution.device}),
    executions: summary.bindings.length,
    rows: summary.bindings.reduce((total, binding) => total + binding.rows, 0),
    timing: {...summary.timing},
    ...(summary.backend === 'gpu'
      ? {
          gpu: {
            chunks: summary.chunks,
            dispatches: summary.dispatches,
            cache: summary.cache,
          },
        }
      : {}),
  };
}
