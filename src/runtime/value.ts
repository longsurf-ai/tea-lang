// JavaScript payloads carried by captured Values and retained Series.

import {isRef, type Ref} from './js/heap';
import {Value} from './js/value';
import {ExecutionError} from './errors';
import type {Color} from './color';
import type {ArrayStorage} from './js/collections/array';
import type {MapStorage} from './js/collections/map';
import type {MatrixStorage} from './js/collections/matrix';

export interface ResourceHandle {
  readonly kind: 'resource';
  readonly handle: string;
  readonly id: number;
}

/**
 * Immutable array header over captured elements in the Heap. Mutations return
 * another header; aliases retain their original contents. The empty element
 * supplies the missing value and its generic type without a type-table lookup.
 * @example An empty int array retains int(NaN) as its element, even at length 0.
 */
export class ArrayValue<T extends Value<unknown> = Value<unknown>> {
  readonly kind = 'array';
  constructor(
    readonly element: T,
    readonly storage: Ref<ArrayStorage>,
    readonly length: number,
    readonly capacity = length,
  ) {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(capacity) ||
      capacity < length
    )
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        'invalid array length or capacity',
      );
    Object.freeze(this);
  }
}

/** Fixed-shape row-major matrix; a write creates replacement Heap backing. */
export class MatrixValue<T extends Value<unknown> = Value<unknown>> {
  readonly kind = 'matrix';
  constructor(
    readonly element: T,
    readonly storage: Ref<MatrixStorage>,
    readonly rows: number,
    readonly columns: number,
  ) {
    if (
      !Number.isSafeInteger(rows) ||
      rows < 0 ||
      !Number.isSafeInteger(columns) ||
      columns < 0 ||
      !Number.isSafeInteger(rows * columns)
    )
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        'invalid matrix dimensions',
      );
    Object.freeze(this);
  }
}

/**
 * Insertion-ordered map with immutable backing. Empty key and element Values
 * retain their generic types; actual keys cannot be missing.
 * @example Updating an existing key preserves its position in iteration order.
 */
export class MapValue<
  K extends Value<unknown> = Value<unknown>,
  V extends Value<unknown> = Value<unknown>,
> {
  readonly kind = 'map';
  constructor(
    readonly key: K,
    readonly element: V,
    readonly storage: Ref<MapStorage>,
    readonly size: number,
  ) {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new ExecutionError('VALUE_LAYOUT_MISMATCH', 'invalid map size');
    Object.freeze(this);
  }
}

export type CollectionValue = ArrayValue | MatrixValue | MapValue;

export type Stored =
  | number
  | Color
  | string
  | boolean
  | null
  | ResourceHandle
  | Ref<unknown>
  | CollectionValue
  | readonly Value<unknown>[];

export function isTupleValue(
  value: unknown,
): value is readonly Value<unknown>[] {
  return Array.isArray(value);
}

export function isStructRef(value: unknown): value is Ref<object> {
  return isRef(value);
}

export function isArrayValue(value: unknown): value is ArrayValue {
  return value instanceof ArrayValue;
}

export function isMatrixValue(value: unknown): value is MatrixValue {
  return value instanceof MatrixValue;
}

export function isMapValue(value: unknown): value is MapValue {
  return value instanceof MapValue;
}

export function isResourceHandle(value: unknown): value is ResourceHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'resource'
  );
}

/**
 * Visit direct Heap references carried by a captured value, tuple or collection.
 * Heap traversal follows referenced bodies and handles shared/cyclic graphs.
 * @example An array visits its backing Ref; that backing traces its elements.
 */
export function visitValueRefs(
  value: unknown,
  visit: (ref: Ref<unknown>) => void,
): void {
  if (value instanceof Value) visitValueRefs(value.value, visit);
  else if (isRef(value)) visit(value);
  else if (isArrayValue(value) || isMatrixValue(value) || isMapValue(value))
    visit(value.storage);
  else if (isTupleValue(value))
    value.forEach(item => visitValueRefs(item, visit));
}

export type Scalar = number | string | boolean | null;
