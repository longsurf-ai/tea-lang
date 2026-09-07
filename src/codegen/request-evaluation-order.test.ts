// Purpose: Request context lowering preserves the Program-owned source order while assembling the canonical symbol/timeframe ABI pair.

import {describe, expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {loadModule} from '../runtime/load';
import {generate} from './codegen';

describe('request context evaluation order', () => {
  test('publishes a fully static request context beside its module', () => {
    const program = mustBuild(
      [
        'd = request.security(',
        '    timeframe = "TIMEFRAME_SENTINEL",',
        '    expression = close,',
        '    symbol = "SYMBOL_SENTINEL")',
        'emit "output0" d',
      ].join('\n'),
    );
    const js = generate(program);
    const module = loadModule(js);

    expect(module.requests[0].context).toEqual({
      symbol: 'SYMBOL_SENTINEL',
      timeframe: 'TIMEFRAME_SENTINEL',
      fill: 'carry',
      ignoreInvalidSymbol: false,
      calcBarsCount: 0,
    });
    expect(js).not.toContain('module.requests[0].context =');
  });

  test('publishes named scalar and collect result values', () => {
    const module = loadModule(
      generate(
        mustBuild(
          [
            'scalar = request.security("X", "D", close)',
            'window = request.security_lower_tf("X", "1", close)',
            'emit "output0" scalar + window.size()',
          ].join('\n'),
        ),
      ),
    );

    expect(module.requests).toMatchObject([
      {
        name: 'scalar',
        mode: 'sample',
      },
      {
        name: 'window',
        mode: 'collect',
      },
    ]);
    const scalar = module.requests[0]!;
    expect(scalar.empty.sameType(scalar.resultEmpty)).toBe(true);
    const window = module.requests[1]!;
    expect(window.empty.kind).toBe('array');
    expect(window.empty.element?.sameType(window.resultEmpty)).toBe(true);
  });

  test('binds every option once in its independent source order', () => {
    const program = mustBuild(
      [
        'count = input.int(7)',
        'ignore = input.bool(true)',
        'fillValue = input.string("sparse")',
        'd = request.security(',
        '    calc_bars_count = count,',
        '    timeframe = "TIMEFRAME_SENTINEL",',
        '    expression = close,',
        '    ignore_invalid_symbol = ignore,',
        '    symbol = "SYMBOL_SENTINEL",',
        '    fill = fillValue)',
        'emit "output0" d',
      ].join('\n'),
    );
    const edge = program.requests[0];
    expect(edge.optionArgumentEvaluationOrder).toEqual([2, 1, 0]);
    expect(edge.contextArgumentEvaluationOrder).toEqual([1, 0]);

    const js = generate(program);
    const binding = js.slice(js.lastIndexOf('(module, contextConstants) =>'));
    const assignment = binding.match(
      /module\.requests\[0\]\.context = \{\s*symbol: \((t\d+)\)\.value!, timeframe: \((t\d+)\)\.value!, fill: \((t\d+)\)\.value as "carry" \| "sparse", ignoreInvalidSymbol: \((t\d+)\)\.value, calcBarsCount: \((t\d+)\)\.value\s*\};/,
    );
    expect(assignment).not.toBeNull();
    if (assignment === null) {
      return;
    }
    const [, , , fill, ignoreInvalidSymbol, calcBarsCount] = assignment;
    const captures = [calcBarsCount, ignoreInvalidSymbol, fill].map(temp =>
      binding.indexOf(`const ${temp} =`),
    );
    expect(captures.every(index => index >= 0)).toBe(true);
    expect(captures).toEqual([...captures].sort((a, b) => a - b));

    const symbolCapture = binding.indexOf('"SYMBOL_SENTINEL"');
    const optionCapture = Math.max(...captures);
    const assignmentIndex = binding.indexOf('module.requests[0].context = {');
    expect(symbolCapture).toBeGreaterThan(optionCapture);
    expect(assignmentIndex).toBeGreaterThan(symbolCapture);

    const module = loadModule(js);
    expect(module.requests[0].mode).toBe('sample');
  });

  test('evaluates a root Simple alias before binding request options', () => {
    const program = mustBuild(
      [
        'contextFill = syminfo.type == "stock" ? "sparse" : "carry"',
        'd = request.security("X", "D", close, fill = contextFill)',
        'emit "output0" d',
      ].join('\n'),
    );

    const js = generate(program);
    const rootBind = js.lastIndexOf('(module, contextConstants) =>');
    const bind = js.slice(rootBind);
    const executionRead = bind.indexOf(
      'contextValue(contextConstants, 0, "syminfo.type")',
    );
    const optionCall = bind.indexOf('module.requests[0].context = {');
    expect(executionRead).toBeGreaterThanOrEqual(0);
    expect(optionCall).toBeGreaterThan(executionRead);

    const module = loadModule(js);
    expect(module.inputs.builtins).toMatchObject([
      {source: {domain: 'syminfo', field: 'type'}},
    ]);
  });

  test('rejects a malformed request context schedule at codegen', () => {
    const valid = mustBuild(
      [
        'd = request.security(symbol = "X", timeframe = "D", expression = close)',
        'emit "output0" d',
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
        'emit "output0" d',
      ].join('\n'),
    );
    const invalidEdge = valid.requests[0] as unknown as {
      optionArgumentEvaluationOrder: number[];
    };
    invalidEdge.optionArgumentEvaluationOrder = [0, 0, 2];

    expect(() => generate(valid)).toThrow(
      'request options has an invalid argument evaluation order',
    );
  });
});

test('binding computes history retained by the parent request result', () => {
  const initial = loadModule(
    generate(
      mustBuild(
        [
          'length = input.int(2, minval=0)',
          'remote = request.security("X", "D", close)',
          'emit "output0" remote[length]',
        ].join('\n'),
      ),
    ),
  );
  const first = initial.bind({length: 3});
  expect(first.requests[0].depth).toEqual({kind: 'const', bars: 3});
  const second = first.bind({length: 7});
  expect(second).toBe(first);
  expect(second.requests[0].depth).toEqual({kind: 'const', bars: 7});
  expect(second.requests[0].module.parameters[0].value).toBe(7);
});
