// Purpose: Callers compose finite Batch Recipes with isolated Node state.

import {of} from 'rxjs';
import {describe, expect, test} from 'vitest';
import {Field, Float64, Schema} from 'apache-arrow';
import {i} from '../../api/clock';
import type {Datum} from '../../api/node';
import {DataStream} from '../../api/stream';
import {tea} from '../../api/tea';
import {batchRecipe} from './index';

describe('batch Recipe composition', () => {
  test('runs ordinary bindings in caller order with isolated state', async () => {
    const executions = [
      {scale: 1, close: [1, 2], expected: [1, 3]},
      {scale: 10, close: [3, 4], expected: [30, 70]},
    ];
    const counts: number[] = [];
    for (const execution of executions) {
      const node = tea`
        scale = input.float(1.0)
        var float total = 0.0
        total := total + close * scale
        plot(total)
      `;
      const values: number[] = [];
      const stream = new DataStream(
        new Schema([new Field('close', new Float64(), false)]),
        of(...execution.close.map(close => ({close}))),
        i,
        execution.close.length,
      );
      const result = await batchRecipe(
        node,
        [{scale: execution.scale}, stream],
        {
          next: datum => values.push(output(datum)),
        },
      ).execute();
      counts.push(result.indices);
      expect(values).toEqual(execution.expected);
    }

    expect(counts).toEqual([2, 2]);
  });

  test('rejects when public Node output delivery fails', async () => {
    const failure = new Error('delivery failed');
    const node = tea`plot(close)`;
    const stream = new DataStream(
      new Schema([new Field('close', new Float64(), false)]),
      of({close: 1}, {close: 2}),
      i,
      2,
    );
    const recipe = batchRecipe(node, [stream], {
      next() {
        throw failure;
      },
    });

    await expect(recipe.execute()).rejects.toBe(failure);
  });

  test('waits for an observer completion failure', async () => {
    const failure = new Error('asynchronous delivery failed');
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const node = tea`plot(close)`;
    const stream = new DataStream(
      new Schema([new Field('close', new Float64(), false)]),
      of({close: 1}, {close: 2}),
      i,
      2,
    );
    const recipe = batchRecipe(node, [stream], {
      completion,
      next() {
        rejectCompletion(failure);
      },
    });

    await expect(recipe.execute()).rejects.toBe(failure);
  });
});

function output(datum: Datum): number {
  return (datum.output0 as {series: number}).series;
}
