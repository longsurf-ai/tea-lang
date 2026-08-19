// Purpose: Shared collection runtime guards, deterministic limits, and sealed-payload tracing helpers.

import {fatal} from '../../base/print';
import {ExecutionError} from '../errors';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  type ArrayValue,
  type CollectionValue,
  type MapValue,
  type MatrixValue,
  type Value,
} from '../value';
import type {Heap, HeapTransaction} from '../heap';
import {
  type LayoutId,
  type ValueLayout,
  ValueLayoutRegistry,
} from '../value-layout';

export interface CollectionContext {
  readonly heap: Heap;
  readonly transaction: HeapTransaction;
  readonly layouts: ValueLayoutRegistry;
  readonly maxElements: number;
}

export function count(value: Value, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ExecutionError('INVALID_SHAPE', `${what} must be a safe integer`);
  }
  return value;
}

export function shape(value: Value, what: string): number {
  const size = count(value, what);
  if (size < 0) {
    throw new ExecutionError('INVALID_SHAPE', `${what} must be non-negative`);
  }
  return size;
}

export function index(value: Value, size: number, what = 'index'): number {
  const result = count(value, what);
  if (result < 0 || result >= size) {
    throw new ExecutionError(
      'INDEX_OUT_OF_BOUNDS',
      `${what} ${result} is outside [0, ${size})`,
    );
  }
  return result;
}

export function assertLimit(size: number, max: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > max) {
    throw new ExecutionError(
      'COLLECTION_LIMIT_EXCEEDED',
      `collection size ${size} exceeds limit ${max}`,
    );
  }
}

export function assertExactLayout(
  actual: LayoutId,
  expected: LayoutId,
  what: string,
): void {
  if (actual !== expected) {
    fatal(`${what} uses result layout ${actual}, expected ${expected}`);
  }
}

export function assertScalarResultLayout(
  layouts: ValueLayoutRegistry,
  id: LayoutId,
  expected: 'int' | 'boolean',
  what: string,
): void {
  const layout = layouts.layout(id);
  const matches =
    expected === 'boolean'
      ? layout.kind === 'boolean'
      : layout.kind === 'number' && layout.numeric === 'int';
  if (!matches) {
    fatal(
      `${what} uses ${layout.kind} result layout ${id}, expected ${expected}`,
    );
  }
}

export function collectionLayout(
  layouts: ValueLayoutRegistry,
  id: LayoutId,
  kind: 'array',
): Extract<ValueLayout, {kind: 'array'}>;
export function collectionLayout(
  layouts: ValueLayoutRegistry,
  id: LayoutId,
  kind: 'matrix',
): Extract<ValueLayout, {kind: 'matrix'}>;
export function collectionLayout(
  layouts: ValueLayoutRegistry,
  id: LayoutId,
  kind: 'map',
): Extract<ValueLayout, {kind: 'map'}>;
export function collectionLayout(
  layouts: ValueLayoutRegistry,
  id: LayoutId,
  kind: 'array' | 'matrix' | 'map',
): Extract<ValueLayout, {kind: 'array' | 'matrix' | 'map'}> {
  const layout = layouts.layout(id);
  if (layout.kind !== kind) {
    return fatal(`layout ${id} is ${layout.kind}, expected ${kind}`);
  }
  return layout;
}

export function requireCollection<C extends CollectionValue['kind']>(
  layouts: ValueLayoutRegistry,
  value: Value,
  id: LayoutId,
  kind: C,
): Extract<CollectionValue, {kind: C}> {
  if (value === null) {
    throw new ExecutionError('NA_COLLECTION', `${kind} operation on na`);
  }
  layouts.assertValue(id, value, `${kind} receiver`);
  const matches =
    (kind === 'array' && isArrayValue(value)) ||
    (kind === 'matrix' && isMatrixValue(value)) ||
    (kind === 'map' && isMapValue(value));
  if (!matches) {
    return fatal(`layout ${id} validated a non-${kind} collection`);
  }
  return value as Extract<CollectionValue, {kind: C}>;
}

export function arrayValue(
  layout: LayoutId,
  storage: ArrayValue['storage'],
  length: number,
  capacity: number,
): ArrayValue {
  return Object.freeze({kind: 'array', layout, storage, length, capacity});
}

export function matrixValue(
  layout: LayoutId,
  storage: MatrixValue['storage'],
  rows: number,
  columns: number,
): MatrixValue {
  return Object.freeze({kind: 'matrix', layout, storage, rows, columns});
}

export function mapValue(
  layout: LayoutId,
  storage: MapValue['storage'],
  size: number,
): MapValue {
  return Object.freeze({kind: 'map', layout, storage, size});
}
