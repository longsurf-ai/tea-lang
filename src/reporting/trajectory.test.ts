// Purpose: Full trajectory projection keeps stable output/effect ids and logical payloads.

import {describe, expect, test} from 'vitest';
import type {ExecutionBindingSummary} from '../execution/execute';
import type {ExecutionDeclaration} from '../runtime/abi';
import {
  buildTrajectoryResult,
  buildTrajectoryResultFromColumns,
} from './trajectory';

const declaration: ExecutionDeclaration = {
  outputs: [
    {
      spec: {
        effect: 'plot',
        staticArgs: [{name: 'title', value: 'Equity'}],
        channels: [{name: 'series', type: 'float', transport: {kind: 'float'}}],
      },
      boundArgs: [],
    },
  ],
  effects: [
    {
      payload: {
        kind: 'struct',
        typeId: 'broker.FillExecuted',
        displayName: 'FillExecuted',
        fields: [
          {
            name: 'fill',
            value: {
              kind: 'struct',
              typeId: 'broker.Fill',
              displayName: 'Fill',
              fields: [
                {name: 'barIndex', value: {kind: 'int'}},
                {
                  name: 'side',
                  value: {
                    kind: 'enum',
                    typeId: 'broker.Side',
                    displayName: 'Side',
                    members: [
                      {name: 'buy', title: 'buy'},
                      {name: 'sell', title: 'sell'},
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
};

const binding: ExecutionBindingSummary = {
  bindingIndex: 0,
  rows: 3,
  inputs: [
    {
      spec: {
        name: 'length',
        title: 'Length',
        type: 'int',
        control: 'int',
        defaultValue: 2,
        constraints: null,
        enumType: null,
        group: null,
        inline: null,
        tooltip: null,
        confirm: false,
        display: 'all',
        seriesSid: null,
      },
      value: 5,
      active: true,
    },
  ],
};

describe('trajectory result', () => {
  test('aligns rows and timestamps and decodes nominal effects by schema', () => {
    const result = buildTrajectoryResult(
      binding,
      {
        declaration,
        times: [100, 200, 300],
        denseOutputs: [
          {row: 0, outputId: 0, channels: [100]},
          {row: 2, outputId: 0, channels: [Number.NaN]},
        ],
        effects: [
          {
            row: 1,
            effectId: 0,
            payload: {
              kind: 'struct',
              fields: [{kind: 'struct', fields: [1, 'buy']}],
            },
          },
        ],
      },
      7,
    );

    expect(result.bindingIndex).toBe(7);
    expect(result.time).toEqual([100, 200, 300]);
    expect(result.parameters).toEqual([
      {
        id: 'parameter:length',
        name: 'length',
        label: 'Length',
        type: 'int',
        value: 5,
        active: true,
      },
    ]);
    expect(result.outputs).toEqual([
      {
        id: 'output:0:0',
        outputId: 0,
        channel: 0,
        label: 'Equity',
        type: 'float',
        values: [100, null, null],
      },
    ]);
    expect(result.effectSchemas[0]).toEqual({
      id: 'effect:0',
      effectId: 0,
      payload: declaration.effects[0]!.payload,
    });
    expect(result.effects).toEqual([
      {
        row: 1,
        effectId: 'effect:0',
        payload: {fill: {barIndex: 1, side: 'buy'}},
      },
    ]);
  });

  test('rejects output and effect rows outside the execution', () => {
    expect(() =>
      buildTrajectoryResult(binding, {
        declaration,
        times: [null, null, null],
        denseOutputs: [{row: 3, outputId: 0, channels: [1]}],
        effects: [],
      }),
    ).toThrow('outside trajectory length 3');
    expect(() =>
      buildTrajectoryResult(binding, {
        declaration,
        times: [100, 1.5, 300],
        denseOutputs: [],
        effects: [],
      }),
    ).toThrow('timestamp at row 1 is not a safe integer');
  });

  test('column builder preserves caller-owned aligned values and validates shape', () => {
    const values = [[1, null, 3]] as const;
    const result = buildTrajectoryResultFromColumns(binding, {
      declaration,
      times: [100, 200, 300],
      values,
      effects: [],
    });
    expect(result.outputs[0]!.values).toBe(values[0]);
    expect(result.time).toEqual([100, 200, 300]);
    expect(() =>
      buildTrajectoryResultFromColumns(binding, {
        declaration,
        times: [100, 200, 300],
        values: [],
        effects: [],
      }),
    ).toThrow('0 value columns for 1 declared columns');
  });
});
