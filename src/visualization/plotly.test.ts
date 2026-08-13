// Purpose: The Plotly adapter stays offline and emits syntactically valid inline UI code.

import {describe, expect, test} from 'bun:test';
import type {SweepRendererModel} from './renderer';
import {PlotlySweepRenderer, PLOTLY_ASSET_PATH} from './plotly';

describe('Plotly sweep renderer', () => {
  test('serves only the pinned asset and emits valid escaped browser code', () => {
    const document = new PlotlySweepRenderer().document(model());

    expect(document.contentType).toBe('text/html; charset=utf-8');
    expect(document.body).toContain(`<script src="${PLOTLY_ASSET_PATH}">`);
    expect(document.body).not.toContain('https://');
    expect(document.body).not.toContain('</script><img');

    const inline = document.body.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    expect(inline).toBeDefined();
    expect(() => new Function(inline!)).not.toThrow();
  });
});

function model(): SweepRendererModel {
  return {
    axes: [
      {
        id: 'parameter:fast',
        name: 'fast',
        label: 'Fast </script><img src=x>',
        type: 'int',
        values: [3, 5],
      },
      {
        id: 'parameter:slow',
        name: 'slow',
        label: 'Slow',
        type: 'int',
        values: [10, 12],
      },
    ],
    metrics: [{id: 'metric:0:0', output: 'output:0:0', label: 'Return'}],
    initialSpec: {
      xParameterId: 'parameter:fast',
      yParameterId: 'parameter:slow',
      zMetricId: 'metric:0:0',
      slices: {},
      geometry: 'auto',
    },
    initialScene: {
      geometry: 'surface',
      scenarioCount: 4,
      x: {
        id: 'parameter:fast',
        label: 'Fast </script><img src=x>',
        values: [3, 5],
      },
      y: {id: 'parameter:slow', label: 'Slow', values: [10, 12]},
      z: {
        id: 'metric:0:0',
        label: 'Return',
        values: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      },
      slices: {},
    },
  };
}
