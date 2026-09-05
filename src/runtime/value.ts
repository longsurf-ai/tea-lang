// Purpose: Runtime value domain and source-hidden struct/collection carriers.

import {isRef, type Ref} from './js/heap';
import type {ArrayStorage} from './js/collections/array';
import type {MapStorage} from './js/collections/map';
import type {MatrixStorage} from './js/collections/matrix';
import type {StructStorage} from './js/struct-storage';
import type {LayoutId} from './value-layout';

export interface ResourceHandle {
  readonly kind: 'resource';
  readonly handle: string;
  readonly id: number;
}

export type StructValue = Ref<StructStorage> | null;

export interface ArrayValue {
  readonly kind: 'array';
  readonly layout: LayoutId;
  readonly storage: Ref<ArrayStorage>;
  readonly length: number;
  readonly capacity: number;
}

export interface MatrixValue {
  readonly kind: 'matrix';
  readonly layout: LayoutId;
  readonly storage: Ref<MatrixStorage>;
  readonly rows: number;
  readonly columns: number;
}

export interface MapValue {
  readonly kind: 'map';
  readonly layout: LayoutId;
  readonly storage: Ref<MapStorage>;
  readonly size: number;
}

export type CollectionValue = ArrayValue | MatrixValue | MapValue;

export type Value =
  | number
  | string
  | boolean
  | null
  | ResourceHandle
  | Ref<unknown>
  | CollectionValue
  | readonly Value[];

export function isTupleValue(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

function isTaggedValue(
  value: Value,
): value is ResourceHandle | CollectionValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !isTupleValue(value) &&
    !isRef(value)
  );
}

export function isStructRef(value: Value): value is Ref<StructStorage> {
  return isRef(value);
}

export function isArrayValue(value: Value): value is ArrayValue {
  return isTaggedValue(value) && value.kind === 'array';
}

export function isMatrixValue(value: Value): value is MatrixValue {
  return isTaggedValue(value) && value.kind === 'matrix';
}

export function isMapValue(value: Value): value is MapValue {
  return isTaggedValue(value) && value.kind === 'map';
}

export function isResourceHandle(value: Value): value is ResourceHandle {
  return isTaggedValue(value) && value.kind === 'resource';
}

export type ManifestValue = number | string | boolean | null;

export const ValueClass = {
  Numeric: 'numeric',
  Nullable: 'nullable',
  Boolean: 'boolean',
} as const;

export type ValueClass = (typeof ValueClass)[keyof typeof ValueClass];
