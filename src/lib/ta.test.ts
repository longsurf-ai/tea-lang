// Purpose: Pin Pine-compatible Wilder seeding for RMA and the public
// indicators that depend on it.

import {describe, expect, test} from 'bun:test';
import {executeProgram} from '../execute';
import {mustBuild} from '../noder/testing';
import {csvProvider} from '../providers/data/csv';
import {MemorySink} from '../providers/sinks/memory-sink';

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

describe('ta Wilder indicators', () => {
  test('SMA-seeds RMA, ATR, RSI, and DMI from the required samples', async () => {
    const program = mustBuild(
      [
        'indicator("Wilder seed")',
        'average = ta.rma(close, 3)',
        'range = ta.atr(3)',
        'strength = ta.rsi(close, 3)',
        '[plus, minus, adx] = ta.dmi(3, 3)',
        'plot(average, "RMA")',
        'plot(range, "ATR")',
        'plot(strength, "RSI")',
        'plot(plus, "+DI")',
        'plot(minus, "-DI")',
        'plot(adx, "ADX")',
      ].join('\n'),
    );
    const sink = new MemorySink();
    await executeProgram(
      program,
      [
        {
          params: {},
          provider: csvProvider(DATA),
          sink,
          timeNow: 1_800_000_000_000,
        },
      ],
      {kind: 'cpu'},
    );

    const values = (outputId: number): number[] =>
      sink.emissions
        .filter(emission => emission.outputId === outputId)
        .map(emission => emission.channels[0] as number);
    const finiteAt = (outputId: number, row: number, expected: number): void =>
      expect(values(outputId)[row]).toBeCloseTo(expected, 12);

    expect(values(1).slice(0, 2).every(Number.isNaN)).toBe(true);
    finiteAt(1, 2, 10);
    finiteAt(1, 7, 12.292181069958849);

    expect(values(2).slice(0, 2).every(Number.isNaN)).toBe(true);
    finiteAt(2, 2, 3);
    finiteAt(2, 7, 5.053497942386831);

    expect(values(3).slice(0, 3).every(Number.isNaN)).toBe(true);
    finiteAt(3, 3, 80);
    finiteAt(3, 7, 68.10073452256033);

    expect(values(4).slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(values(5).slice(0, 2).every(Number.isNaN)).toBe(true);
    finiteAt(4, 2, 22.222222222222218);
    finiteAt(5, 2, 22.222222222222218);
    expect(values(6).slice(0, 4).every(Number.isNaN)).toBe(true);
    finiteAt(6, 4, 16.988416988416986);
    finiteAt(6, 7, 36.30022485980952);
  });
});
