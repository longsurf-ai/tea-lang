// Purpose: Validate the narrow JSON boundaries between Tea CLI, extension host, and webview.

import {isAbsolute} from 'node:path';
import type {
  DashboardTrajectoryResult,
  ExecutionSnapshotResult,
  ExecutionSystemResult,
} from '../../../../src/reporting/execution-result';
import type {SweepResult} from '../../../../src/reporting/sweep';
import type {TrajectoryResult} from '../../../../src/reporting/trajectory';
import type {SweepViewSpec} from '../../../../src/visualization/sweep';

export interface MachineExecutionResult {
  readonly schema: 'tea.execution-result/v1';
  readonly config: {
    readonly bytesHash: string;
    readonly programSource: string;
    readonly programBytesHash: string;
    readonly providerBytesHash: string;
    readonly effectiveTimeNow: number;
  };
  readonly system: ExecutionSystemResult;
  readonly sweep?: SweepResult;
  readonly trajectory?: TrajectoryResult;
}

export type DashboardCliResult =
  | MachineExecutionResult
  | DashboardTrajectoryResult;

export type DashboardRequest =
  | {readonly type: 'ready'}
  | {readonly type: 'rerun'}
  | {readonly type: 'chooseConfig'}
  | {
      readonly type: 'project';
      readonly requestId: number;
      readonly spec: SweepViewSpec;
    }
  | {
      readonly type: 'selectScenario';
      readonly requestId: number;
      readonly bindingIndex: number;
    };

export function parseMachineExecutionResult(
  value: unknown,
): MachineExecutionResult {
  if (!isRecord(value) || value.schema !== 'tea.execution-result/v1') {
    throw new Error("Tea CLI did not return schema 'tea.execution-result/v1'");
  }
  executionSnapshot(value.config);
  const system = value.system;
  if (
    !isRecord(system) ||
    (system.kind !== 'run' && system.kind !== 'sweep') ||
    (system.backend !== 'cpu' && system.backend !== 'gpu') ||
    (system.numericProfile !== 'js-f64' &&
      system.numericProfile !== 'wgsl-f32-i32') ||
    !nonNegativeInteger(system.executions) ||
    !nonNegativeInteger(system.rows) ||
    !isRecord(system.timing)
  ) {
    throw new Error('Tea CLI returned an invalid system result');
  }

  if (system.kind === 'sweep') {
    if (!isSweepResult(value.sweep) || value.trajectory !== undefined) {
      throw new Error('Tea CLI returned an invalid sweep result');
    }
  } else if (
    !isTrajectoryResult(value.trajectory) ||
    value.sweep !== undefined
  ) {
    throw new Error('Tea CLI returned an invalid trajectory result');
  }
  return value as unknown as MachineExecutionResult;
}

export function parseDashboardTrajectoryResult(
  value: unknown,
): DashboardTrajectoryResult {
  if (!isRecord(value) || value.schema !== 'tea.dashboard-trajectory/v1') {
    throw new Error(
      "Tea CLI did not return schema 'tea.dashboard-trajectory/v1'",
    );
  }
  executionSnapshot(value.config);
  if (
    !isTrajectoryResult(value.trajectory) ||
    Object.keys(value).sort().join(',') !== 'config,schema,trajectory'
  ) {
    throw new Error('Tea CLI returned an invalid dashboard trajectory');
  }
  return value as unknown as DashboardTrajectoryResult;
}

function executionSnapshot(value: unknown): ExecutionSnapshotResult {
  if (
    !isRecord(value) ||
    !sha256(value.bytesHash) ||
    typeof value.programSource !== 'string' ||
    !isAbsolute(value.programSource) ||
    value.programSource.includes('\0') ||
    !sha256(value.programBytesHash) ||
    !sha256(value.providerBytesHash) ||
    !Number.isSafeInteger(value.effectiveTimeNow)
  ) {
    throw new Error('Tea CLI returned an invalid execution snapshot');
  }
  return value as unknown as ExecutionSnapshotResult;
}

export function parseDashboardRequest(value: unknown): DashboardRequest | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'ready':
    case 'rerun':
    case 'chooseConfig':
      return {type: value.type};
    case 'project': {
      const spec = value.spec;
      if (
        !nonNegativeInteger(value.requestId) ||
        !isRecord(spec) ||
        typeof spec.xParameterId !== 'string' ||
        typeof spec.yParameterId !== 'string' ||
        typeof spec.zMetricId !== 'string' ||
        !isRecord(spec.slices) ||
        !Object.values(spec.slices).every(finiteNumber) ||
        (spec.geometry !== 'auto' &&
          spec.geometry !== 'surface' &&
          spec.geometry !== 'scatter3d')
      ) {
        return null;
      }
      return {
        type: 'project',
        requestId: value.requestId,
        spec: spec as unknown as SweepViewSpec,
      };
    }
    case 'selectScenario':
      return nonNegativeInteger(value.requestId) &&
        nonNegativeInteger(value.bindingIndex)
        ? {
            type: 'selectScenario',
            requestId: value.requestId,
            bindingIndex: value.bindingIndex,
          }
        : null;
    default:
      return null;
  }
}

function isSweepResult(value: unknown): value is SweepResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.axes) ||
    !Array.isArray(value.parameters) ||
    !Array.isArray(value.outputs) ||
    !Array.isArray(value.metrics) ||
    !Array.isArray(value.scenarios)
  ) {
    return false;
  }
  return (
    value.axes.every(
      axis =>
        isRecord(axis) &&
        typeof axis.name === 'string' &&
        Array.isArray(axis.values) &&
        axis.values.every(finiteNumber),
    ) &&
    value.parameters.every(
      parameter =>
        isRecord(parameter) &&
        typeof parameter.id === 'string' &&
        typeof parameter.name === 'string' &&
        typeof parameter.label === 'string',
    ) &&
    value.metrics.every(
      metric =>
        isRecord(metric) &&
        typeof metric.id === 'string' &&
        typeof metric.label === 'string',
    ) &&
    value.scenarios.every(
      scenario =>
        isRecord(scenario) &&
        nonNegativeInteger(scenario.bindingIndex) &&
        isRecord(scenario.parameters) &&
        isRecord(scenario.metrics),
    )
  );
}

function isTrajectoryResult(value: unknown): value is TrajectoryResult {
  if (
    !isRecord(value) ||
    !nonNegativeInteger(value.bindingIndex) ||
    !nonNegativeInteger(value.rows) ||
    !Array.isArray(value.time) ||
    value.time.length !== value.rows ||
    !value.time.every(time => time === null || Number.isSafeInteger(time)) ||
    !Array.isArray(value.parameters) ||
    !Array.isArray(value.outputs) ||
    !Array.isArray(value.effectSchemas) ||
    !Array.isArray(value.effects)
  ) {
    return false;
  }
  return (
    value.parameters.every(
      parameter =>
        isRecord(parameter) &&
        typeof parameter.id === 'string' &&
        typeof parameter.name === 'string' &&
        typeof parameter.label === 'string' &&
        typeof parameter.type === 'string' &&
        typeof parameter.active === 'boolean' &&
        isSweepCell(parameter.value),
    ) &&
    value.outputs.every(
      output =>
        isRecord(output) &&
        typeof output.id === 'string' &&
        typeof output.label === 'string' &&
        Array.isArray(output.values) &&
        output.values.length === (value.rows as number),
    ) &&
    value.effects.every(
      effect =>
        isRecord(effect) &&
        nonNegativeInteger(effect.row) &&
        effect.row < (value.rows as number) &&
        typeof effect.effectId === 'string',
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSweepCell(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    finiteNumber(value)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
