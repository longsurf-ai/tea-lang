// Shared bounds and ownership checks for typed collection operations.

import {fatal} from '../../../base/print';
import {ExecutionError} from '../../errors';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  type CollectionValue,
  type Stored,
} from '../../value';
import type {Heap, HeapTransaction} from '../heap';
import type {Value} from '../value';

export interface CollectionReadContext {
  readonly transaction: Pick<Heap, 'read'>;
}

export interface CollectionContext extends CollectionReadContext {
  readonly transaction: HeapTransaction;
  readonly maxElements: number;
}

export function count(value: Value<unknown>, what: string): number {
  if (typeof value.value !== 'number' || !Number.isSafeInteger(value.value))
    throw new ExecutionError('INVALID_SHAPE', `${what} must be a safe integer`);
  return value.value;
}

export function shape(value: Value<unknown>, what: string): number {
  const size = count(value, what);
  if (size < 0)
    throw new ExecutionError('INVALID_SHAPE', `${what} must be non-negative`);
  return size;
}

export function index(
  value: Value<unknown>,
  size: number,
  what = 'index',
): number {
  const result = count(value, what);
  if (result < 0 || result >= size)
    throw new ExecutionError(
      'INDEX_OUT_OF_BOUNDS',
      `${what} ${result} is outside [0, ${size})`,
    );
  return result;
}

export function assertLimit(size: number, max: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > max)
    throw new ExecutionError(
      'COLLECTION_LIMIT_EXCEEDED',
      `collection size ${size} exceeds limit ${max}`,
    );
}

export function assertType(
  ctx: CollectionReadContext,
  expected: Value<unknown>,
  value: Value<unknown>,
  where: string,
): void {
  if (!expected.sameType(value))
    throw new ExecutionError(
      'VALUE_LAYOUT_MISMATCH',
      `${where} expects ${expected.kind}, received ${value.kind}`,
    );
  expected.assertStored(value.value as Stored, ctx.transaction);
}

export function requireCollection<C extends CollectionValue['kind']>(
  ctx: CollectionReadContext,
  value: Value<unknown> | undefined,
  kind: C,
): Extract<CollectionValue, {kind: C}> {
  if (value === undefined)
    return fatal(`${kind} operation is missing its receiver`);
  if (value.value === null)
    throw new ExecutionError('NA_COLLECTION', `${kind} operation on na`);
  const raw = value.value;
  const matches =
    (kind === 'array' && isArrayValue(raw)) ||
    (kind === 'matrix' && isMatrixValue(raw)) ||
    (kind === 'map' && isMapValue(raw));
  if (!matches)
    return fatal(`${kind} operation received a non-${kind} receiver`);
  value.assertStored(raw as Stored, ctx.transaction);
  return raw as Extract<CollectionValue, {kind: C}>;
}

export function requireArgs(
  operation: string,
  args: readonly Value<unknown>[],
  expected: number,
): void {
  if (args.length !== expected)
    fatal(
      `${operation} received ${args.length} arguments, expected ${expected}`,
    );
}
