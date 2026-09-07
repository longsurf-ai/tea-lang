// Purpose: Captured Tea values and their arithmetic; expressions never retain a writable series.

import {fatal} from '../../base/print';
import {Color} from '../color';
import type {Context} from './context';
import {isRef, type Ref, type Heap} from './heap';
import {ExecutionError} from '../errors';
import {
  isArrayValue,
  isMatrixValue,
  isMapValue,
  isResourceHandle,
} from '../value';
import type {
  CollectionOperation,
  CollectionMutationOperation,
} from '../module-abi';
import type {
  ArrayValue,
  MatrixValue,
  MapValue,
  ResourceHandle,
  Stored as RawValue,
} from '../value';
const emptyObjects = new WeakMap<Function, object>();

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
  declare readonly ctor?: Function;
  declare readonly element?: Value<unknown>;
  declare readonly key?: Value<unknown>;
  declare readonly elements?: readonly Value<unknown>[];
  declare readonly enumValues?: readonly string[];

  /** @internal Public callers construct values through int, color, struct, etc. */
  constructor(
    readonly value: T,
    readonly kind: K,
    private readonly context?: Context,
    metadata?: Pick<
      Value<unknown>,
      'ctor' | 'element' | 'key' | 'elements' | 'enumValues'
    >,
  ) {
    if (metadata?.ctor) this.ctor = metadata.ctor;
    if (metadata?.element) this.element = metadata.element;
    if (metadata?.key) this.key = metadata.key;
    if (metadata?.elements)
      this.elements = Object.freeze([...metadata.elements]);
    if (metadata?.enumValues)
      this.enumValues = Object.freeze([...metadata.enumValues]);
    Object.freeze(this);
  }

  /** Logical size of this value's carrier; child allocations are counted separately. */
  get byteSize(): number {
    if (this.kind === 'array' || this.kind === 'matrix') return 32;
    if (this.kind === 'map') return 24;
    if (this.kind === 'tuple')
      return (
        16 +
        (this.elements ?? []).reduce((sum, value) => sum + value.byteSize, 0)
      );
    return 8;
  }

  /** Compare declared value domains without a numeric descriptor lookup. */
  sameType(other: Value<unknown>): boolean {
    return (
      other instanceof Value &&
      this.kind === other.kind &&
      this.ctor === other.ctor &&
      (this.enumValues === undefined
        ? other.enumValues === undefined
        : other.enumValues !== undefined &&
          this.enumValues.length === other.enumValues.length &&
          this.enumValues.every(
            (member, i) => member === other.enumValues![i],
          )) &&
      (this.element === undefined
        ? other.element === undefined
        : other.element !== undefined &&
          this.element.sameType(other.element)) &&
      (this.key === undefined
        ? other.key === undefined
        : other.key !== undefined && this.key.sameType(other.key)) &&
      (this.elements === undefined
        ? other.elements === undefined
        : other.elements !== undefined &&
          this.elements.length === other.elements.length &&
          this.elements.every((item, i) => item.sameType(other.elements![i])))
    );
  }

  /** Validate raw values where they enter a declared binding or managed collection. */
  assertStored(value: RawValue, reader?: Pick<Heap, 'read'>): void {
    const bad = (): never => {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `value does not match ${this.kind}`,
      );
    };
    if (value === null) {
      if (this.kind === 'int' || this.kind === 'float' || this.kind === 'bool')
        bad();
      return;
    }
    if (this.kind === 'int' || this.kind === 'float') {
      if (
        typeof value !== 'number' ||
        (!Number.isFinite(value) && !Number.isNaN(value))
      )
        bad();
    } else if (this.kind === 'bool') {
      if (typeof value !== 'boolean') bad();
    } else if (this.kind === 'color') {
      if (!(value instanceof Color)) bad();
    } else if (this.kind === 'string' || this.enumValues !== undefined) {
      if (
        typeof value !== 'string' ||
        (this.enumValues !== undefined && !this.enumValues.includes(value))
      )
        bad();
    } else if (this.ctor !== undefined) {
      if (!isRef(value)) bad();
      if (
        reader &&
        Object.getPrototypeOf(reader.read(value as Ref<object>)) !==
          this.ctor.prototype
      )
        bad();
    } else if (
      this.kind === 'array' ||
      this.kind === 'matrix' ||
      this.kind === 'map'
    ) {
      const valid =
        this.kind === 'array'
          ? isArrayValue(value)
          : this.kind === 'matrix'
            ? isMatrixValue(value)
            : isMapValue(value);
      if (!valid) bad();
      const collection = value as ArrayValue | MatrixValue | MapValue;
      if (!this.element?.sameType(collection.element)) bad();
      if (isMapValue(collection) && !this.key?.sameType(collection.key)) bad();
      if (reader) reader.read(collection.storage as Ref<unknown>);
    } else if (this.kind === 'tuple') {
      if (!Array.isArray(value) || value.length !== this.elements?.length)
        bad();
      this.elements!.forEach((empty, i) => {
        const item = (value as readonly Value<unknown>[])[i];
        if (!empty.sameType(item)) bad();
        empty.assertStored(unwrap(item), reader);
      });
    } else if (
      [
        'Line',
        'Label',
        'Box',
        'Table',
        'Polyline',
        'Linefill',
        'line',
        'label',
        'box',
        'table',
        'polyline',
        'linefill',
      ].includes(this.kind)
    ) {
      if (!isResourceHandle(value) || value.handle !== this.kind) bad();
    } else if (typeof value !== 'string') bad();
  }

  /** @internal Replace a payload while retaining its concrete generic value domain. */
  withStored(value: T, context = this.context): Value<T, K> {
    if (
      Object.is(value, this.value) &&
      (context === this.context ||
        (!this.ctor && !this.element && !this.elements))
    )
      return this;
    this.assertStored(value as RawValue);
    return new Value(value, this.kind, context, this);
  }

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
        (this.value instanceof Color && other.value instanceof Color
          ? this.value.equals(other.value)
          : this.value === other.value),
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
        (this.value instanceof Color && other.value instanceof Color
          ? !this.value.equals(other.value)
          : this.value !== other.value),
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
  /** Validate the captured receiver before evaluating mutating method arguments. */
  require(this: Value<Ref<unknown> | null, K>): Value<T, K> {
    this.owner().storage.requireStruct(
      unwrap(this),
      this.ctor ?? fatal('struct has no constructor'),
    );
    return this as unknown as Value<T, K>;
  }

  /**
   * Capture a named field location. Null reads use the generated class's empty
   * field value; mutation requires a non-null receiver before RHS evaluation.
   * @example `point.require().field('x').set(float(2))` stages a field write.
   */
  field<
    N extends Extract<
      keyof (NonNullable<T> extends Ref<infer S> ? S : never),
      string
    >,
  >(
    name: N,
  ): {
    get(): (NonNullable<T> extends Ref<infer S> ? S : never)[N];
    set(value: (NonNullable<T> extends Ref<infer S> ? S : never)[N]): void;
  } {
    const context = this.owner();
    const ctor = this.ctor ?? fatal('field receiver has no constructor');
    let defaults = emptyObjects.get(ctor);
    if (defaults === undefined) {
      defaults = Reflect.construct(ctor, []);
      emptyObjects.set(ctor, defaults!);
    }
    const empty = (defaults as Record<PropertyKey, Value<unknown>>)[name];
    if (!(empty instanceof Value))
      return fatal(`unknown field '${String(name)}'`);
    const raw = unwrap(this);
    if (raw !== null) context.storage.requireStruct(raw, ctor);
    return {
      get: () => {
        const value = context.storage.structField(
          raw,
          ctor,
          String(name),
          empty,
        );
        return value.withStored(unwrap(value), context);
      },
      set: value =>
        context.storage.storeStructField(
          raw,
          ctor,
          String(name),
          value as Value<unknown>,
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
      : T extends MapValue<Value<unknown>, infer E>
        ? E
        : never {
    if (this.kind === 'tuple') {
      const index = args[0] as number;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= (this.elements?.length ?? 0)
      )
        return fatal('invalid tuple index');
      const value =
        this.value === null
          ? this.elements![index]
          : (this.value as readonly Value<unknown>[])[index];
      return value.withStored(unwrap(value), this.owner()) as never;
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
  ): T extends MapValue<Value<unknown>, infer Item>
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
    result: T extends MapValue<Value<unknown>, infer Item> ? Item : never;
  } {
    return this.mutate('remove', [key as Value<unknown>]) as never;
  }

  /** Snapshot iteration membership before the loop; referenced struct bodies stay live. */
  entries(): readonly (T extends ArrayValue<infer E>
    ? E
    : T extends MapValue<infer Key, infer Item>
      ? readonly [Key, Item]
      : never)[] {
    const context = this.owner();
    return context.storage
      .collectionEntries(unwrap(this))
      .map(item =>
        item instanceof Value
          ? item.withStored(unwrap(item), context)
          : item.map(value => value.withStored(unwrap(value), context)),
      ) as never;
  }

  private owner(): Context {
    return this.context ?? fatal('aggregate value has no execution owner');
  }

  private collection(
    operation: string,
    args: readonly Value<unknown>[],
  ): Value<unknown> {
    const context = this.owner();
    let empty: Value<unknown> = this;
    if (['size', 'rows', 'columns', 'elements_count'].includes(operation))
      empty = int(NaN);
    else if (operation === 'is_empty' || operation === 'contains')
      empty = bool(false);
    else if (operation !== 'copy') {
      const element =
        (operation === 'keys' ? this.key : this.element) ??
        fatal('collection has no element value');
      empty = ['row', 'column', 'keys', 'values'].includes(operation)
        ? array(element).empty(context)
        : element;
    }
    const result = context.storage.callCollection(
      `${this.kind}.${operation}` as CollectionOperation,
      empty,
      [this, ...args],
    );
    return result.withStored(unwrap(result), context);
  }

  private mutate(operation: string, args: readonly Value<unknown>[]) {
    const context = this.owner();
    const changed = context.storage.mutateCollection(
      `${this.kind}.${operation}` as CollectionMutationOperation,
      this,
      args,
    );
    return {
      replacement: capture(context, changed.replacement, this),
      result: changed.result?.withStored(unwrap(changed.result), context),
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

export function color(
  value: string | Color | null,
): Value<Color | null, 'color'> {
  return new Value(
    typeof value === 'string' ? Color.parse(value) : value,
    'color',
  );
}

/** Preserve a generated string enum's identity and accepted member values. */
export function enumeration<T extends string, K extends string>(
  value: T | null,
  kind: K,
  members?: Readonly<Record<string, T>>,
): Value<T | null, K> {
  return new Value(value, kind, undefined, {
    enumValues: members && Object.values(members),
  });
}

/**
 * Capture an opaque resource identity, or its typed missing value. This does
 * not allocate a drawing resource; a host or supported intrinsic owns it.
 * @example `resource(null, 'Line')` is a missing line, distinct from a missing label.
 */
export function resource<K extends string>(
  value: (ResourceHandle & {readonly handle: NoInfer<K>}) | null,
  kind: K,
): Value<ResourceHandle | null, K> {
  const captured = new Value(
    value === null ? null : Object.freeze({...value}),
    kind,
  );
  captured.assertStored(captured.value);
  return captured;
}

/** @internal Attach the execution owner to a value using its existing empty exemplar. */
export function capture<T, K extends string>(
  context: Context,
  raw: RawValue,
  empty: Value<T, K>,
): Value<T, K> {
  return empty.withStored(raw as T, context);
}

/** @internal The raw payload retains typed tuple elements and managed identities. */
export function unwrap(value: Value<unknown>): RawValue {
  return value.value as RawValue;
}

/**
 * Register generated class instances with the Context's managed Heap.
 * @example `struct(Point, 'Point', 24).create(ctx, {x: float(1)})` allocates one Point.
 */
export function struct<S extends object, K extends string>(
  constructor: new (fields?: Omit<S, symbol>) => S,
  kind: K,
  byteSize: number,
) {
  return {
    create(context: Context, fields: Omit<S, symbol>): Value<Ref<S> | null, K> {
      const raw = context.storage.newStruct(new constructor(fields), byteSize);
      return new Value(raw, kind, context, {ctor: constructor});
    },
    empty(context?: Context): Value<Ref<S> | null, K> {
      return new Value(null, kind, context, {ctor: constructor});
    },
  };
}

/** A tuple retains captured elements; missing tuples supply the same typed empties. */
export function tuple<T extends readonly Value<unknown>[]>(elements: T) {
  return {
    create(context: Context, values: T): Value<T | null, 'tuple'> {
      return new Value(
        Object.freeze([...values]) as unknown as T,
        'tuple',
        context,
        {elements},
      );
    },
    empty(context?: Context): Value<T | null, 'tuple'> {
      return new Value(null, 'tuple', context, {elements});
    },
  };
}

/** Array operations reuse one typed missing element; no type registry is consulted. */
export function array<E extends Value<unknown>>(element: E) {
  const empty = (context?: Context): Value<ArrayValue<E> | null, 'array'> =>
    new Value(null, 'array', context, {element});
  return {
    new(
      context: Context,
      size?: Value<number, 'int'>,
      initial?: E,
    ): Value<ArrayValue<E> | null, 'array'> {
      const result = context.storage.callCollection(
        'array.new',
        empty(context),
        size === undefined
          ? []
          : initial === undefined
            ? [size]
            : [size, initial],
      );
      return capture(context, unwrap(result), empty(context));
    },
    from(
      context: Context,
      ...items: readonly E[]
    ): Value<ArrayValue<E> | null, 'array'> {
      const result = context.storage.callCollection(
        'array.from',
        empty(context),
        items,
      );
      return capture(context, unwrap(result), empty(context));
    },
    empty,
  };
}

/** Matrix construction shares the array element contract and checks dimensions. */
export function matrix<E extends Value<unknown>>(element: E) {
  const empty = (context?: Context): Value<MatrixValue<E> | null, 'matrix'> =>
    new Value(null, 'matrix', context, {element});
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
      const result = context.storage.callCollection(
        'matrix.new',
        empty(context),
        shape,
      );
      return capture(context, unwrap(result), empty(context));
    },
    empty,
  };
}

/** Ordered maps retain typed keys and missing values alongside persistent backing. */
export function map<Key extends Value<unknown>, Item extends Value<unknown>>(
  key: Key,
  element: Item,
) {
  const empty = (context?: Context): Value<MapValue<Key, Item> | null, 'map'> =>
    new Value(null, 'map', context, {key, element});
  return {
    new(context: Context): Value<MapValue<Key, Item> | null, 'map'> {
      const result = context.storage.callCollection(
        'map.new',
        empty(context),
        [],
      );
      return capture(context, unwrap(result), empty(context));
    },
    empty,
  };
}
