// Purpose: Output bind lowering preserves source evaluation order while assembling canonical host arguments.

import {describe, expect, test} from 'vitest';
import {buildText} from '../noder/testing';

const SOURCE = [
  'indicator("output bind order")',
  'colors = matrix.new<color>()',
  'values = array.new<int>()',
  'plot(color = colors.get(0, 0), series = values.first())',
].join('\n');

describe('output bind evaluation order', () => {
  test('rejects aggregate-dependent declaration arguments before loading', () => {
    const result = buildText(SOURCE);

    expect(result.program).toBeNull();
    expect(result.errors.map(error => error.msg)).toContain(
      'module configuration must depend only on constants, scalar parameters, and non-allocating simple expressions',
    );
  });
});
