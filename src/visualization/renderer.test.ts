// Purpose: Viewer defaults are deterministic, informative, and renderer-neutral.

import {describe, expect, test} from 'bun:test';
import type {SweepResult} from '../reporting/sweep';
import {createSweepRendererModel} from './renderer';

describe('sweep renderer model', () => {
  test('uses declaration-ordered axes and the most varied numeric metric', () => {
    const model = createSweepRendererModel(result());

    expect(model.initialSpec).toEqual({
      xParameterId: 'parameter:fast',
      yParameterId: 'parameter:slow',
      zMetricId: 'metric:1:0',
      slices: {},
      geometry: 'auto',
    });
    expect(model.initialScene.geometry).toBe('surface');
    expect(model.initialScene.z.label).toBe('Return');
  });

  test('requires two swept axes and at least one numeric output', () => {
    const source = result();
    expect(() =>
      createSweepRendererModel({...source, axes: source.axes.slice(0, 1)}),
    ).toThrow('at least two numeric parameter ranges');
    expect(() => createSweepRendererModel({...source, metrics: []})).toThrow(
      'at least one numeric output metric',
    );
  });
});

function result(): SweepResult {
  return {
    axes: [
      {name: 'fast', type: 'int', values: [3, 5]},
      {name: 'slow', type: 'int', values: [10, 12]},
    ],
    parameters: [
      {
        id: 'parameter:fast',
        name: 'fast',
        label: 'Fast',
        type: 'int',
        swept: true,
        values: [3, 5],
      },
      {
        id: 'parameter:slow',
        name: 'slow',
        label: 'Slow',
        type: 'int',
        swept: true,
        values: [10, 12],
      },
    ],
    outputs: [output(0, 'Close'), output(1, 'Return')],
    metrics: [
      {id: 'metric:0:0', output: 'output:0:0', label: 'Close'},
      {id: 'metric:1:0', output: 'output:1:0', label: 'Return'},
    ],
    scenarios: [
      scenario(0, 3, 10, 100, 0.1),
      scenario(1, 5, 10, 100, 0.2),
      scenario(2, 3, 12, 100, 0.3),
      scenario(3, 5, 12, 100, 0.4),
    ],
  };
}

function output(outputId: number, label: string) {
  return {
    id: `output:${outputId}:0` as const,
    outputId,
    channel: 0,
    label,
    type: 'float',
  };
}

function scenario(
  bindingIndex: number,
  fast: number,
  slow: number,
  close: number,
  result: number,
) {
  return {
    bindingIndex,
    rows: 10,
    parameters: {
      'parameter:fast': fast,
      'parameter:slow': slow,
    },
    outputs: {'output:0:0': close, 'output:1:0': result},
    metrics: {'metric:0:0': close, 'metric:1:0': result},
  } as const;
}
