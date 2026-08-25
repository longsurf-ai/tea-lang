// Purpose: Request-boundary coverage for unsupported aggregate results and
// fail-closed dynamic context arguments before lowering.

import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {compile} from '../compile';

const FIXTURES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/requests',
);

const AGGREGATE_RESULT = join(FIXTURES, 'aggregate-result.tea');
const DYNAMIC_CONTEXTS = [
  {
    name: 'named dynamic context arguments',
    source: join(FIXTURES, 'context-evaluation-order.tea'),
  },
  {
    name: 'a dynamic request after mutable receiver work',
    source: join(FIXTURES, 'mutable-method-suspension.tea'),
  },
] as const;

describe('request compilation boundaries', () => {
  test('a Heap-backed child result is rejected before lowering', () => {
    const result = compile([AGGREGATE_RESULT]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('aggregate request unexpectedly compiled');
    expect(result.errors.map(error => error.msg)).toContain(
      'request expression cannot return ChildSnapshot; request results must be scalars or scalar-only tuples',
    );
  });

  test.each(DYNAMIC_CONTEXTS)(
    '$name fails closed before lowering',
    ({source}) => {
      const result = compile([source]);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('dynamic request unexpectedly compiled');
      expect(result.errors.map(error => error.msg)).toContain(
        'dynamic requests are not supported yet; symbol and timeframe must be bind-time-known',
      );
    },
  );
});
