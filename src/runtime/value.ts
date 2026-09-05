// Purpose: Runtime value domain and source-hidden struct/collection carriers.

import {isRef, type Ref} from './js/heap';
import type {ArrayStorage} from './js/collections/array';
import type {MapStorage} from './js/collections/map';
import type {MatrixStorage} from './js/collections/matrix';
import type {StructStorage} from './js/struct-storage';

export interface ResourceHandle {
  readonly kind: 'resource';
  readonly handle: string;
  readonly id: number;
}

// Element and key domains are type-only; headers keep their existing storage shape.
declare const element: unique symbol;
declare const key: unique symbol;

/** Immutable array header; a mutation returns a replacement over persistent backing. */
export interface ArrayValue<T = unknown> {
  readonly [element]?: T;
  readonly kind: 'array';
  readonly layout: number;
  readonly storage: Ref<ArrayStorage>;
  readonly length: number;
  readonly capacity: number;
}

/** Immutable row-major matrix header with a statically known element domain. */
export interface MatrixValue<T = unknown> {
  readonly [element]?: T;
  readonly kind: 'matrix';
  readonly layout: number;
  readonly storage: Ref<MatrixStorage>;
  readonly rows: number;
  readonly columns: number;
}

/** Immutable ordered-map header; key and item domains survive value copies. */
export interface MapValue<K = unknown, V = unknown> {
  readonly [key]?: K;
  readonly [element]?: V;
  readonly kind: 'map';
  readonly layout: number;
  readonly storage: Ref<MapStorage>;
  readonly size: number;
}

export type CollectionValue = ArrayValue | MatrixValue | MapValue;

export type Stored =
  | number
  | string
  | boolean
  | null
  | ResourceHandle
  | Ref<unknown>
  | CollectionValue
  | readonly Stored[];

export function isTupleValue(value: Stored): value is readonly Stored[] {
  return Array.isArray(value);
}

function isTaggedValue(
  value: Stored,
): value is ResourceHandle | CollectionValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !isTupleValue(value) &&
    !isRef(value)
  );
}

export function isStructRef(value: Stored): value is Ref<StructStorage> {
  return isRef(value);
}

export function isArrayValue(value: Stored): value is ArrayValue {
  return isTaggedValue(value) && value.kind === 'array';
}

export function isMatrixValue(value: Stored): value is MatrixValue {
  return isTaggedValue(value) && value.kind === 'matrix';
}

export function isMapValue(value: Stored): value is MapValue {
  return isTaggedValue(value) && value.kind === 'map';
}

export function isResourceHandle(value: Stored): value is ResourceHandle {
  return isTaggedValue(value) && value.kind === 'resource';
}

export type Scalar = number | string | boolean | null;

export const ValueClass = {
  Numeric: 'numeric',
  Nullable: 'nullable',
  Boolean: 'boolean',
} as const;

export type ValueClass = (typeof ValueClass)[keyof typeof ValueClass];
