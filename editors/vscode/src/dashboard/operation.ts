// Purpose: Decide whether an asynchronous dashboard continuation still owns publication.

export type DashboardPhase = 'idle' | 'sweep' | 'trajectory';

export interface DashboardOperationState<T = unknown> {
  readonly disposed: boolean;
  readonly runId: number;
  readonly scenarioRequestId: number;
  readonly phase: DashboardPhase;
  readonly execution: T | null;
}

export function settleDashboardOperation<T>(
  state: DashboardOperationState<T>,
  expectedExecution: T,
  expectedRunId: number,
  expectedScenarioRequestId?: number,
): DashboardOperationState<T> | null {
  if (
    !isCurrentDashboardOperation(
      state,
      expectedExecution,
      expectedRunId,
      expectedScenarioRequestId,
    )
  ) {
    return null;
  }
  return {...state, phase: 'idle', execution: null};
}

export function isSameDashboardGeneration(
  state: Pick<
    DashboardOperationState,
    'disposed' | 'runId' | 'scenarioRequestId'
  >,
  expectedRunId: number,
  expectedScenarioRequestId: number,
): boolean {
  return (
    !state.disposed &&
    state.runId === expectedRunId &&
    state.scenarioRequestId === expectedScenarioRequestId
  );
}

export function isCurrentDashboardOperation(
  state: DashboardOperationState,
  expectedExecution: unknown,
  expectedRunId: number,
  expectedScenarioRequestId?: number,
): boolean {
  return (
    !state.disposed &&
    expectedRunId === state.runId &&
    expectedExecution === state.execution &&
    state.phase ===
      (expectedScenarioRequestId === undefined ? 'sweep' : 'trajectory') &&
    (expectedScenarioRequestId === undefined
      ? state.scenarioRequestId < 0
      : expectedScenarioRequestId === state.scenarioRequestId)
  );
}
