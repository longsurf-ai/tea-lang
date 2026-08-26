// Purpose: Schema-validating Observable construction.

import {firstValueFrom, of, toArray} from 'rxjs';
import * as z from 'zod';
import {expect, test} from 'vitest';
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
