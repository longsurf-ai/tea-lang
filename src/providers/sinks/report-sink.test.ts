// Purpose: Run reports retain complete final output while sweep reports remain history-size independent.

import {describe, expect, test} from 'bun:test';
import type {ExecutionSummary} from '../../execute';
import type {
  EffectValue,
  ExecutionDeclaration,
  OutputSink,
  ParamSpec,
} from '../../runtime/abi';
import {
  RunReportSink,
  SweepReportSink,
  composeOutputSinks,
  sweepReportSections,
} from './report-sink';

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
        kind: 'user-type',
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

const payload: EffectValue = {
  kind: 'user-type',
  fields: [7, 'buy'],
};

const SCALE: ParamSpec = {
  name: 'scale',
  title: null,
  type: 'float',
  control: 'float',
  defaultValue: 1,
  constraints: null,
  enumType: null,
  group: null,
  inline: null,
  tooltip: null,
  confirm: false,
  display: 'all',
  seriesSid: null,
};

describe('report sinks', () => {
  test('run collector reports every final row and logical typed effects', () => {
    const sink = new RunReportSink();
    sink.declare(declaration);
    sink.publish({
      row: 0,
      outputs: [{outputId: 0, channels: [10]}],
      effects: [{effectId: 0, payload}],
      provisional: true,
    });
    sink.publish({
      row: 0,
      outputs: [{outputId: 0, channels: [11]}],
      effects: [{effectId: 0, payload}],
      provisional: false,
    });
    sink.publish({
      row: 1,
      outputs: [{outputId: 0, channels: [12]}],
      effects: [],
      provisional: false,
    });

    expect(sink.denseSection()).toEqual({
      title: 'Dense Outputs',
      columns: ['row', 'Equity'],
      rows: [
        [0, 11],
        [1, 12],
      ],
    });
    expect(sink.effectsSection()).toEqual({
      title: 'Effects',
      columns: ['row', 'effect', 'payload'],
      rows: [[0, 'effect[0] broker.FillExecuted', '{"id":7,"side":"buy"}']],
    });
  });

  test('sweep collector retains only final channels and declines effects', () => {
    const sink = new SweepReportSink();
    expect(sink.capabilities).toEqual({denseRows: 'final', effects: 'none'});
    sink.declare(declaration);
    for (let row = 0; row < 10_000; row += 1) {
      sink.publish({
        row,
        outputs: [{outputId: 0, channels: [row]}],
        effects: [{effectId: 0, payload}],
        provisional: false,
      });
    }

    const snapshot = sink.snapshot(0);
    expect(snapshot.bindingIndex).toBe(0);
    expect(snapshot.rows).toBe(10_000);
    expect(snapshot.finalOutputs).toEqual([
      {row: 9_999, outputId: 0, channels: [9_999]},
    ]);

    const summary: ExecutionSummary = {
      backend: 'cpu',
      numericProfile: 'js-f64',
      bindings: [
        {
          bindingIndex: 0,
          rows: 10_000,
          inputs: [{spec: SCALE, value: 2, active: true}],
        },
      ],
      timing: {loweringMs: 1, executionMs: 2, totalMs: 3},
    };
    expect(sweepReportSections(summary, [sink])).toEqual([
      {
        title: 'Sweep Results',
        columns: ['binding', 'rows', 'scale', 'Equity'],
        rows: [[0, 10_000, 2, 9_999]],
      },
    ]);
  });

  test('composes ordinary sinks without changing the OutputSink protocol', () => {
    const calls: string[] = [];
    const child = (name: string): OutputSink => ({
      declare: () => calls.push(`${name}:declare`),
      publish: () => calls.push(`${name}:publish`),
    });
    const sink = composeOutputSinks(child('a'), child('b'));
    expect(sink.capabilities).toEqual({denseRows: 'all', effects: 'all'});
    sink.declare(declaration);
    sink.publish({row: 0, outputs: [], effects: [], provisional: false});

    expect(calls).toEqual(['a:declare', 'b:declare', 'a:publish', 'b:publish']);
  });

  test('composes final-dense requests only when every child requests them', () => {
    const final = (): OutputSink => ({
      capabilities: {denseRows: 'final', effects: 'none'},
      declare() {},
      publish() {},
    });
    const all: OutputSink = {declare() {}, publish() {}};

    expect(composeOutputSinks(final(), final()).capabilities).toEqual({
      denseRows: 'final',
      effects: 'none',
    });
    expect(composeOutputSinks(final(), all).capabilities).toEqual({
      denseRows: 'all',
      effects: 'all',
    });
    expect(composeOutputSinks().capabilities).toEqual({
      denseRows: 'all',
      effects: 'all',
    });
  });
});
