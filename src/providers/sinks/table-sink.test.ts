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
    sink.declare([
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
            {name: 'series', type: 'float'},
            {name: 'color', type: 'color'},
          ],
        ),
        boundArgs: [],
      },
      {
        spec: spec(
          'plot',
          [{name: 'title', value: 'MACD'}],
          [{name: 'series', type: 'float'}],
        ),
        boundArgs: [],
      },
    ]);
    sink.emit(0, 1, [0, '#B2DFDB'], false);
    sink.emit(0, 2, [0], false);
    sink.emit(1, 1, [0.5, '#26A69A'], false);
    sink.emit(1, 2, [0.6], false);
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
