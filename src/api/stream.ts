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
 *
 * @example
 * ```ts
 * const prices = new DataStream(
 *   z.object({close: z.number()}),
 *   of({close: 10}, {close: 11}),
 * );
 * ```
 */
export class DataStream<T> implements Subscribable<T> {
  private readonly observable: Observable<T>;

  constructor(
    public readonly schema: z.ZodType<T>,
    source: Observable<unknown>,
    public readonly clock: Clock = i,
  ) {
    this.observable = source.pipe(map(value => this.schema.parse(value)));
  }

  subscribe(observer: Partial<Observer<T>>): Subscription {
    return this.observable.subscribe(observer);
  }

  asObservable(): Observable<T> {
    return this.observable;
  }
}
