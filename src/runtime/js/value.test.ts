// Purpose: Captured-value arithmetic, type domains, and transactional series contracts.

import {expect, expectTypeOf, test} from 'vitest';
import {colors, historyDepth, math, na, nz, rangeNext, str} from '../native';
import {Input, Series} from './series';
import {Context} from './context';
import {Module} from '../module-binding';
import {RUNTIME_ABI_VERSION} from '../module-abi';
import {Schema} from 'apache-arrow';
import {outputSchema} from '../output';
import {
  Value,
  array,
  matrix,
  map,
  struct,
  tuple,
  bool,
  color,
  enumeration,
  resource,
  float,
  int,
  text,
} from './value';

test('numeric operators preserve kind, finite-or-NA results and missing comparisons', () => {
  expectTypeOf(int(7).div(int(2))).toEqualTypeOf<Value<number, 'int'>>();
  expectTypeOf(int(7).div(float(2))).toEqualTypeOf<Value<number, 'float'>>();
  const unknownKind = int(7) as Value<number, 'int' | 'float'>;
  expectTypeOf(unknownKind.add(int(1))).toEqualTypeOf<
    Value<number, 'int' | 'float'>
  >();
  expectTypeOf(math.max(unknownKind, int(1))).toEqualTypeOf<
    Value<number, 'int' | 'float'>
  >();
  expect(int(-7).div(int(2)).value).toBe(-3);
  expect(int(7).div(float(2)).value).toBe(3.5);
  expect(float(1).div(float(0)).value).toBeNaN();
  expect(int(1).mod(int(0)).value).toBeNaN();
  expect(float(Number.MAX_VALUE).mul(float(2)).value).toBeNaN();
  expect(float(NaN).ne(float(1)).value).toBe(false);
  expect(float(NaN).lt(float(1)).value).toBe(false);
  expect(int(2).eq(float(2)).value).toBe(true);
  expect(
    enumeration('up', 'Direction').eq(enumeration('down', 'Direction')).value,
  ).toBe(false);
  expect(bool(true).not().value).toBe(false);
  expect(text('a').concat(text('b')).value).toBe('ab');
  expect(text(null).concat(text('b')).value).toBeNull();

  if (false) {
    // @ts-expect-error strings cannot enter numeric arithmetic
    int(1).add(text('2'));
    // @ts-expect-error enum identity survives its string representation
    enumeration('up', 'Direction').eq(enumeration('up', 'Side'));
  }
});

test('history captures values and initialization remains lazy', () => {
  let current = float(10);
  let initialized = false;
  let calls = 0;
  const series = new Series(
    () => current,
    value => {
      current = value;
    },
    () => !initialized,
    value => {
      current = value;
      initialized = true;
    },
  );
  const initial = () => {
    calls += 1;
    return float(20);
  };
  const before = series.hist(0);
  series.init(initial);
  series.init(initial);
  series.set(series.hist().add(float(1)));
  expect(before.value).toBe(10);
  expect(series.hist().value).toBe(21);
  expect(calls).toBe(1);
  expect(new Input(offset => int(offset)).hist(int(2)).value).toBe(2);

  if (false) {
    // @ts-expect-error retained float state cannot accept a string
    series.set(text('wrong'));
    // @ts-expect-error captured values cannot be changed by assigning the property
    before.value = 0;
  }
});

test('captured domains validate enum, tuple, and opaque resource payloads', () => {
  enum Status {
    ready = 'ready',
    done = 'done',
  }
  const status = enumeration<Status, 'Status'>(null, 'Status', Status);
  expect(status.withStored(Status.ready).value).toBe(Status.ready);
  expect(() => status.assertStored('other')).toThrow('VALUE_LAYOUT_MISMATCH');
  expect(status.sameType(enumeration(null, 'Status', {ready: 'ready'}))).toBe(
    false,
  );
  const pair = tuple([status]).empty();
  expect(() =>
    pair.assertStored([new Value('other', 'Status', undefined, status)]),
  ).toThrow('VALUE_LAYOUT_MISMATCH');

  const line = resource(null, 'Line');
  expect(() => line.assertStored('wrong')).toThrow('VALUE_LAYOUT_MISMATCH');
  expect(() =>
    line.withStored({kind: 'resource', handle: 'Label', id: 1}),
  ).toThrow('VALUE_LAYOUT_MISMATCH');
  expect(
    resource({kind: 'resource', handle: 'Line', id: 1}, 'Line').value,
  ).toEqual({kind: 'resource', handle: 'Line', id: 1});
  if (false) {
    // @ts-expect-error resource identities retain their declared kind
    resource({kind: 'resource', handle: 'Label', id: 1}, 'Line');
  }
});

test('native methods share numeric, color, missing-value, and progress rules', () => {
  expect(math.floor(float(-1.1)).value).toBe(-2);
  expect(math.round(float(1.235), int(2)).value).toBe(1.24);
  expect(math.sqrt(float(-1)).value).toBeNaN();
  expect(math.avg(int(2), float(4)).value).toBe(3);
  expect(math.max(int(2), float(4)).kind).toBe('float');
  expect(colors.rgb(int(255), int(0), int(0)).value?.toString()).toBe(
    '#FF0000',
  );
  expect(colors.new(color('#FF0000'), float(50)).value?.toString()).toBe(
    '#FF00007F',
  );
  expect(colors.rgb(float(NaN), int(0), int(0)).value).toBeNull();
  expect(na(bool(false)).value).toBe(false);
  expect(nz(float(NaN)).value).toBe(0);
  expect(nz(color(null)).value?.toString()).toBe('#00000000');
  expect(color('#ff0000ff').eq(color('#FF0000')).value).toBe(true);
  expect(color('#FF0000').ne(color('#FF000080')).value).toBe(true);
  expect(color(null).eq(color(null)).value).toBe(false);
  expect(color(null).ne(color('#FF0000')).value).toBe(false);
  expect(str.tostring(color('#ff0000ff')).value).toBe('#FF0000');
  expect(
    str.tostring(enumeration('up', 'Direction'), [['up', 'Up']]).value,
  ).toBe('Up');
  expect(historyDepth(float(-1)).value).toBe(0);
  expect(historyDepth(float(2.5)).value).toBe(0);
  expect(historyDepth(int(3)).value).toBe(3);
  expect(rangeNext(float(1e30), float(1)).value).toBeNaN();
});

test('aggregate APIs preserve exact field, element, key, and tuple types', () => {
  if (false) {
    const context = null! as Context;
    const floats = array<Value<number, 'float'>>(float(NaN)).new(context);
    expectTypeOf(floats.get(int(0))).toEqualTypeOf<Value<number, 'float'>>();
    // @ts-expect-error array writes require their declared element kind
    floats.push(text('wrong'));
    const grid = matrix<Value<number, 'float'>>(float(NaN)).new(
      context,
      int(1),
      int(1),
      float(0),
    );
    expectTypeOf(grid.get(int(0), int(0))).toEqualTypeOf<
      Value<number, 'float'>
    >();
    // @ts-expect-error matrix construction requires a complete shape and initial value
    matrix<Value<number, 'float'>>(float(NaN)).new(context, int(1));
    const lookup = map<Value<string | null, 'string'>, Value<number, 'int'>>(
      text(null),
      int(NaN),
    ).new(context);
    expectTypeOf(lookup.get(text('key'))).toEqualTypeOf<Value<number, 'int'>>();
    // @ts-expect-error map lookup requires the declared key type
    lookup.get(int(0));
    class Point {
      x = float(NaN);
      constructor(fields?: {x: Value<number, 'float'>}) {
        if (fields) Object.assign(this, fields);
      }
    }
    const point = struct<Point, 'Point'>(Point, 'Point', 24).empty(context);
    expectTypeOf(point.require().field('x').get()).toEqualTypeOf<
      Value<number, 'float'>
    >();
    // @ts-expect-error a field write cannot change its type
    point.field('x').set(text('wrong'));
    const pair = tuple<
      readonly [Value<number, 'int'>, Value<string | null, 'string'>]
    >([int(NaN), text(null)]).create(context, [int(1), text('a')]);
    expectTypeOf(pair.get(1)).toEqualTypeOf<Value<string | null, 'string'>>();
  }
});

test('handwritten typed aggregates reuse transactional storage and captured headers', () => {
  class PointBody {
    x = float(NaN);
    constructor(fields?: {x: Value<number, 'float'>}) {
      if (fields) Object.assign(this, fields);
    }
  }
  const Point = struct(PointBody, 'Point', 24);
  const Floats = array<Value<number, 'float'>>(float(NaN));
  const Grid = matrix<Value<number, 'float'>>(float(NaN));
  const Lookup = map<Value<string | null, 'string'>, Value<number, 'float'>>(
    text(null),
    float(NaN),
  );
  const Pair = tuple<
    readonly [Value<number, 'int'>, Value<string | null, 'string'>]
  >([int(NaN), text(null)]);
  const module = new Module(
    {
      abi: RUNTIME_ABI_VERSION,
      inputs: {schema: new Schema([]), series: [], builtins: []},
      parameters: [],
      state: {
        frames: [{locals: [], subs: []}],
      },
      outputs: {schema: outputSchema([])},
      requests: [],
    },
    context => {
      const point = Point.create(context, {x: float(1)});
      const before = point.field('x').get();
      point.require().field('x').set(float(2));
      expect(before.value).toBe(1);
      expect(point.field('x').get().value).toBe(2);
      expect(Point.empty(context).field('x').get().value).toBeNaN();
      let evaluated = false;
      const rhs = () => {
        evaluated = true;
        return float(3);
      };
      expect(() =>
        Point.empty(context).require().field('x').set(rhs()),
      ).toThrow('cannot mutate na struct');
      expect(evaluated).toBe(false);

      const first = Floats.from(context, float(1));
      const pushed = first.push(float(2)).replacement;
      expect(first.size().value).toBe(1);
      expect(pushed.size().value).toBe(2);
      expect(pushed.get(int(1)).value).toBe(2);
      expect(pushed.pop().result.value).toBe(2);
      expect(pushed.entries().map(value => value.value)).toEqual([1, 2]);
      const grid = Grid.new(context, int(1), int(2), float(3));
      expect(
        grid
          .row(int(0))
          .entries()
          .map(value => value.value),
      ).toEqual([3, 3]);
      expect(
        grid.set(int(0), int(1), float(4)).replacement.get(int(0), int(1))
          .value,
      ).toBe(4);
      const lookup = Lookup.new(context).put(text('key'), float(5)).replacement;
      expect(lookup.get(text('key')).value).toBe(5);
      expect(lookup.keys().get(int(0)).value).toBe('key');
      expect(lookup.remove(text('key')).result.value).toBe(5);
      expect(Pair.create(context, [int(6), text('seven')]).get(1).value).toBe(
        'seven',
      );
      expect(Pair.empty(context).get(0).value).toBeNaN();
    },
  ).bind();
  const context = new Context(module);
  expect(
    context.step({series: [], builtins: [], requests: [], provisional: false})
      .outputs,
  ).toEqual([]);
  context.dispose();
});
