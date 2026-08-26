// Purpose: Target retention, source buffering, projection, and lifecycle
// contracts for the sync Observable operator.

import {Observable, Subject, type Subscriber} from 'rxjs';
import {describe, expect, test, vi} from 'vitest';
import {sync} from './sync';

describe('sync', () => {
  test('subscribes the source before the target', () => {
    const order: string[] = [];
    const values: number[] = [];
    const source = new Observable<number>(subscriber => {
      order.push('source');
      subscriber.next(1);
    });
    const target = new Observable<void>(subscriber => {
      order.push('target');
      subscriber.next();
    });

    source.pipe(sync(target)).subscribe(value =>
      values.push(value as number),
    );

    expect(order).toEqual(['source', 'target']);
    expect(values).toEqual([1]);
  });

  test('an empty completed source finishes without subscribing the target', () => {
    const targetSubscribed = vi.fn();
    const project = vi.fn(() => undefined);
    const complete = vi.fn();
    const source = new Observable<number>(subscriber => subscriber.complete());
    const target = new Observable<void>(() => {
      targetSubscribed();
    });

    source.pipe(sync(target, project)).subscribe({complete});

    expect(complete).toHaveBeenCalledOnce();
    expect(targetSubscribed).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  test('serves targets from a buffered completed source', () => {
    const target = new Subject<string>();
    const values: string[] = [];
    const complete = vi.fn();
    const source = new Observable<number>(subscriber => {
      subscriber.next(1);
      subscriber.next(2);
      subscriber.complete();
    });

    source
      .pipe(
        sync(target, (name, buffered) => {
          const first = buffered[0];
          return first === undefined ? undefined : [`${name}:${first}`, 1];
        }),
      )
      .subscribe({next: value => values.push(value), complete});

    target.next('first');
    expect(values).toEqual(['first:1']);
    expect(complete).not.toHaveBeenCalled();

    target.next('second');
    expect(values).toEqual(['first:1', 'second:2']);
    expect(complete).toHaveBeenCalledOnce();
  });

  test('completes when a finished source cannot satisfy a pending target', () => {
    const source = new Subject<number>();
    const target = new Subject<void>();
    const values: Array<readonly number[]> = [];
    const complete = vi.fn();

    source
      .pipe(
        sync(target, (_, buffered) =>
          buffered.length < 2
            ? undefined
            : [buffered.slice(0, 2), 2],
        ),
      )
      .subscribe({next: value => values.push(value), complete});

    target.next();
    source.next(1);
    source.complete();

    expect(values).toEqual([]);
    expect(complete).toHaveBeenCalledOnce();
  });

  test('target completion discards buffered source leftovers', () => {
    let sourceSubscriber!: Subscriber<number>;
    const sourceTeardown = vi.fn();
    const source = new Observable<number>(subscriber => {
      sourceSubscriber = subscriber;
      return sourceTeardown;
    });
    const target = new Subject<void>();
    const values: number[] = [];
    const complete = vi.fn();

    source
      .pipe(
        sync(target, (_, buffered) => {
          const first = buffered[0];
          return first === undefined ? undefined : [first, 1];
        }),
      )
      .subscribe({next: value => values.push(value), complete});

    sourceSubscriber.next(1);
    sourceSubscriber.next(2);
    target.next();
    target.complete();

    expect(values).toEqual([1]);
    expect(complete).toHaveBeenCalledOnce();
    expect(sourceTeardown).toHaveBeenCalledOnce();
    expect(sourceSubscriber.closed).toBe(true);
  });

  test('cancellation tears down both subscriptions and stops work', () => {
    let sourceSubscriber!: Subscriber<number>;
    let targetSubscriber!: Subscriber<void>;
    const sourceTeardown = vi.fn();
    const targetTeardown = vi.fn();
    const values: Array<number | readonly number[]> = [];
    const source = new Observable<number>(subscriber => {
      sourceSubscriber = subscriber;
      return sourceTeardown;
    });
    const target = new Observable<void>(subscriber => {
      targetSubscriber = subscriber;
      return targetTeardown;
    });
    const subscription = source
      .pipe(sync(target))
      .subscribe(value => values.push(value));

    subscription.unsubscribe();
    sourceSubscriber.next(1);
    targetSubscriber.next();

    expect(sourceTeardown).toHaveBeenCalledOnce();
    expect(targetTeardown).toHaveBeenCalledOnce();
    expect(sourceSubscriber.closed).toBe(true);
    expect(targetSubscriber.closed).toBe(true);
    expect(values).toEqual([]);
  });

  test('retains a target until the source has a value', () => {
    const source = new Subject<number>();
    const target = new Subject<string>();
    const values: Array<number | readonly number[]> = [];

    source.pipe(sync(target)).subscribe(value => values.push(value));

    target.next('first');
    expect(values).toEqual([]);

    source.next(1);
    expect(values).toEqual([1]);
  });

  test('emits one value or the complete buffered batch by default', () => {
    const source = new Subject<number>();
    const target = new Subject<void>();
    const values: Array<number | readonly number[]> = [];

    source.pipe(sync(target)).subscribe(value => values.push(value));

    source.next(1);
    source.next(2);
    target.next();
    target.next();
    source.next(3);

    expect(values).toEqual([[1, 2], 3]);
  });

  test('processes retained targets in FIFO order', () => {
    const source = new Subject<number>();
    const target = new Subject<string>();
    const values: Array<number | readonly number[]> = [];

    source.pipe(sync(target)).subscribe(value => values.push(value));

    target.next('first');
    target.next('second');
    source.next(1);
    source.next(2);

    expect(values).toEqual([1, 2]);
  });

  test('retries a waiting projector when the source advances', () => {
    const source = new Subject<number>();
    const target = new Subject<string>();
    const values: string[] = [];

    source
      .pipe(
        sync(target, (name, buffered) =>
          buffered.length < 2
            ? undefined
            : [`${name}:${buffered.join(',')}`, buffered.length],
        ),
      )
      .subscribe(value => values.push(value));

    target.next('batch');
    source.next(1);
    expect(values).toEqual([]);
    source.next(2);

    expect(values).toEqual(['batch:1,2']);
  });

  test('retains values the projector does not consume', () => {
    const source = new Subject<number>();
    const target = new Subject<string>();
    const values: string[] = [];

    source
      .pipe(
        sync(target, (name, buffered) => [`${name}:${buffered.join(',')}`, 1]),
      )
      .subscribe(value => values.push(value));

    source.next(1);
    source.next(2);
    target.next('first');
    target.next('second');

    expect(values).toEqual(['first:1,2', 'second:2']);
  });

  test('waits after target completion for an already-pending target', () => {
    const source = new Subject<number>();
    const target = new Subject<void>();
    const values: Array<number | readonly number[]> = [];
    const complete = vi.fn();

    source.pipe(sync(target)).subscribe({
      next: value => values.push(value),
      complete,
    });

    target.next();
    target.complete();
    expect(complete).not.toHaveBeenCalled();

    source.next(1);
    expect(values).toEqual([1]);
    expect(complete).toHaveBeenCalledOnce();
  });

  test('rejects invalid buffer consumption', () => {
    const source = new Subject<number>();
    const target = new Subject<void>();
    const error = vi.fn();

    source.pipe(sync(target, () => [1, 2])).subscribe({error});

    source.next(1);
    target.next();

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toBeInstanceOf(RangeError);
  });
});
