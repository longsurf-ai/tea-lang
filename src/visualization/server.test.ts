import {afterEach, describe, expect, test} from 'bun:test';
import type {SweepResult} from '../reporting/sweep';
import type {SweepRenderer} from './renderer';
import {PLOTLY_ASSET_PATH} from './plotly';
import {startSweepViewer, type SweepViewer} from './server';

const result: SweepResult = {
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
  outputs: [
    {
      id: 'output:0:0',
      outputId: 0,
      channel: 0,
      label: 'Return',
      type: 'float',
    },
  ],
  metrics: [{id: 'metric:0:0', output: 'output:0:0', label: 'Return'}],
  scenarios: [
    scenario(0, 3, 10, 0.1),
    scenario(1, 5, 10, 0.2),
    scenario(2, 3, 12, 0.3),
    scenario(3, 5, 12, 0.4),
  ],
};

describe('sweep viewer', () => {
  let viewer: SweepViewer | undefined;
  afterEach(async () => viewer?.close());

  test('serves renderer output and the pinned local Plotly asset', async () => {
    const renderer: SweepRenderer = {
      document: () => ({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>test sweep</title>',
      }),
    };
    const printed: string[] = [];
    viewer = await startSweepViewer(result, renderer, {
      open: false,
      print: value => printed.push(value),
    });
    expect(viewer.url).toStartWith('http://127.0.0.1:');
    expect(printed).toEqual([`Tea sweep view: ${viewer.url}`]);

    const page = await fetch(viewer.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('test sweep');

    const plotly = await fetch(new URL(PLOTLY_ASSET_PATH, viewer.url));
    expect(plotly.status).toBe(200);
    expect(plotly.headers.get('content-type')).toContain('text/javascript');
    expect(Number(plotly.headers.get('content-length') ?? 0)).toBeGreaterThan(
      100_000,
    );

    const projected = await fetch(new URL('/scene', viewer.url), {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        xParameterId: 'parameter:fast',
        yParameterId: 'parameter:slow',
        zMetricId: 'metric:0:0',
        slices: {},
        geometry: 'auto',
      }),
    });
    expect(projected.status).toBe(200);
    expect((await projected.json()).geometry).toBe('surface');

    const invalid = await fetch(new URL('/scene', viewer.url), {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        xParameterId: 'parameter:fast',
        yParameterId: 'parameter:fast',
        zMetricId: 'metric:0:0',
        slices: {},
        geometry: 'auto',
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: 'sweep view X and Y parameters must differ',
    });
  });

  test('opens the loopback URL and contains renderer failures', async () => {
    const opened: string[] = [];
    const warnings: string[] = [];
    viewer = await startSweepViewer(
      result,
      {
        document: () => ({
          contentType: 'text/html; charset=utf-8',
          body: '<html></html>',
        }),
      },
      {
        opener: async url => {
          opened.push(url);
          throw new Error('no browser');
        },
        warn: value => warnings.push(value),
      },
    );
    expect(opened).toEqual([viewer.url]);
    expect(warnings).toEqual([
      'tea: could not open the sweep viewer: no browser',
    ]);
  });
});

function scenario(
  bindingIndex: number,
  fast: number,
  slow: number,
  value: number,
) {
  return {
    bindingIndex,
    rows: 10,
    parameters: {
      'parameter:fast': fast,
      'parameter:slow': slow,
    },
    outputs: {'output:0:0': value},
    metrics: {'metric:0:0': value},
  } as const;
}
