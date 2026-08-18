// Purpose: Lock the editor's generic Tea result boundary, shared visualization model, and CSP shell.

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {teaCliArguments} from '../src/dashboard/cli';
import {dashboardDocument} from '../src/dashboard/document';
import {
  isCurrentDashboardOperation,
  isSameDashboardGeneration,
  settleDashboardOperation,
} from '../src/dashboard/operation';
import {
  parseDashboardRequest,
  parseMachineExecutionResult,
} from '../src/dashboard/protocol';
import {assertScenarioTrajectory} from '../src/dashboard/selection';
import type {TrajectoryResult} from '../../../src/reporting/trajectory';

const PROGRAM_HASH = 'c'.repeat(64);
const PROVIDER_HASH = 'b'.repeat(64);

describe('Tea dashboard integration', () => {
  test('accepts a versioned sweep result with a reproducible snapshot', () => {
    const result = parseMachineExecutionResult(sweepEnvelope());
    expect(result.system.kind).toBe('sweep');
    expect(result.snapshot.programSource).toBe('/work/strategy.tea');
    expect(result.snapshot.providerHash).toBe(PROVIDER_HASH);
  });

  test('requires one captured trajectory for every sweep scenario', () => {
    expect(() =>
      parseMachineExecutionResult({...sweepEnvelope(), trajectories: []}),
    ).toThrow('mismatched sweep trajectories');
  });

  test('rejects missing snapshot identity and malformed views', () => {
    const withoutSnapshot = {...sweepEnvelope(), snapshot: undefined};
    expect(() => parseMachineExecutionResult(withoutSnapshot)).toThrow(
      'invalid execution snapshot',
    );
    expect(() =>
      parseMachineExecutionResult({
        ...sweepEnvelope(),
        snapshot: {...sweepEnvelope().snapshot, programSource: ''},
      }),
    ).toThrow('invalid execution snapshot');
    expect(() =>
      parseMachineExecutionResult({
        ...sweepEnvelope(),
        snapshot: {...sweepEnvelope().snapshot, programSource: 'strategy.tea'},
      }),
    ).toThrow('invalid execution snapshot');
    expect(
      parseDashboardRequest({
        type: 'project',
        requestId: 1,
        spec: {
          xParameterId: 'parameter:x',
          yParameterId: 'parameter:y',
          zMetricId: 'metric:0:0',
          geometry: 'auto',
          slices: {bad: Number.NaN},
        },
      }),
    ).toBeNull();
  });

  test('rejects a trajectory without a row-aligned time axis', () => {
    const envelope = {
      ...sweepEnvelope(),
      system: {...sweepEnvelope().system, kind: 'run'},
      sweep: undefined,
      trajectories: undefined,
      trajectory: {
        bindingIndex: 0,
        rows: 1,
        parameters: [],
        outputs: [],
        effectSchemas: [],
        effects: [],
      },
    };
    expect(() => parseMachineExecutionResult(envelope)).toThrow(
      'invalid trajectory result',
    );
  });

  test('accepts pre-epoch timestamps in a trajectory', () => {
    const envelope = {
      ...sweepEnvelope(),
      system: {...sweepEnvelope().system, kind: 'run'},
      sweep: undefined,
      trajectories: undefined,
      trajectory: {
        bindingIndex: 0,
        rows: 1,
        time: [-1],
        parameters: [],
        outputs: [],
        effectSchemas: [],
        effects: [],
      },
    };
    expect(parseMachineExecutionResult(envelope).trajectory?.time).toEqual([
      -1,
    ]);
  });

  test('invokes one generic JSON execution without editor protocol flags', () => {
    expect(
      teaCliArguments({
        executable: 'tea',
        configPath: '/work/sweep.yaml',
        cwd: '/work',
      }),
    ).toEqual(['execute', '/work/sweep.yaml', '--json']);
  });

  test('rejects a trajectory whose parameters differ from the clicked execution', () => {
    const scenario = sweepEnvelope().sweep.scenarios[0]!;
    const trajectory: TrajectoryResult = {
      bindingIndex: 0,
      rows: 1,
      time: [100],
      parameters: [
        {
          id: 'parameter:x' as const,
          name: 'x',
          label: 'X',
          type: 'int',
          value: 9,
          active: true,
        },
        {
          id: 'parameter:y' as const,
          name: 'y',
          label: 'Y',
          type: 'int',
          value: 2,
          active: true,
        },
      ],
      outputs: [],
      effectSchemas: [],
      effects: [],
    };
    expect(() => assertScenarioTrajectory(scenario, trajectory)).toThrow(
      'parameters do not match',
    );
    expect(() =>
      assertScenarioTrajectory(scenario, {
        ...trajectory,
        parameters: trajectory.parameters.map(parameter => ({
          ...parameter,
          value: parameter.name === 'x' ? 1 : parameter.value,
        })),
      }),
    ).not.toThrow();
    expect(() =>
      assertScenarioTrajectory(scenario, {
        ...trajectory,
        parameters: trajectory.parameters.map(parameter => ({
          ...parameter,
          id:
            parameter.name === 'x'
              ? ('parameter:other' as const)
              : parameter.id,
        })),
      }),
    ).toThrow('parameters do not match');
    expect(() =>
      assertScenarioTrajectory(scenario, {
        ...trajectory,
        parameters: trajectory.parameters.map(parameter => ({
          ...parameter,
          value: parameter.name === 'x' ? 1 : parameter.value,
          active:
            parameter.name === 'x'
              ? (undefined as unknown as boolean)
              : parameter.active,
        })),
      }),
    ).toThrow('parameters do not match');
  });

  test('loads only local nonce-protected assets', () => {
    const html = dashboardDocument({
      cspSource: 'vscode-webview:',
      nonce: 'test-nonce',
      stylesheet: 'vscode-webview:/dashboard.css',
      plotlyScript: 'vscode-webview:/plotly.js',
      dashboardScript: 'vscode-webview:/dashboard.js',
    });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("style-src vscode-webview: 'unsafe-inline'");
    expect(html).toContain("script-src vscode-webview: 'nonce-test-nonce'");
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).toContain('Tea Sweep Dashboard');
    expect(html).not.toContain('SWEEP LAB');
    expect(html).not.toContain('panel-index');
    expect(html).not.toContain('plot-caption');
    expect(html).not.toContain('CLICK A POINT');
  });

  test('uses native editor styling and theme-readable Plotly hovers', () => {
    const css = readFileSync(
      resolve(import.meta.dir, '../media/dashboard.css'),
      'utf8',
    );
    const script = readFileSync(
      resolve(import.meta.dir, '../media/dashboard.js'),
      'utf8',
    );
    expect(css).toContain('font-size: var(--vscode-font-size, 13px)');
    expect(css).toContain('--vscode-font-family');
    expect(css).not.toContain('background-image');
    expect(css).not.toContain('letter-spacing');
    expect(script).toContain("'--vscode-editorHoverWidget-background'");
    expect(script).toContain("'--vscode-editorHoverWidget-foreground'");
    expect(script).toContain('hoverlabel: plotHoverLabel');
    expect(script).not.toContain('monoFont');
    expect(() => new Function(script)).not.toThrow();
  });

  test('shows selection outside WebGL without mutating the 3D plot', () => {
    const script = readFileSync(
      resolve(import.meta.dir, '../media/dashboard.js'),
      'utf8',
    );
    const html = dashboardDocument({
      cspSource: 'vscode-webview:',
      nonce: 'test-nonce',
      stylesheet: 'vscode-webview:/dashboard.css',
      plotlyScript: 'vscode-webview:/plotly.js',
      dashboardScript: 'vscode-webview:/dashboard.js',
    });
    const css = readFileSync(
      resolve(import.meta.dir, '../media/dashboard.css'),
      'utf8',
    );
    const requestBody = functionSource(
      script,
      'requestTrajectory',
      'scheduleTrajectoryRequest',
    );
    expect(requestBody).toContain('loadingBindingIndex === bindingIndex');
    expect(requestBody).toContain("type: 'selectScenario'");
    expect(requestBody).toContain('scheduleTrajectoryRequest');
    expect(requestBody).not.toContain('vscode.postMessage');
    expect(requestBody).not.toContain('drawSurface()');
    expect(script).not.toContain('trajectoryCache');
    expect(script).not.toContain('Plotly.restyle');
    expect(script).not.toContain('updateSurfaceSelection');
    expect(script).not.toContain('selectedPoint');
    expect(html).toContain('id="surface-selection"');
    expect(css).toContain('.surface-selection-layer');
    expect(css).toContain('pointer-events: none');
    expect(css).toContain('surface-selection-pulse');
    expect(script).toContain("attributeFilter: ['class']");
    expect(script).not.toContain("attributeFilter: ['class', 'style']");
  });

  test('positions the CSS selection affordance at the exact click location', () => {
    const position = dashboardFunction<
      (
        event: {event?: {clientX?: number; clientY?: number}},
        bounds: {left: number; top: number; width: number; height: number},
      ) => {x: number; y: number} | null
    >('surfaceSelectionPosition', 'showSurfaceSelection');
    const bounds = {left: 100, top: 200, width: 500, height: 300};
    expect(position({event: {clientX: 115, clientY: 250}}, bounds)).toEqual({
      x: 15,
      y: 50,
    });
    expect(position({event: {clientX: 40, clientY: 900}}, bounds)).toEqual({
      x: 0,
      y: 300,
    });
    expect(
      position({event: {clientX: Number.NaN, clientY: 250}}, bounds),
    ).toBeNull();
  });

  test('maps Plotly surface events to the exact X/Y execution and exposes a hover affordance', () => {
    const matrix = dashboardFunction<
      (
        scene: {x: {values: number[]}; y: {values: number[]}},
        bindings: Map<string, number>,
      ) => (number | null)[][]
    >('surfaceBindingMatrix', 'bindingIndexForPlotPoint');
    const resolvePoint = dashboardFunction<
      (
        point: {x?: number; y?: number; customdata?: number},
        bindings: Map<string, number>,
      ) => number | null
    >('bindingIndexForPlotPoint', 'coordinateKey');
    const coordinateKey = (x: number, y: number) => `${x}\u0000${y}`;
    const xValues = Array.from({length: 10}, (_, index) => 2 + index * 2);
    const yValues = Array.from({length: 10}, (_, index) => 24 + index * 4);
    const bindings = new Map<string, number>([
      [coordinateKey(6, 60), 29],
      [coordinateKey(20, 32), 92],
    ]);
    const customdata = matrix(
      {x: {values: xValues}, y: {values: yValues}},
      bindings,
    );
    expect(customdata[2]?.[9]).toBe(29);
    expect(customdata[9]?.[2]).toBe(92);
    expect(resolvePoint({x: 6, y: 60, customdata: 92}, bindings)).toBe(29);
    expect(resolvePoint({x: 7, y: 60, customdata: 29}, bindings)).toBeNull();

    const html = dashboardDocument({
      cspSource: 'vscode-webview:',
      nonce: 'test-nonce',
      stylesheet: 'vscode-webview:/dashboard.css',
      plotlyScript: 'vscode-webview:/plotly.js',
      dashboardScript: 'vscode-webview:/dashboard.js',
    });
    const css = readFileSync(
      resolve(import.meta.dir, '../media/dashboard.css'),
      'utf8',
    );
    const script = dashboardScript();
    expect(html).not.toContain('surface-hover-ring');
    expect(css).toContain('#surface-plot.is-clickable');
    expect(script).toContain("elements.surfacePlot.on('plotly_hover'");
    expect(script).toContain("elements.surfacePlot.on('plotly_unhover'");
    expect(script).toContain('showSurfaceSelection(event)');
    expect(script).toContain('highlightcolor: ink');
    const hoverHandler = script.slice(
      script.indexOf("elements.surfacePlot.on('plotly_hover'"),
      script.indexOf("elements.surfacePlot.on('plotly_unhover'"),
    );
    expect(hoverHandler).toContain("classList.add('is-clickable')");
    expect(hoverHandler).not.toContain('Plotly.restyle');
    expect(hoverHandler).not.toContain('updateSurfaceHoverPoint');
    expect(script).not.toContain('function updateSurfaceHoverPoint');
  });

  test('derives click identity from the rendered scene rather than pending controls', () => {
    const mapScene = dashboardFunction<
      (
        scene: {
          x: {id: string};
          y: {id: string};
          slices: Record<string, number>;
        },
        scenarios: Iterable<{
          bindingIndex: number;
          parameters: Record<string, number>;
        }>,
      ) => Map<string, number>
    >('sceneBindingMap', 'surfaceBindingMatrix');
    const rendered = {
      x: {id: 'parameter:fast'},
      y: {id: 'parameter:slow'},
      slices: {'parameter:fee': 0.1},
    };
    const pendingControlsDescribeDifferentAxes = {
      xParameterId: 'parameter:slow',
      yParameterId: 'parameter:fast',
      slices: {'parameter:fee': 0.2},
    };
    const result = mapScene(rendered, [
      {
        bindingIndex: 29,
        parameters: {
          'parameter:fast': 6,
          'parameter:slow': 60,
          'parameter:fee': 0.1,
        },
      },
    ]);
    expect(result.get('6\u000060')).toBe(29);
    expect(pendingControlsDescribeDifferentAxes).not.toEqual(rendered);
    const source = functionSource(
      dashboardScript(),
      'sceneBindingMap',
      'surfaceBindingMatrix',
    );
    expect(source).not.toContain('currentSpec');
    expect(source).not.toContain('elements.');
  });

  test('clears old generations and indexes surface bindings in linear time', () => {
    const script = dashboardScript();
    const generationAdvance = script.slice(
      script.indexOf(
        'if (Number.isInteger(message.runId) && message.runId > runId)',
      ),
      script.indexOf('switch (message.type)'),
    );
    const clearView = functionSource(
      script,
      'clearRunView',
      'selectTrajectoryOutput',
    );
    const bindings = functionSource(
      script,
      'sceneBindingMap',
      'surfaceBindingMatrix',
    );
    expect(generationAdvance).toContain('clearRunView()');
    expect(clearView).toContain('scenarioByBinding = new Map()');
    expect(clearView).toContain('Plotly.purge(elements.surfacePlot)');
    expect(clearView).toContain('Plotly.purge(elements.trajectoryPlot)');
    expect(clearView).toContain("elements.runtimeSummary.textContent = '—'");
    expect(clearView).toContain('cancelTrajectoryIntent()');
    expect(bindings).toContain('for (const candidate of candidates)');
    expect(bindings).toContain('const byCoordinate = new Map()');
    expect(bindings).not.toContain('.find(');
    const draw = functionSource(script, 'drawSurface', 'sceneBindingMap');
    expect(draw).toContain('scheduleSurfaceRender()');
    expect(draw).toContain('const renderedScene = scene');
    expect(draw).toContain('renderedScene !== scene');
    expect(draw).not.toContain('updateSurfaceHoverPoint');
  });

  test('serializes surface and trajectory Plotly renders', () => {
    const script = dashboardScript();
    const surface = functionSource(script, 'drawSurface', 'sceneBindingMap');
    const trajectory = functionSource(
      script,
      'drawTrajectory',
      'latestRenderQueue',
    );
    expect(surface).toContain('scheduleSurfaceRender()');
    expect(trajectory).toContain('scheduleTrajectoryRender()');
    expect(trajectory).toContain('renderedTrajectory !== trajectory');
    expect(surface).not.toContain('scheduleResize()');
    expect(trajectory).not.toContain('scheduleResize()');
    expect(script).not.toContain('surfaceRenderEpoch');
    expect(script).not.toContain('trajectoryRenderEpoch');
  });

  test('remeasures a newly rendered trajectory without resizing the surface', () => {
    const script = dashboardScript();
    const trajectory = functionSource(
      script,
      'drawTrajectory',
      'latestRenderQueue',
    );
    const trajectoryResize = functionSource(
      script,
      'scheduleTrajectoryResize',
      'persistState',
    );
    const globalResize = functionSource(
      script,
      'scheduleResize',
      'scheduleTrajectoryResize',
    );
    const css = readFileSync(
      resolve(import.meta.dir, '../media/dashboard.css'),
      'utf8',
    );

    expect(trajectory).toContain('await Plotly.react');
    expect(trajectory).toContain('scheduleTrajectoryResize()');
    expect(trajectory.indexOf('scheduleTrajectoryResize()')).toBeGreaterThan(
      trajectory.indexOf('await Plotly.react'),
    );
    expect(trajectoryResize).toContain(
      'Plotly.Plots.resize(elements.trajectoryPlot)',
    );
    expect(trajectoryResize).not.toContain('elements.surfacePlot');
    expect(globalResize).toContain('Plotly.Plots.resize(elements.surfacePlot)');
    expect(globalResize).toContain(
      'Plotly.Plots.resize(elements.trajectoryPlot)',
    );
    expect(css).not.toContain('.plot:empty');
  });

  test('coalesces concurrent Plotly renders to one latest follow-up', async () => {
    const latestRenderQueue = dashboardFunction<
      (renderLatest: () => Promise<void>) => () => void
    >('latestRenderQueue', 'extremaPreservingIndices');
    const releases: Array<() => void> = [];
    let calls = 0;
    const request = latestRenderQueue(async () => {
      calls += 1;
      await new Promise<void>(resolve => releases.push(resolve));
    });

    request();
    request();
    request();
    expect(calls).toBe(1);

    releases.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);

    request();
    request();
    releases.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(3);

    releases.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(3);
  });

  test('coalesces scenario requests to the latest animation frame', () => {
    const script = dashboardScript();
    const schedule = functionSource(
      script,
      'scheduleTrajectoryRequest',
      'cancelTrajectoryIntent',
    );
    expect(script).not.toContain('TRAJECTORY_INTENT_DELAY_MS');
    expect(schedule).toContain('cancelTrajectoryIntent()');
    expect(schedule).toContain('window.requestAnimationFrame');
    expect(schedule).toContain('pending.requestId !== latestTrajectoryRequest');
    expect(schedule).toContain('pending.bindingIndex !== loadingBindingIndex');
    expect(schedule).toContain('vscode.postMessage');
    expect(script).toContain('window.cancelAnimationFrame');
  });

  test('decimates only the displayed trajectory while preserving extrema and gaps', () => {
    const sample = dashboardFunction<
      (values: readonly (number | null)[], maxPoints: number) => number[]
    >('extremaPreservingIndices', 'trajectoryDisplayPointBudget');
    const values: (number | null)[] = Array.from({length: 12_000}, (_, index) =>
      Math.sin(index / 19),
    );
    values[3100] = 9999;
    values[4000] = null;
    values[7600] = -9999;
    const indices = sample(values, 4000);
    expect(indices.length).toBeLessThanOrEqual(4000);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(values.length - 1);
    expect(indices).toContain(3100);
    expect(indices).toContain(4000);
    expect(indices).toContain(7600);
    expect(sample([1, null, 3], 4000)).toEqual([0, 1, 2]);

    const twoGapsInOneBucket: (number | null)[] = Array.from(
      {length: 100},
      (_, index) => index,
    );
    twoGapsInOneBucket[5] = null;
    twoGapsInOneBucket[6] = null;
    twoGapsInOneBucket[10] = Number.NaN;
    twoGapsInOneBucket[11] = null;
    const gapIndices = sample(twoGapsInOneBucket, 20);
    expect(gapIndices).toEqual(
      expect.arrayContaining([4, 5, 6, 7, 9, 10, 11, 12]),
    );
    for (const [left, right] of [
      [4, 5],
      [6, 7],
      [9, 10],
      [11, 12],
    ]) {
      expect(gapIndices).toContain(left);
      expect(gapIndices).toContain(right);
    }

    const draw = functionSource(
      dashboardScript(),
      'drawTrajectory',
      'extremaPreservingIndices',
    );
    expect(draw).toContain('displayIndices.map(xAt)');
    expect(draw).toContain(
      'fillEvents(renderedTrajectory, output.values, xAt)',
    );
    expect(draw).not.toContain('y: output.values');
  });

  test('rejects stale sweep and scenario continuations', () => {
    const execution = {};
    const sweep = {
      disposed: false,
      runId: 4,
      scenarioRequestId: -1,
      phase: 'sweep' as const,
      execution,
    };
    expect(isCurrentDashboardOperation(sweep, execution, 4)).toBe(true);
    expect(
      isCurrentDashboardOperation({...sweep, runId: 5}, execution, 4),
    ).toBe(false);
    expect(
      isCurrentDashboardOperation(
        {...sweep, phase: 'trajectory', scenarioRequestId: 8},
        execution,
        4,
      ),
    ).toBe(false);

    const scenario = {
      ...sweep,
      phase: 'trajectory' as const,
      scenarioRequestId: 8,
    };
    expect(isCurrentDashboardOperation(scenario, execution, 4, 8)).toBe(true);
    expect(isCurrentDashboardOperation(scenario, execution, 4, 9)).toBe(false);
    expect(isCurrentDashboardOperation(scenario, {}, 4, 8)).toBe(false);
    expect(settleDashboardOperation(scenario, execution, 4, 8)).toEqual({
      ...scenario,
      phase: 'idle',
      execution: null,
    });
    expect(settleDashboardOperation(scenario, execution, 4, 9)).toBeNull();
    expect(
      settleDashboardOperation({...sweep, execution: null}, null, 4),
    ).toEqual({...sweep, phase: 'idle', execution: null});
    expect(isSameDashboardGeneration(scenario, 4, 8)).toBe(true);
    expect(isSameDashboardGeneration({...scenario, runId: 5}, 4, 8)).toBe(
      false,
    );
    expect(
      isSameDashboardGeneration({...scenario, scenarioRequestId: 9}, 4, 8),
    ).toBe(false);
  });
});

function dashboardScript(): string {
  return readFileSync(
    resolve(import.meta.dir, '../media/dashboard.js'),
    'utf8',
  );
}

function functionSource(
  script: string,
  name: string,
  nextName: string,
): string {
  const regularStart = script.indexOf(`  function ${name}`);
  const start =
    regularStart >= 0
      ? regularStart
      : script.indexOf(`  async function ${name}`);
  const possibleEnds = [
    script.indexOf(`\n  function ${nextName}`, start),
    script.indexOf(`\n  async function ${nextName}`, start),
  ].filter(index => index >= 0);
  const end = possibleEnds.length > 0 ? Math.min(...possibleEnds) : -1;
  if (start < 0 || end < 0) {
    throw new Error(`missing dashboard function ${name}`);
  }
  return script.slice(start, end).trim();
}

function dashboardFunction<T>(name: string, nextName: string): T {
  const source = functionSource(dashboardScript(), name, nextName);
  return new Function(`return (${source});`)() as T;
}

function sweepEnvelope() {
  return {
    schema: 'tea.execution-result/v2',
    snapshot: {
      programSource: '/work/strategy.tea',
      programHash: PROGRAM_HASH,
      providerHash: PROVIDER_HASH,
      timeNow: 1234,
    },
    system: {
      kind: 'sweep',
      backend: 'cpu',
      numericProfile: 'js-f64',
      executions: 1,
      rows: 2,
      timing: {},
    },
    sweep: {
      axes: [
        {name: 'x', type: 'int', values: [1]},
        {name: 'y', type: 'int', values: [2]},
      ],
      parameters: [
        {
          id: 'parameter:x',
          name: 'x',
          label: 'X',
          type: 'int',
          swept: true,
          values: [1],
        },
        {
          id: 'parameter:y',
          name: 'y',
          label: 'Y',
          type: 'int',
          swept: true,
          values: [2],
        },
      ],
      outputs: [],
      metrics: [{id: 'metric:0:0', output: 'output:0:0', label: 'Value'}],
      scenarios: [
        {
          bindingIndex: 0,
          rows: 2,
          parameters: {'parameter:x': 1, 'parameter:y': 2},
          outputs: {},
          metrics: {'metric:0:0': 3},
        },
      ],
    },
    trajectories: [
      {
        bindingIndex: 0,
        rows: 2,
        time: [100, 200],
        parameters: [
          {
            id: 'parameter:x',
            name: 'x',
            label: 'X',
            type: 'int',
            value: 1,
            active: true,
          },
          {
            id: 'parameter:y',
            name: 'y',
            label: 'Y',
            type: 'int',
            value: 2,
            active: true,
          },
        ],
        outputs: [],
        effectSchemas: [],
        effects: [],
      },
    ],
  };
}
