// Purpose: Structured sweep results preserve stable identities independently of display labels.

import {describe, expect, test} from 'vitest';
import type {ExecutionSummary} from '../execution/execute';
import type {ExecutionDeclaration, ParamSpec} from '../runtime/abi';
import {
  buildSweepResult,
  sweepResultSection,
  type SweepReportSnapshot,
} from './sweep';

const FAST = parameter('fast', 'Length', 'float');
const SLOW = parameter('slow', 'Length', 'int');
const ENABLED = parameter('enabled', null, 'bool');

const declaration: ExecutionDeclaration = {
  outputs: [
    {
      spec: {
        effect: 'plot',
        staticArgs: [{name: 'title', value: 'Metric'}],
        channels: [
          {name: 'series', type: 'float', transport: {kind: 'float'}},
          {name: 'note', type: 'string', transport: {kind: 'string'}},
        ],
      },
      boundArgs: [],
    },
    {
      spec: {
        effect: 'plot',
        staticArgs: [{name: 'title', value: 'Metric'}],
        channels: [{name: 'series', type: 'int', transport: {kind: 'int'}}],
      },
      boundArgs: [],
    },
  ],
  effects: [],
};

describe('structured sweep results', () => {
  test('projects axes, effective parameters, outputs, and numeric metrics by stable IDs', () => {
    const summary: ExecutionSummary = {
      backend: 'cpu',
      numericProfile: 'js-f64',
      bindings: [
        {
          bindingIndex: 7,
          rows: 100,
          inputs: [
            {spec: FAST, value: 5, active: true},
            {spec: SLOW, value: 10, active: true},
            {spec: ENABLED, value: true, active: true},
          ],
        },
        {
          bindingIndex: 9,
          rows: 80,
          inputs: [
            {spec: FAST, value: 6, active: true},
            {spec: SLOW, value: 10, active: true},
            {spec: ENABLED, value: true, active: true},
          ],
        },
      ],
      timing: {loweringMs: 1, executionMs: 2, totalMs: 3},
    };
    const snapshots: readonly SweepReportSnapshot[] = [
      {
        bindingIndex: 7,
        declaration,
        rows: 100,
        finalOutputs: [
          {
            row: 99,
            outputId: 0,
            channels: [Number.POSITIVE_INFINITY, 'warmup'],
          },
          {row: 99, outputId: 1, channels: [12]},
        ],
      },
      {
        bindingIndex: 9,
        declaration,
        rows: 80,
        finalOutputs: [{row: 79, outputId: 0, channels: [3.5, 'ready']}],
      },
    ];

    const result = buildSweepResult(summary, snapshots, [
      {name: 'fast', values: [5, 6]},
    ]);

    expect(result.parameters).toEqual([
      {
        id: 'parameter:fast',
        name: 'fast',
        label: 'Length',
        type: 'float',
        swept: true,
        values: [5, 6],
      },
      {
        id: 'parameter:slow',
        name: 'slow',
        label: 'Length',
        type: 'int',
        swept: false,
        values: [10],
      },
      {
        id: 'parameter:enabled',
        name: 'enabled',
        label: 'enabled',
        type: 'bool',
        swept: false,
        values: [true],
      },
    ]);
    expect(
      result.outputs.map(({id, label, type}) => ({id, label, type})),
    ).toEqual([
      {id: 'output:0:0', label: 'Metric', type: 'float'},
      {id: 'output:0:1', label: 'Metric.note', type: 'string'},
      {id: 'output:1:0', label: 'Metric', type: 'int'},
    ]);
    expect(result.metrics).toEqual([
      {id: 'metric:0:0', output: 'output:0:0', label: 'Metric'},
      {id: 'metric:1:0', output: 'output:1:0', label: 'Metric'},
    ]);
    expect(result.scenarios).toEqual([
      {
        bindingIndex: 7,
        rows: 100,
        parameters: {
          'parameter:fast': 5,
          'parameter:slow': 10,
          'parameter:enabled': true,
        },
        outputs: {
          'output:0:0': null,
          'output:0:1': 'warmup',
          'output:1:0': 12,
        },
        metrics: {'metric:0:0': null, 'metric:1:0': 12},
      },
      {
        bindingIndex: 9,
        rows: 80,
        parameters: {
          'parameter:fast': 6,
          'parameter:slow': 10,
          'parameter:enabled': true,
        },
        outputs: {'output:0:0': 3.5, 'output:0:1': 'ready'},
        metrics: {'metric:0:0': 3.5},
      },
    ]);

    expect(sweepResultSection(result)).toEqual({
      title: 'Sweep Results',
      columns: [
        'binding',
        'rows',
        'fast',
        'slow',
        'enabled',
        'Metric',
        'Metric.note',
        'Metric',
      ],
      rows: [
        [7, 100, 5, 10, true, 'na', 'warmup', 12],
        [9, 80, 6, 10, true, 3.5, 'ready', ''],
      ],
    });
  });

  test('aligns reordered snapshots by binding identity', () => {
    const summary: ExecutionSummary = {
      backend: 'cpu',
      numericProfile: 'js-f64',
      bindings: [
        {
          bindingIndex: 7,
          rows: 1,
          inputs: [{spec: FAST, value: 5, active: true}],
        },
        {
          bindingIndex: 9,
          rows: 1,
          inputs: [{spec: FAST, value: 6, active: true}],
        },
      ],
      timing: {loweringMs: 0, executionMs: 0, totalMs: 0},
    };
    const snapshot = (
      bindingIndex: number,
      value: number,
    ): SweepReportSnapshot => ({
      bindingIndex,
      declaration,
      rows: 1,
      finalOutputs: [{row: 0, outputId: 0, channels: [value, 'ready']}],
    });

    const result = buildSweepResult(summary, [
      snapshot(9, 90),
      snapshot(7, 70),
    ]);
    expect(
      result.scenarios.map(scenario => scenario.outputs['output:0:0']),
    ).toEqual([70, 90]);
  });

  test('rejects duplicate, missing, row-mismatched, and schema-mismatched snapshots', () => {
    const summary: ExecutionSummary = {
      backend: 'cpu',
      numericProfile: 'js-f64',
      bindings: [
        {bindingIndex: 7, rows: 1, inputs: []},
        {bindingIndex: 9, rows: 1, inputs: []},
      ],
      timing: {loweringMs: 0, executionMs: 0, totalMs: 0},
    };
    const snapshot = (
      bindingIndex: number,
      overrides: Partial<SweepReportSnapshot> = {},
    ): SweepReportSnapshot => ({
      bindingIndex,
      declaration,
      rows: 1,
      finalOutputs: [],
      ...overrides,
    });

    expect(() => buildSweepResult(summary, [snapshot(7), snapshot(7)])).toThrow(
      'duplicate snapshot for binding 7',
    );
    expect(() =>
      buildSweepResult(summary, [snapshot(7), snapshot(11)]),
    ).toThrow('missing snapshot for binding 9');
    expect(() =>
      buildSweepResult(summary, [snapshot(7), snapshot(9, {rows: 2})]),
    ).toThrow('binding 9 has 2 snapshot rows for 1 execution rows');
    expect(() =>
      buildSweepResult(summary, [
        snapshot(7),
        snapshot(9, {declaration: {outputs: [], effects: []}}),
      ]),
    ).toThrow('binding 9 has a mismatched output schema');
  });

  test('fails closed when result snapshots do not align with bindings', () => {
    const summary: ExecutionSummary = {
      backend: 'cpu',
      numericProfile: 'js-f64',
      bindings: [{bindingIndex: 0, rows: 1, inputs: []}],
      timing: {loweringMs: 0, executionMs: 0, totalMs: 0},
    };
    expect(() => buildSweepResult(summary, [])).toThrow(
      'sweep report has 0 snapshots for 1 bindings',
    );
  });
});

function parameter(
  name: string,
  title: string | null,
  type: 'float' | 'int' | 'bool',
): ParamSpec {
  return {
    name,
    title,
    type,
    control: type,
    defaultValue: type === 'bool' ? true : 1,
    constraints: null,
    enumType: null,
    group: null,
    inline: null,
    tooltip: null,
    confirm: false,
    display: 'all',
    seriesSid: null,
  };
}
