// Purpose: Request context lowering preserves the Program-owned source order while assembling the canonical symbol/timeframe ABI pair.

import {describe, expect, test} from 'vitest';
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
    const js = generate(program);
    const bind = js.lastIndexOf('bind(values)');
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

  test('binds every option once in its independent source order', () => {
    const program = mustBuild(
      [
        'count = input.int(7)',
        'look = input.bool(true)',
        'ignore = input.bool(true)',
        'gapsValue = input.bool(true)',
        'd = request.security(',
        '    calc_bars_count = count,',
        '    timeframe = "TIMEFRAME_SENTINEL",',
        '    lookahead = look,',
        '    expression = close,',
        '    ignore_invalid_symbol = ignore,',
        '    symbol = "SYMBOL_SENTINEL",',
        '    gaps = gapsValue)',
        'plot(d)',
      ].join('\n'),
    );
    const edge = program.requests[0];
    expect(edge.optionArgumentEvaluationOrder).toEqual([3, 1, 2, 0]);
    expect(edge.contextArgumentEvaluationOrder).toEqual([1, 0]);

    const js = generate(program);
    const bind = js.slice(js.lastIndexOf('bind(values)'));
    const optionCall = bind.match(
      /rt\.bindRequestOptions\(0, \((t\d+)\), \((t\d+)\), \((t\d+)\), \((t\d+)\)\);/,
    );
    expect(optionCall).not.toBeNull();
    if (optionCall === null) {
      return;
    }
    const [, gaps, lookahead, ignoreInvalidSymbol, calcBarsCount] = optionCall;
    const captures = [calcBarsCount, lookahead, ignoreInvalidSymbol, gaps].map(
      temp => bind.indexOf(`const ${temp} =`),
    );
    expect(captures.every(index => index >= 0)).toBe(true);
    expect(captures).toEqual([...captures].sort((a, b) => a - b));

    const optionCallIndex = bind.indexOf('rt.bindRequestOptions(0');
    const contextCallIndex = bind.indexOf('rt.bindRequest(0');
    expect(optionCallIndex).toBeGreaterThanOrEqual(0);
    expect(contextCallIndex).toBeGreaterThan(optionCallIndex);

    const module = new Function(js)() as {
      readonly manifest: {
        readonly requests: readonly {readonly merge: unknown}[];
      };
    };
    expect(module.manifest.requests[0].merge).toEqual({mode: 'sample'});
  });

  test('evaluates a root Simple alias before binding request options', () => {
    const program = mustBuild(
      [
        'contextGap = syminfo.type == "stock"',
        'd = request.security("X", "D", close, gaps = contextGap)',
        'plot(d)',
      ].join('\n'),
    );

    const js = generate(program);
    const rootBind = js.lastIndexOf('bind(values)');
    const bind = js.slice(rootBind, js.indexOf('funcs:', rootBind));
    const executionRead = bind.indexOf('rt.builtin(0, 0)');
    const optionCall = bind.indexOf('rt.bindRequestOptions(0,');
    expect(executionRead).toBeGreaterThanOrEqual(0);
    expect(optionCall).toBeGreaterThan(executionRead);

    const module = new Function(js)() as {
      readonly manifest: {
        readonly builtin: readonly {readonly source: unknown}[];
      };
    };
    expect(module.manifest.builtin).toMatchObject([
      {source: {domain: 'syminfo', field: 'type'}},
    ]);
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

    expect(() => generate(valid)).toThrow(
      'request context has an invalid argument evaluation order',
    );
  });

  test('rejects a malformed request option schedule at codegen', () => {
    const valid = mustBuild(
      [
        'd = request.security(symbol = "X", timeframe = "D", expression = close)',
        'plot(d)',
      ].join('\n'),
    );
    const invalidEdge = valid.requests[0] as unknown as {
      optionArgumentEvaluationOrder: number[];
    };
    invalidEdge.optionArgumentEvaluationOrder = [0, 0, 2, 3];

    expect(() => generate(valid)).toThrow(
      'request options has an invalid argument evaluation order',
    );
  });
});
