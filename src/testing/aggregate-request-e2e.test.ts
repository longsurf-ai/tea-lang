// Purpose: Request-boundary coverage for unsupported aggregate results,
// invalid placement, and dynamic context arguments before lowering.

import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {compile} from '../compiler';

const FIXTURES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/requests',
);

const AGGREGATE_RESULT = join(FIXTURES, 'aggregate-result.tea');
const REQUEST_BOUNDARIES = [
  {
    name: 'named dynamic context arguments',
    source: join(FIXTURES, 'context-evaluation-order.tea'),
    diagnostic:
      'dynamic requests are not supported yet; symbol and timeframe must be bind-time-known',
  },
  {
    name: 'a dynamic request after mutable receiver work',
    source: join(FIXTURES, 'mutable-method-suspension.tea'),
    diagnostic:
      'request call must directly initialize one plain top-level variable',
  },
] as const;

describe('request compilation boundaries', () => {
  test('a Heap-backed child result is rejected before lowering', () => {
    const result = compile([AGGREGATE_RESULT]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('aggregate request unexpectedly compiled');
    expect(result.errors.map(error => error.msg)).toContain(
      'request expression cannot return ChildSnapshot; request results must be scalar',
    );
  });

  test.each(REQUEST_BOUNDARIES)(
    '$name fails closed before lowering',
    ({source, diagnostic}) => {
      const result = compile([source]);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('invalid request unexpectedly compiled');
      expect(result.errors.map(error => error.msg)).toContain(diagnostic);
    },
  );
});
