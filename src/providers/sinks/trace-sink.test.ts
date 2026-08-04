// Purpose: TraceSink presentation — locks the machine/golden line format at the owner (declare + emit, including provisional and na).

import {describe, expect, test} from 'bun:test';
import type {OutputSpec} from '../../runtime/abi';
import {TraceSink} from './trace-sink';

function spec(
  effect: string,
  staticArgs: OutputSpec['staticArgs'],
  channels: OutputSpec['channels'],
): OutputSpec {
  return {effect, staticArgs, channels};
}

describe('TraceSink', () => {
  test('prints one declare line per output and one emit line per channel write', () => {
    const lines: string[] = [];
    const sink = new TraceSink(line => lines.push(line));
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
        boundArgs: [{name: 'display', value: 'all'}],
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
    sink.emit(0, 1, [NaN, '#B2DFDB'], false);
    sink.emit(0, 2, [0], false);
    sink.emit(1, 1, [0.5, '#26A69A'], true);
    sink.emit(1, 2, [0.6], false);

    expect(lines).toEqual([
      '# output[0] indicator title=MACD shorttitle=MACD',
      '# output[1] plot title=Histogram bound{display=all}',
      '# output[2] plot title=MACD',
      '0 1 na #B2DFDB',
      '0 2 0',
      '1 1 ? 0.5 #26A69A',
      '1 2 0.6',
    ]);
  });
});
