// Purpose: Browser-renderer boundary for a projected sweep scene.

import type {
  SweepMetric,
  SweepParameter,
  SweepResult,
} from '../reporting/sweep';
import {
  projectSweepScene,
  SweepProjectionError,
  type SweepScene,
  type SweepViewSpec,
} from './sweep';

export interface SweepRendererModel {
  readonly axes: readonly Pick<
    SweepParameter,
    'id' | 'name' | 'label' | 'type' | 'values'
  >[];
  readonly metrics: readonly SweepMetric[];
  readonly initialSpec: SweepViewSpec;
  readonly initialScene: SweepScene;
}

export function createSweepRendererModel(
  result: SweepResult,
): SweepRendererModel {
  const axes = result.axes.map(axis => {
    const parameter = result.parameters.find(
      candidate => candidate.name === axis.name,
    );
    if (
      parameter === undefined ||
      !parameter.swept ||
      (parameter.type !== 'int' && parameter.type !== 'float')
    ) {
      throw new SweepProjectionError(
        `sweep axis '${axis.name}' has no matching numeric parameter`,
      );
    }
    return {...parameter, values: [...axis.values]};
  });
  if (axes.length < 2) {
    throw new SweepProjectionError(
      'sweep visualization requires at least two numeric parameter ranges',
    );
  }
  const metric = mostVariedMetric(result);
  if (metric === undefined) {
    throw new SweepProjectionError(
      'sweep visualization requires at least one numeric output metric',
    );
  }
  const slices = Object.fromEntries(
    axes.slice(2).map(axis => [axis.id, axis.values[0]]),
  );
  const initialSpec: SweepViewSpec = {
    xParameterId: axes[0]!.id,
    yParameterId: axes[1]!.id,
    zMetricId: metric.id,
    slices,
    geometry: 'auto',
  };
  return {
    axes,
    metrics: result.metrics,
    initialSpec,
    initialScene: projectSweepScene(result, initialSpec),
  };
}

function mostVariedMetric(result: SweepResult): SweepMetric | undefined {
  let selected: SweepMetric | undefined;
  let selectedDistinct = -1;
  for (const metric of result.metrics) {
    const values = new Set<number>();
    for (const scenario of result.scenarios) {
      const value = scenario.metrics[metric.id];
      if (typeof value === 'number' && Number.isFinite(value)) {
        values.add(value);
      }
    }
    if (values.size > selectedDistinct) {
      selected = metric;
      selectedDistinct = values.size;
    }
  }
  return selected;
}
