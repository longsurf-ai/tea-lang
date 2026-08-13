// Purpose: Runtime value domain and source-hidden aggregate/collection headers.

import type {StorageRef} from './heap';
import type {LayoutId, UserTypeLayoutId} from './value-layout';

export interface ResourceHandle {
  readonly kind: 'resource';
  readonly handle: string;
  readonly id: number;
}

export interface UserTypeValue {
  readonly kind: 'user-type';
  readonly layout: UserTypeLayoutId;
  readonly fields: readonly Value[];
}

export interface EffectUserTypeValue {
  readonly kind: 'user-type';
  readonly fields: readonly EffectValue[];
}

export type EffectValue =
  | number
  | string
  | boolean
  | null
  | EffectUserTypeValue;

export function isEffectUserTypeValue(
  value: EffectValue,
): value is EffectUserTypeValue {
  return (
    typeof value === 'object' && value !== null && value.kind === 'user-type'
  );
}

export interface ArrayValue {
  readonly kind: 'array';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly length: number;
  readonly capacity: number;
}

export interface MatrixValue {
  readonly kind: 'matrix';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly rows: number;
  readonly columns: number;
}

export interface MapValue {
  readonly kind: 'map';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly size: number;
}

export type CollectionValue = ArrayValue | MatrixValue | MapValue;

export type Value =
  | number
  | string
  | boolean
  | null
  | ResourceHandle
  | UserTypeValue
  | CollectionValue
  | readonly Value[];

export type ExecutionResult = Value | undefined;

export function isTupleValue(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

function isTaggedValue(
  value: Value,
): value is ResourceHandle | UserTypeValue | CollectionValue {
  return typeof value === 'object' && value !== null && !isTupleValue(value);
}

export function isUserTypeValue(value: Value): value is UserTypeValue {
  return isTaggedValue(value) && value.kind === 'user-type';
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
