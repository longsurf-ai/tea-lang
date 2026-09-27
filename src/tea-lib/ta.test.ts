// Purpose: Pin numerical contracts for Tea-authored statistics and indicators.

import {describe, expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {arrayStream, csvStream, executeTestProgram} from '../testing/batch';
import {OutputCapture} from '../testing/output';

const DATA = [
  'time,open,high,low,close',
  '1,9,10,8,9',
  '2,10,12,9,11',
  '3,10,11,7,10',
  '4,10,13,9,12',
  '5,12,12,8,9',
  '6,10,15,10,14',
  '7,14,14,9,10',
  '8,11,16,11,15',
  '',
].join('\n');

describe('ta variance', () => {
  test.each([
    {
      name: 'constant decimal window',
      values: Array(22).fill(1.2),
      length: 20,
      population: 0,
      sample: 0,
    },
    {
      name: 'small spread at a large offset',
      values: [1e12, 1e12, 1e12 + 0.125],
      length: 3,
      population: 1 / 288,
      sample: 1 / 192,
    },
    {
      name: 'population singleton',
      values: [1.2],
      length: 1,
      population: 0,
      sample: NaN,
    },
    {
      name: 'missing value in window',
      values: [1.2, NaN, 1.2],
      length: 3,
      population: NaN,
      sample: NaN,
    },
    {
      name: 'recovery after missing value leaves window',
      values: [NaN, 1.2, 1.2, 1.2],
      length: 3,
      population: 0,
      sample: 0,
    },
  ])('$name', async ({values, length, population, sample}) => {
    const program = mustBuild(
      [
        `emit "population" ta.variance(close, ${length}, true)`,
        `emit "sample" ta.variance(close, ${length}, false)`,
        `emit "stdev" ta.stdev(close, ${length}, true)`,
      ].join('\n'),
    );
    const sink = new OutputCapture();
    await executeTestProgram(program, {
      stream: arrayStream({close: values}),
      sink,
    });
    for (const [outputId, expected] of [
      population,
      sample,
      Math.sqrt(population),
    ].entries()) {
      const results = sink.emissions
        .filter(value => value.outputId === outputId)
        .map(value => value.channels[0] as number);
      expect(results.slice(0, length - 1).every(Number.isNaN)).toBe(true);
      const actual = results.at(-1);
      if (Number.isNaN(expected)) expect(actual).toBeNaN();
      else if (expected === 0) expect(actual).toBe(0);
      else expect(actual).toBeCloseTo(expected, 12);
    }
  });
});

describe('ta Wilder indicators', () => {
  test('SMA-seeds RMA, ATR, RSI, and DMI from the required samples', async () => {
    const program = mustBuild(
      [
        'average = ta.rma(close, 3)',
        'range = ta.atr(3)',
        'strength = ta.rsi(close, 3)',
        '[plus, minus, adx] = ta.dmi(3, 3)',
        'emit "RMA" average',
        'emit "ATR" range',
        'emit "RSI" strength',
        'emit "+DI" plus',
        'emit "-DI" minus',
        'emit "ADX" adx',
      ].join('\n'),
    );
    const sink = new OutputCapture();
    await executeTestProgram(program, {
      stream: csvStream(DATA),
      sink,
      timeNow: 1_800_000_000_000,
    });

    const values = (outputId: number): number[] =>
      sink.emissions
        .filter(emission => emission.outputId === outputId)
        .map(emission => emission.channels[0] as number);
    const finiteAt = (outputId: number, row: number, expected: number): void =>
      expect(values(outputId)[row]).toBeCloseTo(expected, 12);

    expect(values(0).slice(0, 2).every(Number.isNaN)).toBe(true);
    finiteAt(0, 2, 10);
    finiteAt(0, 7, 12.292181069958849);

    expect(values(1).slice(0, 2).every(Number.isNaN)).toBe(true);
    finiteAt(1, 2, 3);
    finiteAt(1, 7, 5.053497942386831);

    expect(values(2).slice(0, 3).every(Number.isNaN)).toBe(true);
    finiteAt(2, 3, 80);
    finiteAt(2, 7, 68.10073452256033);

    expect(values(3).slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(values(4).slice(0, 2).every(Number.isNaN)).toBe(true);
    finiteAt(3, 2, 22.222222222222218);
    finiteAt(4, 2, 22.222222222222218);
    expect(values(5).slice(0, 4).every(Number.isNaN)).toBe(true);
    finiteAt(5, 4, 16.988416988416986);
    finiteAt(5, 7, 36.30022485980952);
  });
});
