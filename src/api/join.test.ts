// Purpose: Keyed Observable join mode, unmatched routing, uniqueness, and
// shared-execution contracts.

import {Observable, Subject} from 'rxjs';
import {describe, expect, test, vi} from 'vitest';
import {DuplicateJoinKeyError, join} from './join';

interface LeftValue {
  readonly key: number;
  readonly left: string;
}

interface RightValue {
  readonly key: number;
  readonly right: string;
}

function makeInputs() {
  const left = new Subject<LeftValue>();
  const right = new Subject<RightValue>();
  return {left, right, sources: [left, right] as const};
}

function emitExample(
  left: Subject<LeftValue>,
  right: Subject<RightValue>,
): void {
  left.next({key: 1, left: 'A1'});
  left.next({key: 2, left: 'A2'});
  left.next({key: 4, left: 'A4'});
  right.next({key: 1, right: 'B1'});
  right.next({key: 3, right: 'B3'});
  right.next({key: 4, right: 'B4'});
  left.complete();
  right.complete();
}

describe('join', () => {
  test('inner mode emits complete tuples and routes partial rows only to unmatched$', () => {
    const {left, right, sources} = makeInputs();
    const result = join(sources, value => value.key, {
      mode: 'inner',
    });
    const output = vi.fn();
    const unmatched = vi.fn();

    result.output$.subscribe(output);
    result.unmatched$.subscribe(unmatched);
    emitExample(left, right);

    expect(output.mock.calls.map(([row]) => row)).toEqual([
      {
        kind: 'matched',
        key: 1,
        values: [
          {key: 1, left: 'A1'},
          {key: 1, right: 'B1'},
        ],
      },
      {
        kind: 'matched',
        key: 4,
        values: [
          {key: 4, left: 'A4'},
          {key: 4, right: 'B4'},
        ],
      },
    ]);
    expect(unmatched.mock.calls.map(([row]) => row)).toEqual([
      {
        kind: 'unmatched',
        key: 2,
        slots: [{present: true, value: {key: 2, left: 'A2'}}, {present: false}],
      },
      {
        kind: 'unmatched',
        key: 3,
        slots: [
          {present: false},
          {present: true, value: {key: 3, right: 'B3'}},
        ],
      },
    ]);
  });

  test('outer mode emits partial rows to output$ and unmatched$', () => {
    const {left, right, sources} = makeInputs();
    const result = join(sources, value => value.key, {
      mode: 'outer',
    });
    const output: unknown[] = [];
    const unmatched: unknown[] = [];

    result.output$.subscribe(value => output.push(value));
    result.unmatched$.subscribe(value => unmatched.push(value));
    emitExample(left, right);

    expect(output).toHaveLength(4);
    expect(
      output.filter(row => (row as {kind: string}).kind === 'matched'),
    ).toHaveLength(2);
    expect(output.slice(2)).toEqual(unmatched);
    expect(unmatched).toEqual([
      {
        kind: 'unmatched',
        key: 2,
        slots: [{present: true, value: {key: 2, left: 'A2'}}, {present: false}],
      },
      {
        kind: 'unmatched',
        key: 3,
        slots: [
          {present: false},
          {present: true, value: {key: 3, right: 'B3'}},
        ],
      },
    ]);
  });

  test('errors both views when a source repeats a key', () => {
    const {left, right, sources} = makeInputs();
    const result = join(sources, value => value.key, {
      mode: 'inner',
    });
    const outputError = vi.fn();
    const unmatchedError = vi.fn();

    result.output$.subscribe({error: outputError});
    result.unmatched$.subscribe({error: unmatchedError});
    left.next({key: 1, left: 'first'});
    left.next({key: 1, left: 'duplicate'});

    expect(outputError).toHaveBeenCalledOnce();
    expect(unmatchedError).toHaveBeenCalledOnce();
    const error = outputError.mock.calls[0]![0];
    expect(error).toBeInstanceOf(DuplicateJoinKeyError);
    expect(error).toMatchObject({sourceIndex: 0, key: 1});
    expect(unmatchedError).toHaveBeenCalledWith(error);
    expect(right.observed).toBe(false);
  });

  test('shares one input subscription between output$ and unmatched$', () => {
    const leftValues = new Subject<LeftValue>();
    const rightValues = new Subject<RightValue>();
    let leftSubscriptions = 0;
    let rightSubscriptions = 0;
    const left = new Observable<LeftValue>(subscriber => {
      leftSubscriptions++;
      return leftValues.subscribe(subscriber);
    });
    const right = new Observable<RightValue>(subscriber => {
      rightSubscriptions++;
      return rightValues.subscribe(subscriber);
    });
    const result = join([left, right] as const, value => value.key, {
      mode: 'outer',
    });

    result.output$.subscribe(() => undefined);
    result.unmatched$.subscribe(() => undefined);

    expect(leftSubscriptions).toBe(1);
    expect(rightSubscriptions).toBe(1);
  });
});
