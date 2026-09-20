// Purpose: Exercise public Node attempts, commit order and child-window ownership.
import {Bool, Field, Float64, Schema, TimestampMillisecond} from 'apache-arrow';
import {of, Subject} from 'rxjs';
import {expect, test} from 'vitest';
import {DataStream} from './stream';
import {tea} from './tea';
import type {Datum, Node} from './node';
import {m, type Clock} from './clock';

const fields = [
  new Field('close', new Float64(), false),
  new Field('provisional', new Bool(), false),
  new Field('realtime', new Bool(), false),
];
const timedSchema = new Schema([
  new Field('time', new TimestampMillisecond(), false),
  ...fields,
]);
type Row = {
  time: number;
  close: number;
  provisional: boolean;
  realtime: boolean;
};
const row = (
  time: number,
  close: number,
  provisional = false,
  realtime = true,
): Row => ({time, close, provisional, realtime});
const stream = (source: Subject<Row>) => new DataStream(timedSchema, source);

function observe(node: Node) {
  const values: Datum[] = [];
  const errors: unknown[] = [];
  node.to({
    next: value => values.push(value),
    error: error => errors.push(error),
  });
  return {values, errors};
}

test('provisional attempts preserve varip, roll back var, and commit history once', () => {
  const source = new Subject<Row>();
  const node = tea`
    var float total = 0.0
    varip int attempts = 0
    total := total + close
    attempts := attempts + 1
    emit "total" total
    emit "attempts" attempts
    emit "previous" total[1]
    emit.append "events" close
  `.bind(stream(source));
  const result = observe(node);
  source.next(row(10, 2, true));
  source.next(row(10, 3, true));
  source.next(row(10, 4));
  source.next(row(20, 5, true));
  source.next(row(20, 6));
  expect(result.errors).toEqual([]);
  expect(
    result.values.map(value => [
      value.index,
      value.provisional,
      value.total,
      value.attempts,
      value.previous,
      value.events,
    ]),
  ).toEqual([
    [0, true, 2, 1, NaN, [2]],
    [0, true, 3, 2, NaN, [3]],
    [0, false, 4, 3, NaN, [4]],
    [1, true, 9, 4, 4, [5]],
    [1, false, 10, 5, 4, [6]],
  ]);
  node.dispose();
});

test('Pine bar states distinguish first attempt, final commit, history and realtime', () => {
  const node = tea`
    emit "confirmed" barstate.isconfirmed
    emit "new" barstate.isnew
    emit "realtime" barstate.isrealtime
    emit "history" barstate.ishistory
  `.bind(
    new DataStream(
      timedSchema,
      of(row(1, 1, false, false), row(2, 2, true), row(2, 3, true), row(2, 4)),
    ),
  );
  const result = observe(node);
  expect(result.errors).toEqual([]);
  expect(
    result.values.map(value => [
      value.confirmed,
      value.new,
      value.realtime,
      value.history,
    ]),
  ).toEqual([
    [true, true, false, true],
    [false, true, true, false],
    [false, false, true, false],
    [true, false, true, false],
  ]);
});

test.each([
  [row(10, 1), row(10, 2), 'committed timestamp'],
  [row(10, 1), row(9, 2), 'nondecreasing'],
  [row(10, 1, true), row(20, 2), 'finalize its provisional step'],
] as const)(
  'invalid source progression fails before another runtime attempt',
  (first, second, message) => {
    const result = observe(
      tea`emit "value" close`.bind(
        new DataStream(timedSchema, of(first, second)),
      ),
    );
    expect(result.values).toHaveLength(1);
    expect(String(result.errors[0])).toContain(message);
  },
);

test('current HTF child may refine an older open time without revising committed parent rows', () => {
  const main = new Subject<Row>();
  const child = new Subject<Row>();
  const node = tea`
    requested = request.security("X", "2", close)
    emit "value" requested
  `
    .bind(stream(main))
    .bind({requested: stream(child)});
  const result = observe(node);
  child.next(row(0, 10, true));
  main.next(row(1, 1));
  child.next(row(0, 20, true));
  expect(result.values).toHaveLength(1);
  main.next(row(2, 2, true));
  child.next(row(0, 30));
  main.next(row(2, 3));
  expect(result.errors).toEqual([]);
  expect(
    result.values.map(value => [value.index, value.provisional, value.value]),
  ).toEqual([
    [0, false, 10],
    [1, true, 20],
    [1, false, 30],
  ]);
  child.next(row(1, 40));
  expect(String(result.errors[0])).toContain(
    'after its parent interval finalized',
  );
  expect(result.values).toHaveLength(3);
  node.dispose();
});

test('collect windows retain earlier children during repeated parent attempts and replace child attempts', () => {
  const main = new Subject<Row>();
  const child = new Subject<Row>();
  const node = tea`
    lower = request.security_lower_tf("X", "", close)
    emit "count" lower.size()
    emit "first" lower.first()
    emit "last" lower.last()
  `
    .bind(stream(main))
    .bind({lower: stream(child)});
  const result = observe(node);
  child.next(row(5, 1));
  child.next(row(10, 2, true));
  main.next(row(10, 10, true));
  child.next(row(10, 3, true));
  main.next(row(10, 11, true));
  child.next(row(10, 4));
  main.next(row(10, 12));
  child.next(row(20, 5));
  main.next(row(20, 20));
  expect(result.errors).toEqual([]);
  expect(
    result.values.map(value => [
      value.index,
      value.count,
      value.first,
      value.last,
    ]),
  ).toEqual([
    [0, 2, 1, 2],
    [0, 2, 1, 3],
    [0, 2, 1, 4],
    [1, 1, 5, 5],
  ]);
  node.dispose();
});

test('sparse sampling advances on final parent steps, not provisional attempts', () => {
  const main = new Subject<Row>();
  const child = new Subject<Row>();
  const node = tea`
    requested = request.security("X", "2", close, fill="sparse")
    emit "value" requested
  `
    .bind(stream(main))
    .bind({requested: stream(child)});
  const result = observe(node);
  child.next(row(1, 10));
  main.next(row(1, 1, true));
  main.next(row(1, 2));
  main.next(row(2, 3));
  expect(result.errors).toEqual([]);
  expect(result.values.map(value => value.value)).toEqual([10, 10, NaN]);
  node.dispose();
});

test('attempt metadata is validated at binding and partial streams must agree', () => {
  expect(() =>
    tea`emit "value" close`.bind(
      new DataStream(
        new Schema([
          new Field('close', new Float64(), false),
          new Field('provisional', new Bool(), true),
        ]),
        of({close: 1, provisional: null}),
      ),
    ),
  ).toThrow('non-nullable Bool');
  const node = tea`emit "value" close + open`.bind({
    close: new DataStream(timedSchema, of(row(1, 1, true))),
    open: new DataStream(
      new Schema([
        new Field('time', new TimestampMillisecond(), false),
        new Field('open', new Float64(), false),
      ]),
      of({time: 1, open: 1}),
    ),
  });
  const result = observe(node);
  expect(result.values).toEqual([]);
  expect(String(result.errors[0])).toContain('provisional states disagree');
});

test('positional requests wait for child finalization and preserve its logical step across parent attempts', () => {
  const main = new Subject<Omit<Row, 'time'>>();
  const child = new Subject<Omit<Row, 'time'>>();
  const schema = new Schema(fields);
  const node = tea`
    requested = request.security("X", "", close)
    emit "value" requested
  `
    .bind(new DataStream(schema, main))
    .bind({requested: new DataStream(schema, child)});
  const result = observe(node);
  child.next({close: 1, provisional: true, realtime: true});
  main.next({close: 10, provisional: true, realtime: true});
  main.next({close: 10, provisional: false, realtime: true});
  expect(result.values).toHaveLength(1);
  child.next({close: 2, provisional: false, realtime: true});
  child.next({close: 3, provisional: false, realtime: true});
  main.next({close: 20, provisional: false, realtime: true});
  expect(result.errors).toEqual([]);
  expect(
    result.values.map(value => [value.index, value.provisional, value.value]),
  ).toEqual([
    [0, true, 1],
    [0, false, 2],
    [1, false, 3],
  ]);
  node.dispose();
});

test('count windows count child steps, not provisional notifications', () => {
  const main = new Subject<Omit<Row, 'time'>>();
  const child = new Subject<Omit<Row, 'time'>>();
  const schema = new Schema(fields);
  const node = tea`
    lower = request.security_lower_tf("X", "1", close)
    emit "count" lower.size()
    emit "last" lower.last()
  `
    .bind(new DataStream(schema, main, (2n * m) as Clock))
    .bind({lower: new DataStream(schema, child, m)});
  const result = observe(node);
  child.next({close: 1, provisional: false, realtime: true});
  child.next({close: 2, provisional: true, realtime: true});
  child.next({close: 3, provisional: true, realtime: true});
  main.next({close: 10, provisional: true, realtime: true});
  main.next({close: 10, provisional: false, realtime: true});
  expect(result.values).toHaveLength(1);
  child.next({close: 4, provisional: false, realtime: true});
  expect(result.errors).toEqual([]);
  expect(
    result.values.map(value => [value.index, value.count, value.last]),
  ).toEqual([
    [0, 2, 3],
    [0, 2, 4],
  ]);
  node.dispose();
});
