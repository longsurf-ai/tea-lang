// Purpose: Validate structured parameter selections and expand bounded executions.

import {OperationalError} from '../base/operational-error';
import type {ParamSpec} from '../runtime/abi';
import {resolveParamValues} from '../runtime/params';
import {
  MAX_EXECUTIONS,
  type ParameterScalar,
  type ParameterSelection,
  type RunExecutionConfig,
  type SweepExecutionConfig,
} from './config';

export const DEFAULT_MAX_EXECUTIONS = MAX_EXECUTIONS;

export class ExecutionParameterError extends OperationalError {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionParameterError';
  }
}

export interface SweepRange {
  readonly name: string;
  readonly values: readonly number[];
}

export interface ParameterGrid {
  readonly ranges: readonly SweepRange[];
  readonly sets: readonly Readonly<Record<string, ParameterScalar>>[];
}

export type ParameterExecutionConfig =
  | {
      readonly kind: 'run';
      readonly parameters: RunExecutionConfig['parameters'];
    }
  | {
      readonly kind: 'sweep';
      readonly parameters: SweepExecutionConfig['parameters'];
      readonly maxExecutions?: SweepExecutionConfig['maxExecutions'];
    };

interface ScalarPlan {
  readonly kind: 'scalar';
  readonly spec: ParamSpec;
  readonly value: ParameterScalar;
}

interface RangePlan {
  readonly kind: 'range';
  readonly spec: ParamSpec & {readonly type: 'int' | 'float'};
  readonly scaledStart: number;
  readonly scaledStop: number;
  readonly scaledStep: number;
  readonly scale: number;
  readonly count: number;
}

type SelectionPlan = ScalarPlan | RangePlan;

interface ParameterExpansionPlan {
  readonly selections: readonly SelectionPlan[];
}

// Stage A validates every selection and computes all cardinalities and the
// Cartesian product. It deliberately allocates no axis or parameter-set arrays.
export function resolveExecutionParameters(
  specs: readonly ParamSpec[],
  execution: ParameterExecutionConfig,
): ParameterGrid {
  const plan = planExecutionParameters(specs, execution);
  return materializeExecutionParameters(plan);
}

function planExecutionParameters(
  specs: readonly ParamSpec[],
  execution: ParameterExecutionConfig,
): ParameterExpansionPlan {
  const parameters = execution.parameters;
  const byName = new Map(specs.map(spec => [spec.name, spec]));
  for (const name of Object.keys(parameters)) {
    if (!byName.has(name)) {
      throw new ExecutionParameterError(`unknown parameter '${name}'`);
    }
  }

  if (
    execution.kind === 'run' &&
    Object.prototype.hasOwnProperty.call(execution, 'maxExecutions')
  ) {
    throw new ExecutionParameterError(
      'run execution does not accept maxExecutions',
    );
  }
  const maxExecutions =
    execution.kind === 'sweep'
      ? (execution.maxExecutions ?? DEFAULT_MAX_EXECUTIONS)
      : 1;
  if (!Number.isSafeInteger(maxExecutions) || maxExecutions < 1) {
    throw new ExecutionParameterError(
      'maxExecutions must be a positive safe integer',
    );
  }
  if (maxExecutions > MAX_EXECUTIONS) {
    throw new ExecutionParameterError(
      `maxExecutions must not exceed ${MAX_EXECUTIONS}`,
    );
  }

  const selections: SelectionPlan[] = [];
  for (const spec of specs) {
    if (!Object.prototype.hasOwnProperty.call(parameters, spec.name)) continue;
    const selection = parameters[spec.name];
    if (isRangeSelection(selection)) {
      if (execution.kind === 'run') {
        throw new ExecutionParameterError(
          `run parameter '${spec.name}' does not accept a range`,
        );
      }
      selections.push(planRange(spec, selection, maxExecutions));
    } else {
      selections.push({
        kind: 'scalar',
        spec,
        value: validateScalar(spec, selection),
      });
    }
  }

  let executionCount = 1;
  for (const selection of selections) {
    if (selection.kind !== 'range') continue;
    if (executionCount > Math.floor(maxExecutions / selection.count)) {
      throw new ExecutionParameterError(
        `parameter sweep exceeds the ${maxExecutions} scenario limit`,
      );
    }
    executionCount *= selection.count;
  }
  return {selections};
}

function planRange(
  spec: ParamSpec,
  selection: Extract<ParameterSelection, {readonly range: unknown}>,
  maxExecutions: number,
): RangePlan {
  if (!isNumericSpec(spec)) {
    throw new ExecutionParameterError(
      `parameter '${spec.name}' does not support numeric ranges`,
    );
  }
  const {start, stop, step} = selection.range;
  validateScalar(spec, start);
  validateScalar(spec, stop);
  validateScalar({...spec, constraints: null}, step);
  if (step === 0) {
    throw new ExecutionParameterError(
      `parameter '${spec.name}' range step must not be zero`,
    );
  }
  if ((stop > start && step < 0) || (stop < start && step > 0)) {
    throw new ExecutionParameterError(
      `parameter '${spec.name}' range step points away from its stop`,
    );
  }

  const precision = Math.max(
    decimalPlaces(String(start)),
    decimalPlaces(String(stop)),
    decimalPlaces(String(step)),
  );
  if (precision > 12) {
    throw new ExecutionParameterError(
      `parameter '${spec.name}' range has more than 12 decimal places`,
    );
  }
  const scale = 10 ** precision;
  const scaledStart = Math.round(start * scale);
  const scaledStop = Math.round(stop * scale);
  const scaledStep = Math.round(step * scale);
  if (
    !Number.isSafeInteger(scaledStart) ||
    !Number.isSafeInteger(scaledStop) ||
    !Number.isSafeInteger(scaledStep)
  ) {
    throw new ExecutionParameterError(
      `parameter '${spec.name}' range exceeds safe numeric precision`,
    );
  }

  const distance =
    BigInt(scaledStop) >= BigInt(scaledStart)
      ? BigInt(scaledStop) - BigInt(scaledStart)
      : BigInt(scaledStart) - BigInt(scaledStop);
  const count = distance / BigInt(Math.abs(scaledStep)) + 1n;
  if (count > BigInt(maxExecutions)) {
    throw new ExecutionParameterError(
      `parameter '${spec.name}' range has ${count.toString()} values, exceeding the ${maxExecutions} scenario limit`,
    );
  }
  return {
    kind: 'range',
    spec,
    scaledStart,
    scaledStop,
    scaledStep,
    scale,
    count: Number(count),
  };
}

// Stage B runs only after Stage A has proved the full expansion is bounded.
function materializeExecutionParameters(
  plan: ParameterExpansionPlan,
): ParameterGrid {
  const ranges: SweepRange[] = [];
  let sets: Readonly<Record<string, ParameterScalar>>[] = [{}];
  for (const selection of plan.selections) {
    let values: readonly ParameterScalar[];
    if (selection.kind === 'range') {
      const rangeValues = materializeRange(selection);
      ranges.push({
        name: selection.spec.name,
        values: rangeValues,
      });
      values = rangeValues;
    } else {
      values = [selection.value];
    }
    sets = sets.flatMap(parameterSet =>
      values.map(value => ({
        ...parameterSet,
        [selection.spec.name]: value,
      })),
    );
  }
  return {ranges, sets};
}

function materializeRange(plan: RangePlan): readonly number[] {
  const values: number[] = [];
  for (
    let current = plan.scaledStart;
    plan.scaledStep > 0
      ? current <= plan.scaledStop
      : current >= plan.scaledStop;
    current += plan.scaledStep
  ) {
    const value = current / plan.scale;
    validateScalar(plan.spec, value);
    values.push(value);
  }
  return values;
}

function validateScalar(
  spec: ParamSpec,
  selection: ParameterSelection,
): ParameterScalar {
  if (
    typeof selection !== 'number' &&
    typeof selection !== 'string' &&
    typeof selection !== 'boolean'
  ) {
    throw new ExecutionParameterError(
      `parameter '${spec.name}' selection must be a scalar or range`,
    );
  }
  if (typeof selection === 'number' && !Number.isFinite(selection)) {
    throw new ExecutionParameterError(
      `parameter '${spec.name}' expects a finite number`,
    );
  }
  try {
    const value = resolveParamValues([spec], {[spec.name]: selection})[0];
    if (
      typeof value !== 'number' &&
      typeof value !== 'string' &&
      typeof value !== 'boolean'
    ) {
      throw new ExecutionParameterError(
        `parameter '${spec.name}' cannot be selected for execution`,
      );
    }
    return value;
  } catch (error) {
    if (error instanceof ExecutionParameterError) throw error;
    if (error instanceof Error) {
      throw new ExecutionParameterError(error.message);
    }
    throw error;
  }
}

function isNumericSpec(
  spec: ParamSpec,
): spec is ParamSpec & {readonly type: 'int' | 'float'} {
  return spec.type === 'int' || spec.type === 'float';
}

function isRangeSelection(
  selection: ParameterSelection,
): selection is Extract<ParameterSelection, {readonly range: unknown}> {
  if (
    typeof selection !== 'object' ||
    selection === null ||
    Array.isArray(selection)
  ) {
    return false;
  }
  if (
    Object.keys(selection).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(selection, 'range')
  ) {
    return false;
  }
  const range = (selection as {readonly range?: unknown}).range;
  return (
    typeof range === 'object' &&
    range !== null &&
    !Array.isArray(range) &&
    Object.keys(range).length === 3 &&
    Object.prototype.hasOwnProperty.call(range, 'start') &&
    Object.prototype.hasOwnProperty.call(range, 'stop') &&
    Object.prototype.hasOwnProperty.call(range, 'step')
  );
}

function decimalPlaces(raw: string): number {
  const match = /^[+-]?(?:\d+(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(raw);
  if (match === null) return 0;
  const fraction = match[1] ?? match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  return Math.max(0, fraction.length - exponent);
}
