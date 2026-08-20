// Purpose: Lock numeric range and core math lowering to Tea evaluation and
// nullable-value semantics without imposing an arbitrary GPU trip-count cap.

import {describe, expect, test} from 'vitest';
import {mustBuild} from '../../noder/testing';
import {compileProgramToWgsl} from './lower';

function compile(source: string) {
  const result = compileProgramToWgsl(mustBuild(source));
  expect(result.status).toBe('compiled');
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact;
}

describe('WGSL numeric ranges', () => {
  test('accepts compile-, bind-, and row-time bounds with both directions', () => {
    const artifact = compile(
      [
        'indicator("runtime ranges")',
        'limit = input.int(4)',
        'step = input.int(1)',
        'defaulted = for i = 0 to 2',
        '    i',
        'bound = for i = 0 to limit by step',
        '    if i == 1',
        '        i := 2',
        '        continue',
        '    if i == 3',
        '        break',
        '    i',
        'descending = for i = 2 to 0 by -1',
        '    i',
        'rowBound = for i = bar_index to bar_index',
        '    i',
        'plot(close + defaulted + bound + descending + rowBound)',
      ].join('\n'),
    );
    const source = artifact.module.source;

    expect(source.match(/for \(var range_index\d+:/g)).toHaveLength(4);
    expect(source).toContain('tea_range_advance_i32');
    expect(source).toContain('.value > 0');
    expect(source).toContain('.value < 0');
    expect(source).toContain('continue;');
    expect(source).toContain('break;');
    expect(source).not.toContain('range_iteration_limit');
  });

  test('keeps effect capacity analysis separate from loop eligibility', () => {
    const effectFree = compileProgramToWgsl(
      mustBuild(
        [
          'strategy("dynamic effect-free loop")',
          'var int total = 0',
          'for i = 0 to bar_index',
          '    total += i',
          'plot(close + total)',
        ].join('\n'),
      ),
    );
    expect(effectFree.status).toBe('compiled');

    const boundedEffect = compileProgramToWgsl(
      mustBuild(
        [
          'strategy("bounded effect loop")',
          'for i = 0 to 2',
          '    effect.emit(i)',
          'plot(close)',
        ].join('\n'),
      ),
    );
    expect(boundedEffect.status).toBe('compiled');

    const dynamicEffect = compileProgramToWgsl(
      mustBuild(
        [
          'strategy("dynamic effect loop")',
          'for i = 0 to bar_index',
          '    effect.emit(i)',
          'plot(close)',
        ].join('\n'),
      ),
    );
    expect(dynamicEffect.status).toBe('staged-unsupported');
    expect(dynamicEffect.eligibility.issues[0]?.code).toBe(
      'effect-transport-lowering-unimplemented',
    );
  });
});

describe('WGSL core math natives', () => {
  test('lowers nullable int/float abs, max, min, and floor', () => {
    const artifact = compile(
      [
        'indicator("core math")',
        'minimum = input.int(-2147483648)',
        'huge = input.float(2147483648.0)',
        'float missing = na',
        'absoluteInt = math.abs(minimum)',
        'absoluteFloat = math.abs(close)',
        'maximum = math.max(bar_index, close, 2)',
        'minimumValue = math.min(close, bar_index, missing)',
        'floorInt = math.floor(bar_index)',
        'floorFloat = math.floor(close)',
        'floorHuge = math.floor(huge)',
        'plot(close + absoluteInt + absoluteFloat + maximum + minimumValue + floorInt + floorFloat + floorHuge)',
      ].join('\n'),
    );
    const source = artifact.module.source;

    expect(source).toMatch(/= tea_abs_i32\(t\d+\);/);
    expect(source).toMatch(/= tea_abs_f32\(t\d+\);/);
    expect(source.match(/= tea_floor_f32\(t\d+\);/g)).toHaveLength(2);
    expect(source).toMatch(/tea_float\(max\(/);
    expect(source).toMatch(/tea_float\(min\(/);
    expect(source).toContain(
      'if (value < -2147483648.0 || value >= 2147483648.0) { return TeaInt(0u, 0); }',
    );
    expect(source).toContain(
      'TeaInt(1u, bitcast<i32>(0u - bitcast<u32>(x.value)))',
    );
  });
});
