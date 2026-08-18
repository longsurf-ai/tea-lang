// Purpose: Refuse a drill-down unless its captured trajectory matches the clicked sweep parameters.

import type {SweepScenario} from '../../../../src/reporting/sweep';
import type {TrajectoryResult} from '../../../../src/reporting/trajectory';

export function assertScenarioTrajectory(
  scenario: SweepScenario,
  trajectory: TrajectoryResult,
): void {
  if (trajectory.bindingIndex !== scenario.bindingIndex) {
    throw new Error(
      `captured trajectory belongs to execution ${trajectory.bindingIndex}, expected ${scenario.bindingIndex}`,
    );
  }

  const expected = Object.entries(scenario.parameters);
  if (trajectory.parameters.length !== expected.length) {
    throw mismatch(scenario.bindingIndex);
  }
  const actual = new Map<string, (typeof trajectory.parameters)[number]>();
  for (const parameter of trajectory.parameters) {
    if (actual.has(parameter.id) || typeof parameter.active !== 'boolean') {
      throw mismatch(scenario.bindingIndex);
    }
    actual.set(parameter.id, parameter);
  }
  for (const [id, value] of expected) {
    const parameter = actual.get(id);
    if (parameter === undefined || !Object.is(parameter.value, value)) {
      throw mismatch(scenario.bindingIndex);
    }
  }
}

function mismatch(bindingIndex: number): Error {
  return new Error(
    `captured trajectory parameters do not match sweep execution ${bindingIndex}`,
  );
}
