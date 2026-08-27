// Purpose: Schema-validating Observable construction.

import {firstValueFrom, of, toArray} from 'rxjs';
import * as z from 'zod';
import {expect, test} from 'vitest';
import {i} from './clock';
import {DataStream} from './stream';

test('creates a schema-validating DataStream from an Observable', async () => {
  const stream = new DataStream(
    z.object({close: z.coerce.number()}),
    of({close: '1'}, {close: '2'}),
  );

  await expect(
    firstValueFrom(stream.asObservable().pipe(toArray())),
  ).resolves.toEqual([{close: 1}, {close: 2}]);
});

test('retains an optional finite index count', () => {
  const stream = new DataStream(z.number(), of(1, 2), i, 2);

  expect(stream.indices).toBe(2);
  expect(() => new DataStream(z.number(), of(), i, -1)).toThrow(
    'DataStream indices must be a non-negative safe integer',
  );
});
