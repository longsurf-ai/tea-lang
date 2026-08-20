// Purpose: Renderer-neutral full-row output trajectories and typed sparse-effect annotations for one execution.

import type {ExecutionBindingSummary} from '../execute';
import type {
  EffectValue,
  EffectValueSchema,
  ExecutionDeclaration,
  Value,
} from '../runtime/abi';
import {
  denseOutputColumns,
  parameterId,
  type SweepCell,
  type SweepOutput,
  type SweepParameterId,
} from './sweep';

export type TrajectoryEffectId = `effect:${number}`;

export interface TrajectoryDenseEmission {
  readonly row: number;
  readonly outputId: number;
  readonly channels: readonly Value[];
}

export interface TrajectoryEffectEmission {
  readonly row: number;
  readonly effectId: number;
  readonly payload: EffectValue;
}

export interface TrajectoryReportSnapshot {
  readonly declaration: ExecutionDeclaration;
  readonly times: readonly (number | null)[];
  readonly denseOutputs: readonly TrajectoryDenseEmission[];
  readonly effects: readonly TrajectoryEffectEmission[];
}

// Column-oriented construction seam for compact archives. The caller owns the
// already row-aligned arrays; this builder validates and projects them without
// creating another copy of every output cell.
export interface TrajectoryColumnSnapshot {
  readonly declaration: ExecutionDeclaration;
  readonly times: readonly (number | null)[];
  readonly values: readonly (readonly SweepCell[])[];
  readonly effects: readonly TrajectoryEffectEmission[];
}

export interface TrajectoryParameter {
  readonly id: SweepParameterId;
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly value: SweepCell;
  readonly active: boolean;
}

export interface TrajectoryOutput extends SweepOutput {
  // Values are row-aligned. Missing emissions and Tea `na` are explicit nulls.
  readonly values: readonly SweepCell[];
}

export interface TrajectoryEffectSchema {
  readonly id: TrajectoryEffectId;
  readonly effectId: number;
  readonly payload: EffectValueSchema;
}

export interface LogicalEffectObject {
  readonly [key: string]: LogicalEffectValue;
}

export type LogicalEffectValue =
  | number
  | string
  | boolean
  | null
  | LogicalEffectObject;

export interface TrajectoryEffect {
  readonly row: number;
  readonly effectId: TrajectoryEffectId;
  readonly payload: LogicalEffectValue;
}

export interface TrajectoryResult {
  // For sweep drill-down this remains the selected sweep binding index even
  // though the isolated rerun itself owns one local binding numbered zero.
  readonly bindingIndex: number;
  readonly rows: number;
  readonly time: readonly (number | null)[];
  readonly parameters: readonly TrajectoryParameter[];
  readonly outputs: readonly TrajectoryOutput[];
  readonly effectSchemas: readonly TrajectoryEffectSchema[];
  readonly effects: readonly TrajectoryEffect[];
}

export function buildTrajectoryResult(
  binding: ExecutionBindingSummary,
  snapshot: TrajectoryReportSnapshot,
  bindingIndex: number = binding.bindingIndex,
): TrajectoryResult {
  const columns = denseOutputColumns(snapshot.declaration.outputs);
  const values = columns.map(() =>
    Array.from<SweepCell>({length: binding.rows}).fill(null),
  );
  const columnByChannel = new Map(
    columns.map((column, index) => [
      `${column.outputId}:${column.channel}`,
      index,
    ]),
  );
  for (const emission of snapshot.denseOutputs) {
    assertRow(emission.row, binding.rows, 'dense emission');
    emission.channels.forEach((value, channel) => {
      const column = columnByChannel.get(`${emission.outputId}:${channel}`);
      if (column === undefined) {
        throw new Error(
          `trajectory received unknown output channel ${emission.outputId}:${channel}`,
        );
      }
      values[column]![emission.row] = normalizeTrajectoryValue(value);
    });
  }

  return buildTrajectoryResultFromColumns(
    binding,
    {
      declaration: snapshot.declaration,
      times: [...snapshot.times],
      values,
      effects: snapshot.effects,
    },
    bindingIndex,
  );
}

export function buildTrajectoryResultFromColumns(
  binding: ExecutionBindingSummary,
  snapshot: TrajectoryColumnSnapshot,
  bindingIndex: number = binding.bindingIndex,
): TrajectoryResult {
  if (!Number.isSafeInteger(bindingIndex) || bindingIndex < 0) {
    throw new Error(`trajectory has invalid binding index ${bindingIndex}`);
  }
  if (snapshot.times.length !== binding.rows) {
    throw new Error(
      `trajectory has ${snapshot.times.length} timestamps for ${binding.rows} rows`,
    );
  }
  snapshot.times.forEach((value, row) => {
    if (value !== null && !Number.isSafeInteger(value)) {
      throw new Error(
        `trajectory timestamp at row ${row} is not a safe integer`,
      );
    }
  });
  const columns = denseOutputColumns(snapshot.declaration.outputs);
  if (snapshot.values.length !== columns.length) {
    throw new Error(
      `trajectory has ${snapshot.values.length} value columns for ${columns.length} declared columns`,
    );
  }
  snapshot.values.forEach((values, column) => {
    if (values.length !== binding.rows) {
      throw new Error(
        `trajectory column ${column} has ${values.length} values for ${binding.rows} rows`,
      );
    }
  });

  const effectSchemas = snapshot.declaration.effects.map(
    (effect, effectId): TrajectoryEffectSchema => ({
      id: trajectoryEffectId(effectId),
      effectId,
      payload: cloneEffectSchema(effect.payload),
    }),
  );
  const effects = snapshot.effects.map((effect): TrajectoryEffect => {
    assertRow(effect.row, binding.rows, 'effect');
    const schema = snapshot.declaration.effects[effect.effectId]?.payload;
    if (schema === undefined) {
      throw new Error(`trajectory received unknown effect ${effect.effectId}`);
    }
    return {
      row: effect.row,
      effectId: trajectoryEffectId(effect.effectId),
      payload: logicalEffectValue(schema, effect.payload),
    };
  });

  return {
    bindingIndex,
    rows: binding.rows,
    time: snapshot.times,
    parameters: binding.inputs.map(input => ({
      id: parameterId(input.spec.name),
      name: input.spec.name,
      label: input.spec.title?.length ? input.spec.title : input.spec.name,
      type: input.spec.type,
      value: normalizeTrajectoryValue(input.value),
      active: input.active,
    })),
    outputs: columns.map((column, index) => ({
      ...column,
      values: snapshot.values[index]!,
    })),
    effectSchemas,
    effects,
  };
}

export function trajectoryEffectId(effectId: number): TrajectoryEffectId {
  return `effect:${effectId}`;
}

function assertRow(row: number, rows: number, what: string): void {
  if (!Number.isSafeInteger(row) || row < 0 || row >= rows) {
    throw new Error(`${what} row ${row} is outside trajectory length ${rows}`);
  }
}

export function normalizeTrajectoryValue(
  value: Value | EffectValue,
): SweepCell {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function logicalEffectValue(
  schema: EffectValueSchema,
  value: EffectValue,
): LogicalEffectValue {
  if (
    value === null ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return null;
  }
  if (schema.kind !== 'struct') {
    if (
      typeof value !== 'number' &&
      typeof value !== 'string' &&
      typeof value !== 'boolean'
    ) {
      throw new Error(`effect payload does not match ${schema.kind} schema`);
    }
    return value;
  }
  if (typeof value !== 'object' || value.kind !== 'struct') {
    throw new Error(`effect payload does not match ${schema.typeId} schema`);
  }
  if (value.fields.length !== schema.fields.length) {
    throw new Error(`effect payload does not match ${schema.typeId} fields`);
  }
  return Object.fromEntries(
    schema.fields.map((field, index) => [
      field.name,
      logicalEffectValue(field.value, value.fields[index]!),
    ]),
  );
}

function cloneEffectSchema(schema: EffectValueSchema): EffectValueSchema {
  switch (schema.kind) {
    case 'enum':
      return {...schema, members: schema.members.map(member => ({...member}))};
    case 'struct':
      return {
        ...schema,
        fields: schema.fields.map(field => ({
          name: field.name,
          value: cloneEffectSchema(field.value),
        })),
      };
    default:
      return {...schema};
  }
}
