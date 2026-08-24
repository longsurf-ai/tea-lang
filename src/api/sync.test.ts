// Purpose: Target retention, source buffering, projection, and lifecycle
// contracts for the sync Observable operator.

import {Subject} from 'rxjs';
import {describe, expect, test, vi} from 'vitest';
import {sync} from './sync';

describe('sync', () => {
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
