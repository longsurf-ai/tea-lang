// Purpose: TraceSink locks the machine line format, including provisional and na.

import {describe, expect, test} from 'vitest';
import type {OutputSpec} from '../runtime/abi';
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
    sink.declare({
      outputs: [
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
          boundArgs: [{name: 'display', value: 'all'}],
        },
        {
          spec: spec(
            'plot',
            [{name: 'title', value: 'MACD'}],
            [{name: 'series', type: 'float', transport: {kind: 'float'}}],
          ),
          boundArgs: [],
        },
      ],
      effects: [],
    });
    sink.publish({
      index: 0,
      outputs: [
        {outputId: 1, channels: [NaN, '#B2DFDB']},
        {outputId: 2, channels: [0]},
      ],
      effects: [],
      provisional: false,
    });
    sink.publish({
      index: 1,
      outputs: [{outputId: 1, channels: [0.5, '#26A69A']}],
      effects: [],
      provisional: true,
    });
    sink.publish({
      index: 1,
      outputs: [{outputId: 2, channels: [0.6]}],
      effects: [],
      provisional: false,
    });

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

  test('declares sparse effects by logical type instead of physical layout', () => {
    const lines: string[] = [];
    const sink = new TraceSink(line => lines.push(line));
    sink.declare({
      outputs: [],
      effects: [
        {payload: {kind: 'float'}},
        {
          payload: {
            kind: 'struct',
            typeId: 'broker.FillExecuted',
            displayName: 'FillExecuted',
            fields: [],
          },
        },
      ],
    });

    expect(lines).toEqual([
      '# effect[0] type=float',
      '# effect[1] type=broker.FillExecuted',
    ]);
  });
});
