// Purpose: Request context lowering preserves the Program-owned source order while assembling the canonical symbol/timeframe ABI pair.

import {describe, expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {loadModule} from '../runtime/load';
import {generate} from './codegen';

describe('request context evaluation order', () => {
  test('publishes a fully static request context directly in the manifest', () => {
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
    const module = loadModule(js);

    expect(module.manifest.requests[0].context).toEqual({
      symbol: 'SYMBOL_SENTINEL',
      timeframe: 'TIMEFRAME_SENTINEL',
      gaps: false,
      lookahead: false,
      ignoreInvalidSymbol: false,
      calcBarsCount: 0,
    });
    expect(js).not.toContain('manifest.requests[0].context =');
  });

  test('publishes named scalar and collect result layouts', () => {
    const module = loadModule(
      generate(
        mustBuild(
          [
            'scalar = request.security("X", "D", close)',
            'window = request.security_lower_tf("X", "1", close)',
            'plot(scalar + window.size())',
          ].join('\n'),
        ),
      ),
    );

    expect(module.manifest.requests).toMatchObject([
      {
        name: 'scalar',
        merge: {mode: 'sample'},
        resultLayout: module.manifest.requests[0]!.layout,
      },
      {
        name: 'window',
        merge: {mode: 'collect'},
      },
    ]);
    const window = module.manifest.requests[1]!;
    expect(module.layout[window.layout]).toEqual({
      kind: 'array',
      element: window.resultLayout,
    });
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
    const concretize = js.slice(js.lastIndexOf('concretize(manifest'));
    const assignment = concretize.match(
      /manifest\.requests\[0\]\.context = \{symbol: \((t\d+)\), timeframe: \((t\d+)\), gaps: \((t\d+)\), lookahead: \((t\d+)\), ignoreInvalidSymbol: \((t\d+)\), calcBarsCount: \((t\d+)\)\};/,
    );
    expect(assignment).not.toBeNull();
    if (assignment === null) {
      return;
    }
    const [, , , gaps, lookahead, ignoreInvalidSymbol, calcBarsCount] =
      assignment;
    const captures = [calcBarsCount, lookahead, ignoreInvalidSymbol, gaps].map(
      temp => concretize.indexOf(`const ${temp} =`),
    );
    expect(captures.every(index => index >= 0)).toBe(true);
    expect(captures).toEqual([...captures].sort((a, b) => a - b));

    const symbolCapture = concretize.indexOf('"SYMBOL_SENTINEL"');
    const optionCapture = Math.max(...captures);
    const assignmentIndex = concretize.indexOf(
      'manifest.requests[0].context =',
    );
    expect(symbolCapture).toBeGreaterThan(optionCapture);
    expect(assignmentIndex).toBeGreaterThan(symbolCapture);

    const module = loadModule(js);
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
    const rootBind = js.lastIndexOf('concretize(manifest');
    const bind = js.slice(rootBind, js.indexOf('funcs:', rootBind));
    const executionRead = bind.indexOf(
      '$contextValue(contextConstants, 0, "syminfo.type")',
    );
    const optionCall = bind.indexOf('manifest.requests[0].context =');
    expect(executionRead).toBeGreaterThanOrEqual(0);
    expect(optionCall).toBeGreaterThan(executionRead);

    const module = loadModule(js);
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
