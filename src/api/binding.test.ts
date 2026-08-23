// Purpose: Public binding extraction separates recursive external inputs from
// dense output channels without imposing physical clock alignment.

import {describe, expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {extract} from './binding';

describe('extract bindings', () => {
  test('returns input and output groups in deterministic Program order', () => {
    const [inputs, outputs] = extract(mustBuild('plot(close + open)'));

    expect(inputs.map(binding => binding.name)).toEqual(['close', 'open']);
    expect(outputs.map(binding => binding.name)).toEqual(['plot[0]']);
    expect(inputs.every(binding => binding.type.safeParse(1.5).success)).toBe(
      true,
    );
    expect(outputs[0].type.safeParse(Number.NaN).success).toBe(true);
  });

  test('nests requested-context inputs without assigning clocks', () => {
    const [inputs, outputs] = extract(
      mustBuild(
        [
          'daily = request.security("STOCK:NVDA", "D", close + open)',
          'plot(daily)',
        ].join('\n'),
      ),
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty('clock');
    expect(inputs[0].name).toBe('STOCK:NVDA');
    expect(inputs[0].children?.map(binding => binding.name)).toEqual([
      'close',
      'open',
    ]);
    expect(inputs[0].children?.every(binding => !('clock' in binding))).toBe(
      true,
    );
    expect(outputs.map(binding => binding.name)).toEqual(['plot[0]']);
  });

  test('keeps bind-time request identities stable without reading timeframe strings', () => {
    const [inputs] = extract(
      mustBuild(
        [
          'symbol = input.symbol("AAPL")',
          'period = input.timeframe("D")',
          'x = request.security(symbol, period, close)',
          'plot(x)',
        ].join('\n'),
      ),
    );

    expect(inputs[0].name).toMatch(/^request@\d+:\d+$/);
    expect(inputs[0].children?.map(binding => binding.name)).toEqual(['close']);
  });

  test('omits declaration-only outputs and exposes emitted channels', () => {
    const [inputs, outputs] = extract(
      mustBuild(
        [
          'indicator("Outputs")',
          'p1 = plot(high, "High")',
          'p2 = plot(low, "Low")',
          'fill(p1, p2)',
          'hline(0, "Zero")',
          'mid = math.avg(high, low)',
          'plotshape(close > mid)',
        ].join('\n'),
      ),
    );

    expect(inputs.map(binding => binding.name)).toEqual([
      'high',
      'low',
      'close',
    ]);
    expect(outputs.map(binding => binding.name)).toEqual([
      'plot[1]',
      'plot[2]',
      'plotshape[5]',
    ]);
    expect(outputs[0].type.safeParse(1.5).success).toBe(true);
    expect(outputs[2].type.safeParse(true).success).toBe(true);
    expect(outputs[2].type.safeParse(1).success).toBe(false);
  });

  test('qualifies every channel of a multi-channel output', () => {
    const [, outputs] = extract(
      mustBuild(
        [
          'tone = close > open ? color.green : color.red',
          'plot(close, "Price", color=tone)',
        ].join('\n'),
      ),
    );

    expect(outputs.map(binding => binding.name)).toEqual([
      'plot[0].series',
      'plot[0].color',
    ]);
    expect(outputs[0].type.safeParse(10).success).toBe(true);
    expect(outputs[1].type.safeParse('#00FF00').success).toBe(true);
  });
});
