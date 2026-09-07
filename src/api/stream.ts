// Purpose: Schema-carrying read-only Observable input for the public API.

import {Schema} from 'apache-arrow';
import {
  Observable,
  map,
  type Observer,
  type Subscribable,
  Subscription,
} from 'rxjs';
import {cloneSchema, validateRecord, validateValue} from '../runtime/io';
import {i, type Clock} from './clock';

/**
 * A read-only Observable validated once per emission against an Arrow schema.
 * The stream owns a schema copy; inspecting `schema` returns another copy, so
 * callers cannot change validation after construction. No subscription is
 * created until `subscribe()` or the returned Observable is subscribed.
 *
 * A one-field schema also accepts scalar emissions of that field's type.
 *
 * @example
 * ```ts
 * import {Field, Float64, Schema} from 'apache-arrow';
 * import {of} from 'rxjs';
 *
 * const prices = new DataStream(
 *   new Schema([new Field('close', new Float64(), false)]),
 *   of({close: 10}, {close: 11}),
 * );
 * prices.subscribe({next: row => console.log(row.close)}); // 10, then 11
 * ```
 */
export class DataStream<
  T = Record<string, unknown>,
> implements Subscribable<T> {
  private readonly observable: Observable<T>;
  private readonly shape: Schema;

  constructor(
    schema: Schema,
    source: Observable<T>,
    public readonly clock: Clock = i,
  ) {
    this.shape = cloneSchema(schema);
    this.observable = source.pipe(
      map(value => {
        if (
          this.shape.fields.length === 1 &&
          (typeof value !== 'object' ||
            value === null ||
            Array.isArray(value) ||
            value instanceof Map ||
            ArrayBuffer.isView(value))
        ) {
          validateValue(this.shape.fields[0]!, value);
          return value;
        }
        return validateRecord(this.shape, value) as T;
      }),
    );
  }

  /**
   * Return an independent Arrow schema, including independent metadata Maps.
   * @example `prices.schema.fields[0].name` is `'close'` in the example above.
   */
  get schema(): Schema {
    return cloneSchema(this.shape);
  }

  /**
   * Subscribe to validated values; unsubscribing releases this subscription.
   * @example `prices.subscribe({next: row => console.log(row.close)})` prints each price.
   */
  subscribe(observer: Partial<Observer<T>>): Subscription {
    return this.observable.subscribe(observer);
  }

  /**
   * Expose the same validated Observable for ordinary RxJS composition.
   * @example `firstValueFrom(prices.asObservable())` resolves to `{close: 10}`.
   */
  asObservable(): Observable<T> {
    return this.observable;
  }
}
