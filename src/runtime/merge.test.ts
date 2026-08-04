// Purpose: Sample-merge mapping tests — lookahead and gaps semantics pinned against hand-checked axes; the mapping never reads child values, only axes.

import {describe, expect, test} from 'bun:test';
import type {TimeAxis} from './abi';
import {sampleMergeMap} from './merge';

// A regular axis: bar i opens at start + i*span and closes span later.
function axis(start: number, span: number): TimeAxis {
  return {
    time: row => start + row * span,
    closeTime: row => start + (row + 1) * span,
  };
}

const NO_GAPS = {
  mode: 'sample',
  gaps: false,
  lookahead: false,
  ignoreInvalidSymbol: false,
} as const;

describe('sampleMergeMap', () => {
  // Parent: 6 daily bars at t=0..6. Child: 3 two-day bars closing at 2,4,6.
  test('lookahead_off maps each parent bar to the last CLOSED child bar', () => {
    const map = sampleMergeMap(axis(0, 1), 6, axis(0, 2), 3, NO_GAPS);
    expect([...map]).toEqual([-1, 0, 0, 1, 1, 2]);
  });

  test('a child bar closing exactly at the parent close counts (<= boundary)', () => {
    // Parent bar 1 closes at t=2; child bar 0 closes at t=2 — included.
    const map = sampleMergeMap(axis(0, 1), 2, axis(0, 2), 1, NO_GAPS);
    expect([...map]).toEqual([-1, 0]);
  });

  test('lookahead_on maps to the child bar containing the parent open', () => {
    const map = sampleMergeMap(axis(0, 1), 6, axis(0, 2), 3, {
      ...NO_GAPS,
      lookahead: true,
    });
    // Parent opens 0..5 fall inside child bars [0,2),[2,4),[4,6).
    expect([...map]).toEqual([0, 0, 1, 1, 2, 2]);
  });

  test('gaps_on yields a value only on rows where a new child bar arrived', () => {
    const map = sampleMergeMap(axis(0, 1), 6, axis(0, 2), 3, {
      ...NO_GAPS,
      gaps: true,
    });
    expect([...map]).toEqual([-1, 0, -1, 1, -1, 2]);
  });

  test('a low-resolution child under a dense parent repeats its row index', () => {
    // One monthly-ish child bar under ten parent bars: the mapping repeats
    // the index — the value is never copied per parent row.
    const map = sampleMergeMap(axis(0, 1), 10, axis(0, 3), 2, NO_GAPS);
    expect([...map]).toEqual([-1, -1, 0, 0, 0, 1, 1, 1, 1, 1]);
  });

  test('a child extending beyond the parent never maps future bars', () => {
    // Child bars close at 2,4,6,8 but the parent ends at t=3.
    const map = sampleMergeMap(axis(0, 1), 3, axis(0, 2), 4, NO_GAPS);
    expect([...map]).toEqual([-1, 0, 0]);
  });
});
