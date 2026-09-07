// Persistent array operations copy backing; prior headers never change.

import {fatal} from '../../../base/print';
import {ExecutionError} from '../../errors';
import type {CollectionMutation} from '../../module-abi';
import {
  ArrayValue,
  isArrayValue,
  visitValueRefs,
  type Stored,
} from '../../value';
import type {TypeInfo} from '../heap';
import {Value, int, bool} from '../value';
import {
  assertType,
  assertLimit,
  index,
  requireArgs,
  requireCollection,
  shape,
  type CollectionContext,
  type CollectionReadContext,
} from './common';

export interface ArrayStorage {
  readonly values: readonly Value<unknown>[];
  readonly logicalBytes: number;
}

export const ARRAY_STORAGE: TypeInfo<ArrayStorage, ArrayStorage> = {
  id: Symbol('tea.array.storage'),
  name: 'array storage',
  bytesFor: args => args.logicalBytes,
  create: args =>
    Object.freeze({
      values: Object.freeze([...args.values]),
      logicalBytes: args.logicalBytes,
    }),
  trace: (payload, visit) =>
    payload.values.forEach(value => visitValueRefs(value, visit)),
  bytesOf: payload => payload.logicalBytes,
};

export function arrayCall(
  ctx: CollectionContext,
  operation: string,
  result: Value<unknown>,
  args: readonly Value<unknown>[],
): Stored | Value<unknown> {
  if (operation === 'array.new' || operation === 'array.from') {
    const element =
      result.element ?? fatal('array constructor requires an empty element');
    if (operation === 'array.from') return createArray(ctx, element, args);
    if (args.length === 0) return createArray(ctx, element, []);
    if (args.length !== 1 && args.length !== 2)
      return fatal(`array.new received ${args.length} arguments`);
    const size = shape(args[0], 'array size');
    assertLimit(size, ctx.maxElements);
    const initial = args[1] ?? element;
    assertType(ctx, element, initial, 'array initial value');
    return createArray(
      ctx,
      element,
      Array.from({length: size}, () => initial),
    );
  }
  const receiver = requireCollection(ctx, args[0], 'array');
  switch (operation) {
    case 'array.size':
      requireArgs(operation, args, 1);
      return int(receiver.length);
    case 'array.is_empty':
      requireArgs(operation, args, 1);
      return bool(receiver.length === 0);
    case 'array.get':
      requireArgs(operation, args, 2);
      return values(ctx, receiver)[index(args[1], receiver.length)];
    case 'array.first':
      requireArgs(operation, args, 1);
      assertNotEmpty(receiver);
      return values(ctx, receiver)[0];
    case 'array.last':
      requireArgs(operation, args, 1);
      assertNotEmpty(receiver);
      return values(ctx, receiver)[receiver.length - 1];
    case 'array.copy':
      requireArgs(operation, args, 1);
      return new ArrayValue(
        receiver.element,
        receiver.storage,
        receiver.length,
        receiver.capacity,
      );
    default:
      return fatal(`unknown non-mutating array operation '${operation}'`);
  }
}

export function arrayMutate(
  ctx: CollectionContext,
  operation: string,
  value: Value<unknown>,
  args: readonly Value<unknown>[],
): CollectionMutation {
  const receiver = requireCollection(ctx, value, 'array');
  const old = values(ctx, receiver);
  switch (operation) {
    case 'array.set': {
      requireArgs(operation, args, 2);
      const at = index(args[0], receiver.length);
      assertType(ctx, receiver.element, args[1], 'array.set value');
      const next = [...old];
      next[at] = args[1];
      return {replacement: replace(ctx, receiver, next), result: undefined};
    }
    case 'array.push': {
      requireArgs(operation, args, 1);
      assertLimit(receiver.length + 1, ctx.maxElements);
      assertType(ctx, receiver.element, args[0], 'array.push value');
      const capacity =
        receiver.length < receiver.capacity
          ? receiver.capacity
          : Math.max(1, receiver.capacity * 2);
      return {
        replacement: replace(ctx, receiver, [...old, args[0]], capacity),
        result: undefined,
      };
    }
    case 'array.pop':
      requireArgs(operation, args, 0);
      assertNotEmpty(receiver);
      return {
        replacement: replace(ctx, receiver, old.slice(0, -1)),
        result: old[old.length - 1],
      };
    case 'array.clear':
      requireArgs(operation, args, 0);
      return {replacement: replace(ctx, receiver, []), result: undefined};
    default:
      return fatal(`unknown mutating array operation '${operation}'`);
  }
}

/** Allocate backing for captured elements after validating type, bounds and ownership. */
export function createArray(
  ctx: CollectionContext,
  element: Value<unknown>,
  elements: readonly Value<unknown>[],
  capacity = elements.length,
): ArrayValue {
  assertLimit(elements.length, ctx.maxElements);
  if (!Number.isSafeInteger(capacity) || capacity < elements.length)
    return fatal(`invalid private array capacity ${capacity}`);
  elements.forEach((value, at) =>
    assertType(ctx, element, value, `array element ${at}`),
  );
  return new ArrayValue(
    element,
    allocateStorage(ctx, element, elements),
    elements.length,
    capacity,
  );
}

export function arraySnapshot(
  ctx: CollectionReadContext,
  value: Stored,
): readonly Value<unknown>[] {
  if (!isArrayValue(value))
    throw new ExecutionError('NA_COLLECTION', 'array iteration on na');
  return Object.freeze([...values(ctx, value)]);
}

function replace(
  ctx: CollectionContext,
  receiver: ArrayValue,
  elements: readonly Value<unknown>[],
  capacity = receiver.capacity,
): ArrayValue {
  return new ArrayValue(
    receiver.element,
    allocateStorage(ctx, receiver.element, elements),
    elements.length,
    capacity,
  );
}

function values(
  ctx: CollectionReadContext,
  receiver: ArrayValue,
): readonly Value<unknown>[] {
  const payload = ctx.transaction.read(receiver.storage);
  if (
    !Number.isSafeInteger(receiver.length) ||
    receiver.length < 0 ||
    !Number.isSafeInteger(receiver.capacity) ||
    receiver.capacity < receiver.length ||
    payload.values.length !== receiver.length
  )
    return fatal(
      `array header length ${receiver.length} disagrees with storage ${payload.values.length}`,
    );
  return payload.values;
}

function allocateStorage(
  ctx: CollectionContext,
  element: Value<unknown>,
  elements: readonly Value<unknown>[],
): ArrayValue['storage'] {
  return ctx.transaction.allocate(ARRAY_STORAGE, {
    values: elements,
    logicalBytes: 16 + elements.length * element.byteSize,
  });
}

function assertNotEmpty(receiver: ArrayValue): void {
  if (receiver.length === 0)
    throw new ExecutionError('EMPTY_COLLECTION', 'array is empty');
}
