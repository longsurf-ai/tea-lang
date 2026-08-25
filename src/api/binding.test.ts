// Purpose: Public binding extraction separates recursive external inputs from
// dense output channels without imposing physical clock alignment.

import {describe, expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {extract} from './binding';

describe('extract bindings', () => {
  test('returns input and output groups in deterministic Program order', () => {
    const [inputs, outputs] = extract(mustBuild('plot(close + open)'));

    expect(inputs.map(binding => binding.name)).toEqual(['close', 'open']);
    expect(inputs.map(binding => binding.kind)).toEqual(['series', 'series']);
    expect(outputs.map(binding => binding.name)).toEqual(['plot[0]']);
    expect(outputs[0].kind).toBe('series');
    expect(inputs.every(binding => binding.type.safeParse(1.5).success)).toBe(
      true,
    );
    expect(outputs[0].type.safeParse(Number.NaN).success).toBe(true);
  });

  test('includes declared parameters as distinct binding targets', () => {
    const [inputs] = extract(
      mustBuild(
        [
          'length = input.int(14)',
          'enabled = input.bool(true)',
          'source = input.source(close)',
          'plot(enabled ? ta.sma(source, length) : source)',
        ].join('\n'),
      ),
    );

    expect(inputs.map(({kind, name}) => ({kind, name}))).toEqual([
      {kind: 'parameter', name: 'length'},
      {kind: 'parameter', name: 'enabled'},
      {kind: 'parameter', name: 'source'},
      {kind: 'series', name: 'close'},
    ]);
    expect(inputs[0].type.safeParse(20).success).toBe(true);
    expect(inputs[0].type.safeParse(20.5).success).toBe(false);
    expect(inputs[1].type.safeParse(true).success).toBe(true);
    expect(inputs[1].type.safeParse(1).success).toBe(false);
  });

  test('leaves request-child requirements to TeaNode request wiring', () => {
    const [inputs, outputs] = extract(
      mustBuild(
        [
          'daily = request.security("STOCK:NVDA", "D", close + open)',
          'plot(daily)',
        ].join('\n'),
      ),
    );

    expect(inputs).toEqual([]);
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

    expect(inputs.map(({kind, name}) => ({kind, name}))).toEqual([
      {kind: 'parameter', name: 'symbol'},
      {kind: 'parameter', name: 'period'},
    ]);
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
