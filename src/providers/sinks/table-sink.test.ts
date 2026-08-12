// Purpose: TableSink presentation — headers from plot titles, preamble for channel-less outputs.

import {describe, expect, test} from 'bun:test';
import type {OutputSpec} from '../../runtime/abi';
import {TableSink} from './table-sink';

function spec(
  effect: string,
  staticArgs: OutputSpec['staticArgs'],
  channels: OutputSpec['channels'],
): OutputSpec {
  return {effect, staticArgs, channels};
}

describe('TableSink', () => {
  test('prints a headed table and a preamble for channel-less outputs', () => {
    const chunks: string[] = [];
    const sink = new TableSink(text => chunks.push(text));
    sink.declare({outputs: [
      {
        spec: spec(
          'indicator',
          [
            {name: 'title', value: 'MACD'},
            {name: 'shorttitle', value: 'MACD'},
          ],
          [],
        ),
        boundArgs: [],
      },
      {
        spec: spec(
          'plot',
          [{name: 'title', value: 'Histogram'}],
          [
            {name: 'series', type: 'float', transport: {kind: 'float'}},
            {name: 'color', type: 'color', transport: {kind: 'color'}},
          ],
        ),
        boundArgs: [],
      },
      {
        spec: spec(
          'plot',
          [{name: 'title', value: 'MACD'}],
          [{name: 'series', type: 'float', transport: {kind: 'float'}}],
        ),
        boundArgs: [],
      },
    ], effects: []});
    sink.publish({
      row: 0,
      outputs: [
        {outputId: 1, channels: [0, '#B2DFDB']},
        {outputId: 2, channels: [0]},
      ],
      effects: [],
      provisional: false,
    });
    sink.publish({
      row: 1,
      outputs: [
        {outputId: 1, channels: [0.5, '#26A69A']},
        {outputId: 2, channels: [0.6]},
      ],
      effects: [],
      provisional: false,
    });
    sink.flush();

    expect(chunks.join('\n')).toBe(
      [
        '# indicator[0]  title=MACD shorttitle=MACD',
        'row  Histogram  Histogram.color  MACD',
        '0    0          #B2DFDB          0',
        '1    0.5        #26A69A          0.6',
      ].join('\n'),
    );
  });
});
