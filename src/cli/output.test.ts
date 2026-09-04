// Purpose: CLI output keeps one deterministic human report and machine trace.

import {describe, expect, test} from 'vitest';
import type {EffectValue, ExecutionDeclaration} from '../runtime/abi';
import {renderRunReport, traceDatum, traceDeclaration} from './output';

const declaration: ExecutionDeclaration = {
  outputs: [
    {
      spec: {
        effect: 'plot',
        staticArgs: [{name: 'title', value: 'Equity'}],
        channels: [{name: 'series', type: 'float', transport: {kind: 'float'}}],
      },
      boundArgs: [{name: 'display', value: 'all'}],
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
          {name: 'side', value: {kind: 'string'}},
        ],
      },
    },
  ],
};

const payload: EffectValue = {kind: 'struct', fields: [7, 'buy']};

describe('CLI output', () => {
  test('renders the stable machine trace', () => {
    expect(traceDeclaration(declaration)).toEqual([
      '# output[0] plot title=Equity bound{display=all}',
      '# effect[0] type=broker.FillExecuted',
    ]);
    expect(
      traceDatum({
        index: 1,
        outputs: [{outputId: 0, channels: [NaN]}],
        effects: [{effectId: 0, payload}],
        provisional: true,
      }),
    ).toEqual([
      '1 0 ? na',
      '1 effect[0] ? {"kind":"struct","fields":[7,"buy"]}',
    ]);
  });

  test('renders only final values in the human report', () => {
    const report = renderRunReport(
      declaration,
      [
        {
          index: 0,
          outputs: [{outputId: 0, channels: [10]}],
          effects: [{effectId: 0, payload}],
          provisional: true,
        },
        {
          index: 0,
          outputs: [{outputId: 0, channels: [11]}],
          effects: [{effectId: 0, payload}],
          provisional: false,
        },
      ],
      [],
      {indices: 1, compilationMs: 1.25, executionMs: 4},
    );

    expect(report).toContain('compilation  1.25 ms');
    expect(report).toContain('execution    4.00 ms');
    expect(report).toMatch(/^0      11$/m);
    expect(report).toContain('{"id":7,"side":"buy"}');
    expect(report).not.toMatch(/^0      10$/m);
  });
});
