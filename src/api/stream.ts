// Purpose: Schema-carrying read-only Observable input for the public API.

import {
  Observable,
  type Observer,
  type Subscribable,
  type Subscriber,
  type Subscription,
  type TeardownLogic,
} from 'rxjs';
import * as z from 'zod';

/** A read-only Observable whose emitted values are described by one schema. */
export class DataStream<T> implements Subscribable<T> {
  private readonly observable: Observable<T>;

  constructor(
    readonly schema: z.ZodType<T>,
    subscribe?: (
      this: Observable<T>,
      subscriber: Subscriber<T>,
    ) => TeardownLogic,
  ) {
    this.observable = new Observable<T>(subscribe);
  }

  subscribe(observer: Partial<Observer<T>>): Subscription {
    return this.observable.subscribe(observer);
  }

  asObservable(): Observable<T> {
    return this.observable;
  }
}
