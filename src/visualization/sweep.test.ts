// Purpose: Deterministic validation and projection of sweep results into renderer-neutral scenes.

import {describe, expect, test} from 'vitest';
import type {
  SweepMetricId,
  SweepParameterId,
  SweepResult,
  SweepScenario,
} from '../reporting/sweep';
import {projectSweepScene, SweepProjectionError} from './sweep';

const xId = 'parameter:fast' as SweepParameterId;
const yId = 'parameter:slow' as SweepParameterId;
const sliceId = 'parameter:risk' as SweepParameterId;
const metricId = 'metric:0:0' as SweepMetricId;

describe('sweep scene projection', () => {
  test('auto-selects a surface for a complete sliced grid and sorts axes', () => {
    const scene = projectSweepScene(result(), spec());

    expect(scene).toEqual({
      geometry: 'surface',
      scenarioCount: 4,
      x: {id: xId, label: 'Fast', values: [1, 2]},
      y: {id: yId, label: 'Slow', values: [10, 20]},
      z: {
        id: metricId,
        label: 'Return',
        values: [
          [11, 12],
          [21, 22],
        ],
      },
      slices: {[sliceId]: 1},
    });
  });

  test('auto-selects a deterministic point set for an incomplete grid', () => {
    const source = result();
    const scene = projectSweepScene(
      {
        ...source,
        scenarios: source.scenarios.filter(row => row.bindingIndex !== 4),
      },
      spec(),
    );

    expect(scene.geometry).toBe('scatter3d');
    if (scene.geometry !== 'scatter3d') throw new Error('expected scatter');
    expect(scene.scenarioCount).toBe(3);
    expect(scene.points).toEqual([
      {bindingIndex: 1, x: 1, y: 10, z: 11},
      {bindingIndex: 3, x: 1, y: 20, z: 21},
      {bindingIndex: 2, x: 2, y: 10, z: 12},
    ]);
  });

  test('explicit surface preserves missing and null metric holes', () => {
    const source = result();
    const scenarios = source.scenarios
      .filter(row => row.bindingIndex !== 4)
      .map(row =>
        row.bindingIndex === 2 ? {...row, metrics: {[metricId]: null}} : row,
      );
    const scene = projectSweepScene(
      {...source, scenarios},
      {...spec(), geometry: 'surface'},
    );

    expect(scene.geometry).toBe('surface');
    if (scene.geometry !== 'surface') throw new Error('expected surface');
    expect(scene.z.values).toEqual([
      [11, null],
      [21, null],
    ]);
  });

  test('auto preserves null metrics as holes in a complete coordinate grid', () => {
    const source = result();
    const scenarios = source.scenarios.map(row =>
      row.bindingIndex === 2 ? {...row, metrics: {[metricId]: null}} : row,
    );
    const scene = projectSweepScene({...source, scenarios}, spec());

    expect(scene.geometry).toBe('surface');
    if (scene.geometry !== 'surface') throw new Error('expected surface');
    expect(scene.z.values).toEqual([
      [11, null],
      [21, 22],
    ]);
  });

  test('auto uses points for a degenerate one-value axis', () => {
    const source = result();
    const axes = source.axes.map(axis =>
      axis.name === 'fast' ? {...axis, values: [1]} : axis,
    );
    const parameters = source.parameters.map(parameter =>
      parameter.id === xId ? {...parameter, values: [1]} : parameter,
    );
    const scenarios = source.scenarios.filter(row => row.parameters[xId] === 1);
    const scene = projectSweepScene(
      {...source, axes, parameters, scenarios},
      spec(),
    );

    expect(scene.geometry).toBe('scatter3d');
  });

  test('rejects duplicate coordinates after exact slice filtering', () => {
    const source = result();
    const duplicate = scenario(99, 1, 10, 99, 1);
    expect(() =>
      projectSweepScene(
        {...source, scenarios: [...source.scenarios, duplicate]},
        spec(),
      ),
    ).toThrow('duplicate sweep coordinate X=1, Y=10');
  });

  test('requires distinct numeric swept axes and a numeric metric', () => {
    const source = result();
    expect(() =>
      projectSweepScene(source, {...spec(), geometry: 'mesh' as 'auto'}),
    ).toThrow("unknown sweep geometry 'mesh'");
    expect(() =>
      projectSweepScene(source, {...spec(), yParameterId: xId}),
    ).toThrow('X and Y parameters must differ');

    const parameters = source.parameters.map(parameter =>
      parameter.id === xId ? {...parameter, swept: false} : parameter,
    );
    expect(() => projectSweepScene({...source, parameters}, spec())).toThrow(
      "parameter 'parameter:fast' must be numeric and swept",
    );

    const outputs = source.outputs.map(output => ({...output, type: 'bool'}));
    expect(() => projectSweepScene({...source, outputs}, spec())).toThrow(
      "metric 'metric:0:0' is not numeric",
    );
  });

  test('requires one valid slice for every other swept axis and no extras', () => {
    const source = result();
    expect(() => projectSweepScene(source, {...spec(), slices: {}})).toThrow(
      "missing sweep slice for 'parameter:risk'",
    );
    expect(() =>
      projectSweepScene(source, {
        ...spec(),
        slices: {[sliceId]: 1, ['parameter:extra' as SweepParameterId]: 2},
      }),
    ).toThrow("unexpected sweep slice 'parameter:extra'");
    expect(() =>
      projectSweepScene(source, {...spec(), slices: {[sliceId]: 3}}),
    ).toThrow("slice 'parameter:risk' value 3 is outside its axis");
  });
});

function spec() {
  return {
    xParameterId: xId,
    yParameterId: yId,
    zMetricId: metricId,
    slices: {[sliceId]: 1},
    geometry: 'auto' as const,
  };
}

function result(): SweepResult {
  return {
    axes: [
      {name: 'fast', values: [2, 1]},
      {name: 'slow', values: [20, 10]},
      {name: 'risk', values: [0, 1]},
    ],
    parameters: [
      {
        id: xId,
        name: 'fast',
        label: 'Fast',
        type: 'float',
        swept: true,
        values: [2, 1],
      },
      {
        id: yId,
        name: 'slow',
        label: 'Slow',
        type: 'int',
        swept: true,
        values: [20, 10],
      },
      {
        id: sliceId,
        name: 'risk',
        label: 'Risk',
        type: 'float',
        swept: true,
        values: [0, 1],
      },
    ],
    outputs: [
      {
        id: 'output:0:0',
        outputId: 0,
        channel: 0,
        label: 'Return',
        type: 'float',
      },
    ],
    metrics: [{id: metricId, output: 'output:0:0', label: 'Return'}],
    scenarios: [
      scenario(4, 2, 20, 22, 1),
      scenario(1, 1, 10, 11, 1),
      scenario(0, 1, 10, 100, 0),
      scenario(3, 1, 20, 21, 1),
      scenario(2, 2, 10, 12, 1),
    ],
  };
}

function scenario(
  bindingIndex: number,
  x: number,
  y: number,
  z: number,
  slice: number,
): SweepScenario {
  return {
    bindingIndex,
    rows: 100,
    parameters: {[xId]: x, [yId]: y, [sliceId]: slice},
    outputs: {'output:0:0': z},
    metrics: {[metricId]: z},
  };
}
