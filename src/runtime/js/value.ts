// Purpose: Captured Tea values and their arithmetic; expressions never retain a writable series.

import {fatal} from '../../base/print';
import type {Context} from './context';
import type {Ref} from './heap';
import type {
  CollectionOperation,
  CollectionMutationOperation,
} from '../module-abi';
import type {
  ArrayValue,
  MatrixValue,
  MapValue,
  Stored as RawValue,
} from '../value';
import type {StorageType} from '../storage-types';

/** Tea's numeric kind controls promotion and integer division. */
export type Numeric = 'int' | 'float';

/**
 * One captured value. Rebinding a local or writing a Series cannot change it.
 * Reference values retain their managed identity; capture never clones a body.
 * Managed operations require an active step; output destinations detach values
 * for callers that retain them beyond execution.
 * @example `int(7).div(int(2)).value` is 3; dividing by float(2) produces 3.5.
 */
export class Value<T, K extends string = string> {
  constructor(
    readonly value: T,
    readonly kind: K,
    private readonly context?: Context,
    private readonly layout?: number,
  ) {}

  /**
   * Add captured numbers. A float operand promotes the result; neither operand changes.
   * @example `int(2).add(float(0.5)).value` is 2.5.
   */
  add<N extends Numeric, M extends Numeric>(
    this: Value<number, N>,
    other: Value<number, M>,
  ): Value<number, N extends 'float' ? 'float' : M> {
    return number(this.value + other.value, this, other);
  }

  sub<N extends Numeric, M extends Numeric>(
    this: Value<number, N>,
    other: Value<number, M>,
  ): Value<number, N extends 'float' ? 'float' : M> {
    return number(this.value - other.value, this, other);
  }

  mul<N extends Numeric, M extends Numeric>(
    this: Value<number, N>,
    other: Value<number, M>,
  ): Value<number, N extends 'float' ? 'float' : M> {
    return number(this.value * other.value, this, other);
  }

  /**
   * Divide using Tea rules: integer division truncates toward zero and zero yields NA.
   * @example `int(-7).div(int(2)).value` is -3.
   */
  div<N extends Numeric, M extends Numeric>(
    this: Value<number, N>,
    other: Value<number, M>,
  ): Value<number, N extends 'float' ? 'float' : M> {
    const quotient = other.value === 0 ? NaN : this.value / other.value;
    return number(
      this.kind === 'int' && other.kind === 'int'
        ? Math.trunc(quotient)
        : quotient,
      this,
      other,
    );
  }

  mod<N extends Numeric, M extends Numeric>(
    this: Value<number, N>,
    other: Value<number, M>,
  ): Value<number, N extends 'float' ? 'float' : M> {
    return number(
      other.value === 0 ? NaN : this.value % other.value,
      this,
      other,
    );
  }

  neg<N extends Numeric>(this: Value<number, N>): Value<number, N> {
    return new Value(finite(-this.value), this.kind);
  }

  concat(
    this: Value<string | null, 'string'>,
    other: Value<string | null, 'string'>,
  ): Value<string | null, 'string'> {
    return text(
      this.value === null || other.value === null
        ? null
        : this.value + other.value,
    );
  }

  /** Equality involving a missing value is false, including two missing values. */
  eq(
    other: Value<
      T extends string ? string | null : T,
      K extends Numeric ? Numeric : K
    >,
  ): Value<boolean, 'bool'> {
    return bool(
      !missing(this.value) &&
        !missing(other.value) &&
        this.value === other.value,
    );
  }

  /** Inequality involving a missing value is also false. Use na() to test missingness. */
  ne(
    other: Value<
      T extends string ? string | null : T,
      K extends Numeric ? Numeric : K
    >,
  ): Value<boolean, 'bool'> {
    return bool(
      !missing(this.value) &&
        !missing(other.value) &&
        this.value !== other.value,
    );
  }

  lt(
    this: Value<number, Numeric>,
    other: Value<number, Numeric>,
  ): Value<boolean, 'bool'> {
    return bool(this.value < other.value);
  }

  le(
    this: Value<number, Numeric>,
    other: Value<number, Numeric>,
  ): Value<boolean, 'bool'> {
    return bool(this.value <= other.value);
  }

  gt(
    this: Value<number, Numeric>,
    other: Value<number, Numeric>,
  ): Value<boolean, 'bool'> {
    return bool(this.value > other.value);
  }

  ge(
    this: Value<number, Numeric>,
    other: Value<number, Numeric>,
  ): Value<boolean, 'bool'> {
    return bool(this.value >= other.value);
  }

  not(this: Value<boolean, 'bool'>): Value<boolean, 'bool'> {
    return bool(!this.value);
  }
  /** Capture the receiver before evaluating arguments to a mutating Tea method. */
  require(this: Value<Ref<unknown> | null, K>): Value<T, K> {
    const {context, layout} = this.owner();
    context.storage.requireStruct(unwrap(this), layout);
    return this as unknown as Value<T, K>;
  }

  /**
   * A field location captures reference identity, not the current field value.
   * Reads on NA return the field's typed empty. For writes, call require() before
   * evaluating the right-hand side, then write through this location.
   * @example `const x = point.require().field('x'); x.set(float(2));`
   */
  field<N extends keyof (NonNullable<T> extends Ref<infer S> ? S : never)>(
    name: N,
  ): {
    get(): (NonNullable<T> extends Ref<infer S> ? S : never)[N];
    set(value: (NonNullable<T> extends Ref<infer S> ? S : never)[N]): void;
  } {
    const {context, layout} = this.owner();
    const descriptor = context.layouts.layout(layout);
    if (descriptor.kind !== 'struct')
      return fatal('field receiver is not a struct');
    const index = descriptor.fields.findIndex(field => field.name === name);
    if (index < 0) return fatal(`unknown field '${String(name)}'`);
    const raw = unwrap(this);
    if (raw !== null) context.storage.requireStruct(raw, layout);
    return {
      get: () =>
        context.capture(
          context.storage.structField(raw, layout, index),
          descriptor.fields[index].layout,
        ),
      set: value =>
        context.storage.storeStructField(
          raw,
          layout,
          index,
          unwrap(value as Value<unknown>),
        ),
    } as {
      get(): (NonNullable<T> extends Ref<infer S> ? S : never)[N];
      set(value: (NonNullable<T> extends Ref<infer S> ? S : never)[N]): void;
    };
  }

  /**
   * Read a collection element or a tuple member as a captured value.
   * @example `prices.get(int(0))` reads the first array item; `pair.get(1)` reads a tuple member.
   */
  get<I extends number>(
    ...args: T extends readonly Value<unknown>[]
      ? [index: I]
      : T extends ArrayValue
        ? [index: Value<number, 'int'>]
        : T extends MatrixValue
          ? [row: Value<number, 'int'>, column: Value<number, 'int'>]
          : T extends MapValue<infer Key>
            ? [key: Key]
            : never
  ): T extends readonly Value<unknown>[]
    ? T[I]
    : T extends ArrayValue<infer E> | MatrixValue<infer E>
      ? E
      : T extends MapValue<unknown, infer E>
        ? E
        : never {
    const {context, layout} = this.owner();
    const descriptor = context.layouts.layout(layout);
    if (descriptor.kind === 'tuple') {
      const index = args[0] as number;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= descriptor.elements.length
      )
        return fatal('invalid tuple index');
      return (
        this.value === null
          ? context.capture(
              context.layouts.empty(descriptor.elements[index]),
              descriptor.elements[index],
            )
          : (this.value as readonly unknown[])[index]
      ) as never;
    }
    return this.collection('get', args as readonly Value<unknown>[]) as never;
  }

  size(this: Value<ArrayValue | MapValue | null>): Value<number, 'int'> {
    return this.collection('size', []) as Value<number, 'int'>;
  }

  isEmpty(this: Value<ArrayValue | MapValue | null>): Value<boolean, 'bool'> {
    return this.collection('is_empty', []) as Value<boolean, 'bool'>;
  }

  first(
    this: Value<ArrayValue | null, K>,
  ): T extends ArrayValue<infer E> ? E : never {
    return this.collection('first', []) as never;
  }

  last(
    this: Value<ArrayValue | null, K>,
  ): T extends ArrayValue<infer E> ? E : never {
    return this.collection('last', []) as never;
  }

  copy(
    this: Value<ArrayValue | MatrixValue | MapValue | null, K>,
  ): Value<T, K> {
    return this.collection('copy', []) as Value<T, K>;
  }

  rows(this: Value<MatrixValue | null>): Value<number, 'int'> {
    return this.collection('rows', []) as Value<number, 'int'>;
  }

  columns(this: Value<MatrixValue | null>): Value<number, 'int'> {
    return this.collection('columns', []) as Value<number, 'int'>;
  }

  elementsCount(this: Value<MatrixValue | null>): Value<number, 'int'> {
    return this.collection('elements_count', []) as Value<number, 'int'>;
  }

  row(
    index: Value<number, 'int'>,
  ): T extends MatrixValue<infer E>
    ? Value<ArrayValue<E> | null, 'array'>
    : never {
    return this.collection('row', [index]) as never;
  }

  column(
    index: Value<number, 'int'>,
  ): T extends MatrixValue<infer E>
    ? Value<ArrayValue<E> | null, 'array'>
    : never {
    return this.collection('column', [index]) as never;
  }

  contains(
    key: T extends MapValue<infer Key> ? Key : never,
  ): Value<boolean, 'bool'> {
    return this.collection('contains', [key as Value<unknown>]) as Value<
      boolean,
      'bool'
    >;
  }

  keys(
    this: Value<MapValue | null, K>,
  ): T extends MapValue<infer Key>
    ? Value<ArrayValue<Key> | null, 'array'>
    : never {
    return this.collection('keys', []) as never;
  }

  values(
    this: Value<MapValue | null, K>,
  ): T extends MapValue<unknown, infer Item>
    ? Value<ArrayValue<Item> | null, 'array'>
    : never {
    return this.collection('values', []) as never;
  }

  set(
    ...args: T extends ArrayValue<infer E>
      ? [index: Value<number, 'int'>, value: E]
      : T extends MatrixValue<infer E>
        ? [row: Value<number, 'int'>, column: Value<number, 'int'>, value: E]
        : never
  ): {replacement: Value<T, K>; result: undefined} {
    return this.mutate('set', args as readonly Value<unknown>[]) as never;
  }

  push(item: T extends ArrayValue<infer E> ? E : never): {
    replacement: Value<T, K>;
    result: undefined;
  } {
    return this.mutate('push', [item as Value<unknown>]) as never;
  }

  pop(this: Value<ArrayValue | null, K>): {
    replacement: Value<T, K>;
    result: T extends ArrayValue<infer E> ? E : never;
  } {
    return this.mutate('pop', []) as never;
  }

  clear(this: Value<ArrayValue | MapValue | null, K>): {
    replacement: Value<T, K>;
    result: undefined;
  } {
    return this.mutate('clear', []) as never;
  }

  fill(item: T extends MatrixValue<infer E> ? E : never): {
    replacement: Value<T, K>;
    result: undefined;
  } {
    return this.mutate('fill', [item as Value<unknown>]) as never;
  }

  put(
    ...args: T extends MapValue<infer Key, infer Item>
      ? [key: Key, value: Item]
      : never
  ): {replacement: Value<T, K>; result: undefined} {
    return this.mutate('put', args as readonly Value<unknown>[]) as never;
  }

  remove(key: T extends MapValue<infer Key> ? Key : never): {
    replacement: Value<T, K>;
    result: T extends MapValue<unknown, infer Item> ? Item : never;
  } {
    return this.mutate('remove', [key as Value<unknown>]) as never;
  }

  /** Snapshot iteration membership before the loop; referenced struct bodies stay live. */
  entries(): readonly (T extends ArrayValue<infer E>
    ? E
    : T extends MapValue<infer Key, infer Item>
      ? readonly [Key, Item]
      : never)[] {
    const {context, layout} = this.owner();
    const descriptor = context.layouts.layout(layout);
    const entries = context.storage.collectionEntries(unwrap(this));
    if (descriptor.kind === 'array') {
      return entries.map(value =>
        context.capture(value as RawValue, descriptor.element),
      ) as never;
    }
    if (descriptor.kind === 'map') {
      return (entries as readonly (readonly [RawValue, RawValue])[]).map(
        ([key, value]) =>
          [
            context.capture(key, descriptor.key),
            context.capture(value, descriptor.value),
          ] as const,
      ) as never;
    }
    return fatal('iteration receiver is not an array or map');
  }

  private owner(): {context: Context; layout: number} {
    if (this.context === undefined || this.layout === undefined)
      return fatal('aggregate value has no execution owner');
    return {context: this.context, layout: this.layout};
  }

  private collection(
    operation: string,
    args: readonly Value<unknown>[],
  ): Value<unknown> {
    const {context, layout} = this.owner();
    const descriptor = context.layouts.layout(layout);
    if (
      descriptor.kind !== 'array' &&
      descriptor.kind !== 'matrix' &&
      descriptor.kind !== 'map'
    )
      return fatal('collection receiver has invalid storage type');
    let result: number;
    if (operation === 'copy') result = layout;
    else if (['size', 'rows', 'columns', 'elements_count'].includes(operation))
      result = findLayout(
        context,
        item => item.kind === 'number' && item.numeric === 'int',
      );
    else if (operation === 'is_empty' || operation === 'contains')
      result = findLayout(context, item => item.kind === 'boolean');
    else {
      const element =
        descriptor.kind === 'map'
          ? operation === 'keys'
            ? descriptor.key
            : descriptor.value
          : descriptor.element;
      result = ['row', 'column', 'keys', 'values'].includes(operation)
        ? findLayout(
            context,
            item => item.kind === 'array' && item.element === element,
          )
        : element;
    }
    const raw = context.storage.callCollection(
      `${descriptor.kind}.${operation}` as CollectionOperation,
      result,
      [unwrap(this), ...args.map(unwrap)],
    );
    return context.capture(raw, result);
  }

  private mutate(operation: string, args: readonly Value<unknown>[]) {
    const {context, layout} = this.owner();
    const descriptor = context.layouts.layout(layout);
    if (
      descriptor.kind !== 'array' &&
      descriptor.kind !== 'matrix' &&
      descriptor.kind !== 'map'
    )
      return fatal('mutation receiver has invalid storage type');
    const changed = context.storage.mutateCollection(
      `${descriptor.kind}.${operation}` as CollectionMutationOperation,
      layout,
      unwrap(this),
      args.map(unwrap),
    );
    const element =
      descriptor.kind === 'map' ? descriptor.value : descriptor.element;
    return {
      replacement: context.capture(changed.replacement, layout),
      result:
        changed.result === undefined
          ? undefined
          : context.capture(changed.result, element),
    };
  }
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : NaN;
}

function missing(value: unknown): boolean {
  return value === null || Number.isNaN(value);
}

function number<N extends Numeric, M extends Numeric>(
  value: number,
  left: Value<number, N>,
  right: Value<number, M>,
): Value<number, N extends 'float' ? 'float' : M> {
  const kind =
    left.kind === 'float' || right.kind === 'float' ? 'float' : 'int';
  return new Value(finite(value), kind) as Value<
    number,
    N extends 'float' ? 'float' : M
  >;
}

/**
 * Construct an integer value; conversions truncate toward zero.
 * @example `int(-1.9).value` is -1.
 */
export function int(
  value: number | Value<number, Numeric>,
): Value<number, 'int'> {
  return new Value(
    finite(Math.trunc(value instanceof Value ? value.value : value)),
    'int',
  );
}

/**
 * Construct a float value; non-finite results are Tea's numeric missing value.
 * @example `float(Infinity).value` is NaN.
 */
export function float(
  value: number | Value<number, Numeric>,
): Value<number, 'float'> {
  return new Value(
    finite(value instanceof Value ? value.value : value),
    'float',
  );
}

export function bool(value: boolean): Value<boolean, 'bool'> {
  return new Value(value, 'bool');
}

export function text(value: string | null): Value<string | null, 'string'> {
  return new Value(value, 'string');
}

export function color(value: string | null): Value<string | null, 'color'> {
  return new Value(value, 'color');
}

/** Nominal enum identity is carried by K, independently of its string members. */
export function enumeration<T extends string, K extends string>(
  value: T | null,
  kind: K,
): Value<T | null, K> {
  return new Value(value, kind);
}

/** @internal Capture the runtime carrier without copying managed reference bodies. */
export function capture<T, K extends string>(
  context: Context,
  raw: RawValue,
  layout: number,
): Value<T, K> {
  const descriptor = context.layouts.layout(layout);
  const kind =
    descriptor.kind === 'number'
      ? descriptor.numeric
      : descriptor.kind === 'boolean'
        ? 'bool'
        : descriptor.kind === 'nullable-scalar'
          ? descriptor.scalar
          : descriptor.kind === 'enum' || descriptor.kind === 'struct'
            ? (descriptor.typeId ?? descriptor.name)
            : descriptor.kind === 'resource'
              ? descriptor.handle
              : descriptor.kind;
  const value =
    descriptor.kind === 'tuple' && raw !== null
      ? (raw as readonly RawValue[]).map((item, index) =>
          capture(context, item, descriptor.elements[index]),
        )
      : raw;
  const retained =
    descriptor.kind === 'struct' ||
    descriptor.kind === 'tuple' ||
    descriptor.kind === 'array' ||
    descriptor.kind === 'matrix' ||
    descriptor.kind === 'map';
  return new Value(
    value,
    kind,
    retained ? context : undefined,
    retained ? layout : undefined,
  ) as Value<T, K>;
}

/** @internal Convert a captured value to the existing Heap/history carrier. */
export function unwrap(value: Value<unknown>): RawValue {
  return Array.isArray(value.value)
    ? value.value.map(item =>
        item instanceof Value ? unwrap(item) : (item as RawValue),
      )
    : (value.value as RawValue);
}

function findLayout(
  context: Context,
  matches: (layout: StorageType) => boolean,
): number {
  for (let id = 0; id < context.layouts.length; id += 1) {
    if (matches(context.layouts.layout(id))) return id;
  }
  return fatal('collection result storage type is absent');
}

/**
 * A typed constructor for one nominal struct in the program's storage table.
 * @example `const Point = struct<Point, 'Point'>(4, 'Point'); Point.create(ctx, {x: float(1)});`
 */
export function struct<
  S extends {[P in keyof S]: Value<unknown>},
  K extends string,
>(layout: number, kind: K) {
  return {
    create(context: Context, fields: S): Value<Ref<S> | null, K> {
      const descriptor = context.layouts.layout(layout);
      if (descriptor.kind !== 'struct')
        return fatal('struct constructor has invalid storage type');
      const raw = context.storage.newStruct(
        layout,
        descriptor.fields.map(field => unwrap(fields[field.name as keyof S])),
      );
      return new Value(raw as Ref<S>, kind, context, layout);
    },
    empty(context: Context): Value<Ref<S> | null, K> {
      return new Value(null, kind, context, layout);
    },
  };
}

/** Construct a captured tuple; element captures remain independent of later writes. */
export function tuple<T extends readonly Value<unknown>[]>(layout: number) {
  return {
    create(context: Context, values: T): Value<T | null, 'tuple'> {
      return new Value(
        Object.freeze([...values]) as unknown as T,
        'tuple',
        context,
        layout,
      );
    },
    empty(context: Context): Value<T | null, 'tuple'> {
      return new Value(null, 'tuple', context, layout);
    },
  };
}

/**
 * Array constructors keep element typing while sharing the existing persistent backing.
 * @example `array<Value<number, 'float'>>(layout).from(ctx, float(1), float(2))`.
 */
export function array<E extends Value<unknown>>(layout: number) {
  return {
    new(
      context: Context,
      size?: Value<number, 'int'>,
      initial?: E,
    ): Value<ArrayValue<E> | null, 'array'> {
      const args =
        size === undefined
          ? []
          : initial === undefined
            ? [unwrap(size)]
            : [unwrap(size), unwrap(initial)];
      return context.capture(
        context.storage.callCollection('array.new', layout, args),
        layout,
      );
    },
    from(
      context: Context,
      ...items: readonly E[]
    ): Value<ArrayValue<E> | null, 'array'> {
      return context.capture(
        context.storage.callCollection('array.from', layout, items.map(unwrap)),
        layout,
      );
    },
    empty(context: Context): Value<ArrayValue<E> | null, 'array'> {
      return context.capture(null, layout);
    },
  };
}

/** Matrix construction uses the same element validation and size limits as Tea. */
export function matrix<E extends Value<unknown>>(layout: number) {
  return {
    new(
      context: Context,
      ...shape:
        | []
        | [
            rows: Value<number, 'int'>,
            columns: Value<number, 'int'>,
            initial: E,
          ]
    ): Value<MatrixValue<E> | null, 'matrix'> {
      const args = shape.map(unwrap);
      return context.capture(
        context.storage.callCollection('matrix.new', layout, args),
        layout,
      );
    },
    empty(context: Context): Value<MatrixValue<E> | null, 'matrix'> {
      return context.capture(null, layout);
    },
  };
}

/** Ordered-map constructors preserve the declared key and item domains. */
export function map<Key extends Value<unknown>, Item extends Value<unknown>>(
  layout: number,
) {
  return {
    new(context: Context): Value<MapValue<Key, Item> | null, 'map'> {
      return context.capture(
        context.storage.callCollection('map.new', layout, []),
        layout,
      );
    },
    empty(context: Context): Value<MapValue<Key, Item> | null, 'map'> {
      return context.capture(null, layout);
    },
  };
}
