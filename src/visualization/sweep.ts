// Purpose: Pure projection from renderer-neutral sweep results to 3D sweep scenes.

import type {
  SweepMetricId,
  SweepParameter,
  SweepParameterId,
  SweepResult,
} from '../reporting/sweep';

export type SweepGeometry = 'auto' | 'surface' | 'scatter3d';

export interface SweepViewSpec {
  readonly xParameterId: SweepParameterId;
  readonly yParameterId: SweepParameterId;
  readonly zMetricId: SweepMetricId;
  readonly slices: Readonly<Partial<Record<SweepParameterId, number>>>;
  readonly geometry: SweepGeometry;
}

export interface SweepSceneAxis {
  readonly id: SweepParameterId;
  readonly label: string;
  readonly values: readonly number[];
}

export interface SweepSceneMetric {
  readonly id: SweepMetricId;
  readonly label: string;
}

interface SweepSceneBase {
  readonly scenarioCount: number;
  readonly x: SweepSceneAxis;
  readonly y: SweepSceneAxis;
  readonly slices: Readonly<Partial<Record<SweepParameterId, number>>>;
}

export interface SurfaceSweepScene extends SweepSceneBase {
  readonly geometry: 'surface';
  readonly z: SweepSceneMetric & {
    readonly values: readonly (readonly (number | null)[])[];
  };
}

export interface Scatter3dPoint {
  readonly bindingIndex: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Scatter3dSweepScene extends SweepSceneBase {
  readonly geometry: 'scatter3d';
  readonly z: SweepSceneMetric;
  readonly points: readonly Scatter3dPoint[];
}

export type SweepScene = SurfaceSweepScene | Scatter3dSweepScene;

export class SweepProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SweepProjectionError';
  }
}

export function projectSweepScene(
  result: SweepResult,
  spec: SweepViewSpec,
): SweepScene {
  if (
    spec.geometry !== 'auto' &&
    spec.geometry !== 'surface' &&
    spec.geometry !== 'scatter3d'
  ) {
    throw new SweepProjectionError(
      `unknown sweep geometry '${String(spec.geometry)}'`,
    );
  }
  if (
    spec.slices === null ||
    typeof spec.slices !== 'object' ||
    Array.isArray(spec.slices)
  ) {
    throw new SweepProjectionError('sweep slices must be an object');
  }
  if (spec.xParameterId === spec.yParameterId) {
    throw new SweepProjectionError('sweep view X and Y parameters must differ');
  }
  const x = projectedAxis(result, spec.xParameterId, 'X');
  const y = projectedAxis(result, spec.yParameterId, 'Y');
  const metric = result.metrics.find(
    candidate => candidate.id === spec.zMetricId,
  );
  if (metric === undefined) {
    throw new SweepProjectionError(`unknown sweep metric '${spec.zMetricId}'`);
  }
  const metricOutput = result.outputs.find(
    output => output.id === metric.output,
  );
  if (
    metricOutput === undefined ||
    (metricOutput.type !== 'int' && metricOutput.type !== 'float')
  ) {
    throw new SweepProjectionError(
      `sweep metric '${spec.zMetricId}' is not numeric`,
    );
  }

  const otherAxes = result.parameters.filter(
    parameter =>
      parameter.swept && parameter.id !== x.id && parameter.id !== y.id,
  );
  const slices = validatedSlices(result, spec, otherAxes);
  const cells = new Map<number, Map<number, ProjectedCell>>();
  let scenarioCount = 0;

  for (const scenario of result.scenarios) {
    let selected = true;
    for (const parameter of otherAxes) {
      const actual = numericScenarioParameter(scenario.parameters, parameter);
      if (actual !== slices[parameter.id]) selected = false;
    }
    if (!selected) continue;

    const xValue = numericScenarioParameter(scenario.parameters, x.parameter);
    const yValue = numericScenarioParameter(scenario.parameters, y.parameter);
    if (!x.values.includes(xValue) || !y.values.includes(yValue)) {
      throw new SweepProjectionError(
        `binding ${scenario.bindingIndex} lies outside the declared X/Y sweep axes`,
      );
    }
    let row = cells.get(yValue);
    if (row === undefined) {
      row = new Map();
      cells.set(yValue, row);
    }
    if (row.has(xValue)) {
      throw new SweepProjectionError(
        `duplicate sweep coordinate X=${xValue}, Y=${yValue}`,
      );
    }
    const rawMetric = scenario.metrics[spec.zMetricId];
    row.set(xValue, {
      bindingIndex: scenario.bindingIndex,
      value:
        typeof rawMetric === 'number' && Number.isFinite(rawMetric)
          ? rawMetric
          : null,
    });
    scenarioCount++;
  }

  const complete =
    scenarioCount === x.values.length * y.values.length &&
    y.values.every(yValue =>
      x.values.every(xValue => cells.get(yValue)?.has(xValue) === true),
    );
  const geometry =
    spec.geometry === 'auto'
      ? complete && x.values.length >= 2 && y.values.length >= 2
        ? 'surface'
        : 'scatter3d'
      : spec.geometry;
  const base = {
    scenarioCount,
    x: {id: x.id, label: x.parameter.label, values: x.values},
    y: {id: y.id, label: y.parameter.label, values: y.values},
    slices,
  } as const;
  const z = {id: metric.id, label: metric.label};

  if (geometry === 'surface') {
    return {
      ...base,
      geometry,
      z: {
        ...z,
        values: y.values.map(yValue =>
          x.values.map(xValue => cells.get(yValue)?.get(xValue)?.value ?? null),
        ),
      },
    };
  }

  const points: Scatter3dPoint[] = [];
  for (const xValue of x.values) {
    for (const yValue of y.values) {
      const cell = cells.get(yValue)?.get(xValue);
      if (cell?.value == null) continue;
      points.push({
        bindingIndex: cell.bindingIndex,
        x: xValue,
        y: yValue,
        z: cell.value,
      });
    }
  }
  return {...base, geometry: 'scatter3d', z, points};
}

interface ProjectedAxis {
  readonly id: SweepParameterId;
  readonly parameter: SweepParameter;
  readonly values: readonly number[];
}

interface ProjectedCell {
  readonly bindingIndex: number;
  readonly value: number | null;
}

function projectedAxis(
  result: SweepResult,
  id: SweepParameterId,
  role: 'X' | 'Y',
): ProjectedAxis {
  const parameter = result.parameters.find(candidate => candidate.id === id);
  if (parameter === undefined) {
    throw new SweepProjectionError(`unknown sweep ${role} parameter '${id}'`);
  }
  if (
    !parameter.swept ||
    (parameter.type !== 'int' && parameter.type !== 'float')
  ) {
    throw new SweepProjectionError(
      `sweep ${role} parameter '${id}' must be numeric and swept`,
    );
  }
  const axis = result.axes.find(candidate => candidate.name === parameter.name);
  if (axis === undefined || axis.type !== parameter.type) {
    throw new SweepProjectionError(
      `sweep ${role} parameter '${id}' has no matching numeric axis`,
    );
  }
  const values = sortedUniqueNumbers(axis.values, `sweep ${role} axis '${id}'`);
  return {id, parameter, values};
}

function validatedSlices(
  result: SweepResult,
  spec: SweepViewSpec,
  otherAxes: readonly SweepParameter[],
): Readonly<Partial<Record<SweepParameterId, number>>> {
  const expected = new Set(otherAxes.map(parameter => parameter.id));
  for (const id of Object.keys(spec.slices) as SweepParameterId[]) {
    if (!expected.has(id)) {
      throw new SweepProjectionError(`unexpected sweep slice '${id}'`);
    }
  }
  const slices: Partial<Record<SweepParameterId, number>> = {};
  for (const parameter of otherAxes) {
    if (!Object.hasOwn(spec.slices, parameter.id)) {
      throw new SweepProjectionError(
        `missing sweep slice for '${parameter.id}'`,
      );
    }
    const value = spec.slices[parameter.id];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SweepProjectionError(
        `sweep slice '${parameter.id}' must be a finite number`,
      );
    }
    const axis = result.axes.find(
      candidate => candidate.name === parameter.name,
    );
    if (axis === undefined || !axis.values.includes(value)) {
      throw new SweepProjectionError(
        `sweep slice '${parameter.id}' value ${value} is outside its axis`,
      );
    }
    slices[parameter.id] = value;
  }
  return slices;
}

function numericScenarioParameter(
  values: Readonly<Record<SweepParameterId, unknown>>,
  parameter: SweepParameter,
): number {
  const value = values[parameter.id];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SweepProjectionError(
      `scenario parameter '${parameter.id}' must be a finite number`,
    );
  }
  return value;
}

function sortedUniqueNumbers(
  values: readonly number[],
  owner: string,
): readonly number[] {
  const sorted = [...values].sort((left, right) => left - right);
  for (let index = 0; index < sorted.length; index++) {
    const value = sorted[index]!;
    if (!Number.isFinite(value)) {
      throw new SweepProjectionError(`${owner} contains a non-finite value`);
    }
    if (index > 0 && value === sorted[index - 1]) {
      throw new SweepProjectionError(
        `${owner} contains duplicate value ${value}`,
      );
    }
  }
  if (sorted.length === 0) {
    throw new SweepProjectionError(`${owner} is empty`);
  }
  return sorted;
}
