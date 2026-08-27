// Purpose: Run reports retain complete final output and typed effects.

import {describe, expect, test} from 'vitest';
import type {EffectValue, ExecutionDeclaration} from '../runtime/abi';
import {RunReportSink} from './report-sink';

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
          {name: 'id', value: {kind: 'int'}},
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
};

const payload: EffectValue = {kind: 'struct', fields: [7, 'buy']};

describe('RunReportSink', () => {
  test('reports every final index and logical typed effect', () => {
    const sink = new RunReportSink();
    sink.declare(declaration);
    sink.publish({
      index: 0,
      time: 100,
      outputs: [{outputId: 0, channels: [10]}],
      effects: [{effectId: 0, payload}],
      provisional: true,
    });
    sink.publish({
      index: 0,
      time: 101,
      outputs: [{outputId: 0, channels: [11]}],
      effects: [{effectId: 0, payload}],
      provisional: false,
    });
    sink.publish({
      index: 1,
      time: 200,
      outputs: [{outputId: 0, channels: [12]}],
      effects: [],
      provisional: false,
    });

    expect(sink.denseSection()).toEqual({
      title: 'Outputs',
      columns: ['index', 'Equity'],
      rows: [
        [0, 11],
        [1, 12],
      ],
    });
    expect(sink.effectsSection()).toEqual({
      title: 'Effects',
      columns: ['index', 'effect', 'payload'],
      rows: [[0, 'effect[0] broker.FillExecuted', '{"id":7,"side":"buy"}']],
    });
  });
});
