// Purpose: Schema-carrying read-only Observable input for the public API.

import {
  Observable,
  map,
  type Observer,
  type Subscribable,
  Subscription,
} from 'rxjs';
import * as z from 'zod';
import {i, type Clock} from './clock';

/**
 * An Observable whose emissions are validated and transformed by a schema.
 * Finite sources may also declare their exact emission count through
 * `indices`; Node verifies that count and uses it for extent-dependent
 * contextual values.
 *
 * @example
 * ```ts
 * const prices = new DataStream(
 *   z.object({close: z.number()}),
 *   of({close: 10}, {close: 11}),
 *   i,
 *   2,
 * );
 * ```
 */
export class DataStream<T> implements Subscribable<T> {
  private readonly observable: Observable<T>;

  constructor(
    public readonly schema: z.ZodType<T>,
    source: Observable<unknown>,
    public readonly clock: Clock = i,
    public readonly indices: number | null = null,
  ) {
    if (indices !== null && (!Number.isSafeInteger(indices) || indices < 0)) {
      throw new RangeError(
        'DataStream indices must be a non-negative safe integer',
      );
    }
    this.observable = source.pipe(map(value => this.schema.parse(value)));
  }

  subscribe(observer: Partial<Observer<T>>): Subscription {
    return this.observable.subscribe(observer);
  }

  asObservable(): Observable<T> {
    return this.observable;
  }
}
