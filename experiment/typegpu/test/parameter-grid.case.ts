// Purpose: Lock deterministic inclusive parameter-grid expansion and invalid-pair pruning.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createParameterGrid,
  parseInclusiveIntegerRange,
} from '../src/parameter-grid';

test('expands ranges in fast-major order and prunes fast >= slow', () => {
  assert.deepEqual(
    createParameterGrid({
      fast: {start: 2, end: 4, step: 1},
      slow: {start: 3, end: 5, step: 1},
    }),
    [
      {fastPeriod: 2, slowPeriod: 3},
      {fastPeriod: 2, slowPeriod: 4},
      {fastPeriod: 2, slowPeriod: 5},
      {fastPeriod: 3, slowPeriod: 4},
      {fastPeriod: 3, slowPeriod: 5},
      {fastPeriod: 4, slowPeriod: 5},
    ],
  );
});

test('parses explicit inclusive range syntax', () => {
  assert.deepEqual(parseInclusiveIntegerRange('5:20:5', 'fast'), {
    start: 5,
    end: 20,
    step: 5,
  });
  assert.throws(
    () => parseInclusiveIntegerRange('20:5', 'fast'),
    /must not exceed/,
  );
});
