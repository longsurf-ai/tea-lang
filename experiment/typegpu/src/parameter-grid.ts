// Purpose: Expand explicit inclusive SMA ranges into a deterministic list of valid parameter jobs.

import {ParameterPairsSchema, type ParameterPair} from './contracts';

export interface InclusiveIntegerRange {
  readonly end: number;
  readonly start: number;
  readonly step: number;
}

export interface ParameterGridDefinition {
  readonly fast: InclusiveIntegerRange;
  readonly slow: InclusiveIntegerRange;
}

export const DEFAULT_PARAMETER_GRID: ParameterGridDefinition = {
  fast: {start: 5, end: 100, step: 1},
  slow: {start: 20, end: 300, step: 1},
};

function expandRange(range: InclusiveIntegerRange, label: string): number[] {
  for (const [field, value] of Object.entries(range)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label}.${field} must be a positive safe integer`);
    }
  }
  if (range.start > range.end) {
    throw new Error(`${label}.start must not exceed ${label}.end`);
  }

  const values: number[] = [];
  for (let value = range.start; value <= range.end; value += range.step) {
    values.push(value);
    if (!Number.isSafeInteger(value + range.step)) {
      throw new Error(`${label} expansion exceeds safe integer range`);
    }
  }
  return values;
}

export function createParameterGrid(
  definition: ParameterGridDefinition = DEFAULT_PARAMETER_GRID,
): readonly ParameterPair[] {
  const fastPeriods = expandRange(definition.fast, 'fast');
  const slowPeriods = expandRange(definition.slow, 'slow');
  const pairs: ParameterPair[] = [];

  for (const fastPeriod of fastPeriods) {
    for (const slowPeriod of slowPeriods) {
      if (fastPeriod < slowPeriod) {
        pairs.push({fastPeriod, slowPeriod});
      }
    }
  }

  return ParameterPairsSchema.parse(pairs);
}

export function parseInclusiveIntegerRange(
  input: string,
  label: string,
): InclusiveIntegerRange {
  const parts = input.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`${label} must use start:end[:step] syntax`);
  }
  const [startText, endText, stepText = '1'] = parts;
  const range = {
    start: Number(startText),
    end: Number(endText),
    step: Number(stepText),
  };
  expandRange(range, label);
  return range;
}
