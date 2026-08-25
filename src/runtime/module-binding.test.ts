// Purpose: Concrete-manifest binding resolves only late scalar facts and
// freezes each immutable module snapshot without a second runtime evaluator.

import {describe, expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {loadModule} from './load';
import {configureModule} from './module-binding';

describe('generated manifest concretization', () => {
  test('writes parameter-dependent depth, activity, and output arguments', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = input.int(3)\nlevel = input.float(10)\nhline(level)\nplot(close[length])',
        ),
      ),
    );

    const configured = configureModule(module, [4, 25]);

    expect('init' in module).toBe(false);
    expect(configured.manifest.series[0]?.depth).toEqual({
      kind: 'const',
      bars: 4,
    });
    expect(configured.manifest.params.map(param => param.active)).toEqual([
      true,
      true,
    ]);
    expect(configured.manifest.outputs[0]?.boundArgs).toEqual([
      {name: 'price', value: 25},
    ]);
    expect(Object.isFrozen(configured)).toBe(true);
    expect(Object.isFrozen(configured.manifest)).toBe(true);
    expect(module.manifest.series[0]?.depth).toEqual({kind: 'bound'});
  });

  test('preserves sparse provider builtin visibility', () => {
    const module = loadModule(
      generate(mustBuild('length = timeframe.multiplier\nplot(close[length])')),
    );

    expect(() => configureModule(module, [])).toThrow(
      "builtin 'timeframe.multiplier' is not bind-visible",
    );
    expect(
      configureModule(module, [], new Map([[0, 7]])).manifest.series[0]
        ?.depth,
    ).toEqual({kind: 'const', bars: 7});
  });

  test('request children receive compilation-global parameter values', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = input.int(3)\nvalue = request.security("X", "D", close[length])\nplot(value)',
        ),
      ),
    );

    const configured = configureModule(module, [6]);
    const child = configured.requests[0]!;

    expect(child.manifest.params.map(param => param.value)).toEqual([6]);
    expect(child.manifest.params.every(param => param.bindable === false)).toBe(
      true,
    );
    expect(child.manifest.series[0]?.depth).toEqual({
      kind: 'const',
      bars: 6,
    });
  });
});
