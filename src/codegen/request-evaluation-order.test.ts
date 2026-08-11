// Purpose: Request context lowering preserves the Program-owned source order while assembling the canonical symbol/timeframe ABI pair.

import {describe, expect, test} from 'bun:test';
import {DEFAULT_COMPILE_CONFIG} from '../base/config';
import {Errors} from '../base/print';
import {mustBuild} from '../noder/testing';
import {generate} from './codegen';

describe('request context evaluation order', () => {
  test('static bind captures named context arguments in source order', () => {
    const program = mustBuild(
      [
        'd = request.security(',
        '    timeframe = "TIMEFRAME_SENTINEL",',
        '    expression = close,',
        '    symbol = "SYMBOL_SENTINEL")',
        'plot(d)',
      ].join('\n'),
    );
    const js = generate(program, DEFAULT_COMPILE_CONFIG, new Errors());
    const bind = js.indexOf('bind(rt, fr)');
    const timeframe = js.indexOf('"TIMEFRAME_SENTINEL"', bind);
    const symbol = js.indexOf('"SYMBOL_SENTINEL"', bind);

    expect(bind).toBeGreaterThanOrEqual(0);
    expect(timeframe).toBeGreaterThan(bind);
    expect(symbol).toBeGreaterThan(timeframe);
    const bindSource = js.slice(bind);
    const timeframeTemp = bindSource.match(
      /const (t\d+) = \("TIMEFRAME_SENTINEL"\);/,
    )?.[1];
    const symbolTemp = bindSource.match(
      /const (t\d+) = \("SYMBOL_SENTINEL"\);/,
    )?.[1];
    expect(timeframeTemp).toBeDefined();
    expect(symbolTemp).toBeDefined();
    expect(bindSource).toContain(
      `rt.bindRequest(0, (${symbolTemp}), (${timeframeTemp}));`,
    );
  });

  test('rejects a malformed request context schedule at codegen', () => {
    const valid = mustBuild(
      [
        'd = request.security(symbol = "X", timeframe = "D", expression = close)',
        'plot(d)',
      ].join('\n'),
    );
    const invalidEdge = valid.requests[0] as unknown as {
      contextArgumentEvaluationOrder: number[];
    };
    invalidEdge.contextArgumentEvaluationOrder = [0, 0];

    expect(() => generate(valid, DEFAULT_COMPILE_CONFIG, new Errors())).toThrow(
      'request context has an invalid argument evaluation order',
    );
  });
});
