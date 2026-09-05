// Purpose: CLI output keeps one deterministic human report and machine trace.

import {Field, Float64, Schema, Struct, Utf8} from 'apache-arrow';
import {outputSchema} from '../runtime/output';
import {describe, expect, test} from 'vitest';
import type {ExecutionDeclaration} from '../runtime/abi';
import {renderRunReport, traceDatum, traceDeclaration} from './output';

const declaration: ExecutionDeclaration = {
  get schema(): Schema {
    return outputSchema(
      this.outputs.map(output => output.spec),
      this.effects,
    );
  },
  outputs: [
    {
      spec: {
        effect: 'plot',
        staticArgs: [{name: 'title', value: 'Equity'}],
        channels: [new Field('series', new Float64(), true)],
      },
      boundArgs: [{name: 'display', value: 'all'}],
    },
  ],
  effects: [
    {
      payload: new Field(
        'payload',
        new Struct([
          new Field('id', new Float64()),
          new Field('side', new Utf8()),
        ]),
        true,
        new Map([['tea:typeId', 'broker.FillExecuted']]),
      ),
    },
  ],
};

const payload = {id: 7, side: 'buy'};

describe('CLI output', () => {
  test('renders the stable machine trace', () => {
    expect(traceDeclaration(declaration)).toEqual([
      '# output[0] plot title=Equity bound{display=all}',
      '# effect[0] type=broker.FillExecuted',
    ]);
    expect(
      traceDatum({
        index: 1,
        timed: false,
        output0: {series: NaN},
        effect0: [{ordinal: 0, payload}],
        provisional: true,
      }),
    ).toEqual(['1 0 ? na', '1 effect[0] ? {"id":7,"side":"buy"}']);
  });

  test('preserves cross-declaration order, absent outputs and nested Arrow values', () => {
    expect(
      traceDatum({
        index: 3,
        timed: false,
        provisional: false,
        output0: null,
        output1: {values: [null, NaN], binary: new Uint8Array([0, 255])},
        effect0: [{ordinal: 1, payload: {value: NaN}}],
        effect1: [{ordinal: 0, payload: new Map([['x', 2]])}],
      }),
    ).toEqual([
      '3 1 [null,"na"] [0,255]',
      '3 effect[1] [["x",2]]',
      '3 effect[0] {"value":"na"}',
    ]);
  });

  test('renders only final values in the human report', () => {
    const report = renderRunReport(
      declaration,
      [
        {
          index: 0,
          timed: false,
          output0: {series: 10},
          effect0: [{ordinal: 0, payload}],
          provisional: true,
        },
        {
          index: 0,
          timed: false,
          output0: {series: 11},
          effect0: [{ordinal: 0, payload}],
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
