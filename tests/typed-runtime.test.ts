// Handwritten runtime code and compiled Tea meet the same independent row oracle.

import {expect, test} from 'vitest';
import {Field, Float64, Schema} from 'apache-arrow';
import {from} from 'rxjs';
import {program} from '../examples/api/typed-runtime';
import {createNode, type Node} from '../src/api/node';
import {DataStream} from '../src/api/stream';
import {tea} from '../src/api/tea';
import {Context} from '../src/runtime';

function rows(node: Node, lag: number): readonly unknown[][] {
  const rows: unknown[][] = [];
  let failure: unknown;
  node.bind({lag});
  node.bind(
    new DataStream(
      new Schema([
        new Field('close', new Float64(), false),
        new Field('open', new Float64(), false),
      ]),
      from([
        {close: 10, open: 1},
        {close: 20, open: 2},
        {close: 30, open: 3},
      ]),
    ),
  );
  node.to({
    next: datum =>
      rows.push(['output0', 'output1', 'output2'].map(name => datum[name])),
    error: error => {
      failure = error;
    },
  });
  node.dispose();
  if (failure !== undefined) throw failure;
  return rows;
}

test('handwritten TypeScript preserves parameter history and independent call frames', () => {
  for (const lag of [0, 1, 2]) {
    const source = tea`
      lag = input.int(1, minval=0, maxval=10)
      accumulate(float x) =>
          var float total = 0
          total := total + x
          total
      a = accumulate(close)
      b = accumulate(open)
      emit "output0" a
      emit "output1" b
      emit "output2" close[lag]
    `;
    const expected = [
      [10, 1, lag === 0 ? 10 : NaN],
      [30, 3, lag === 0 ? 20 : lag === 1 ? 10 : NaN],
      [60, 6, lag === 0 ? 30 : lag === 1 ? 20 : 10],
    ];
    expect(rows(source, lag)).toEqual(expected);
    expect(rows(createNode(program.clone()), lag)).toEqual(expected);
  }
});

test('a null var initializer survives same-index attempts before the final commit', () => {
  const node = tea`
    var string value = close > 0 ? na : "reinitialized"
    emit "probe" value
    value := "later"
  `;
  const context = new Context(node.module);
  const attempt = (close: number, provisional: boolean) =>
    context.step({
      series: [close],
      builtins: [],
      requests: [],
      provisional,
    }).outputs[0];
  try {
    expect(attempt(1, true)).toBeNull();
    expect(attempt(-1, true)).toBeNull();
    expect(attempt(-1, false)).toBeNull();
    expect(attempt(-1, false)).toBe('later');
  } finally {
    context.dispose();
    node.dispose();
  }
});
