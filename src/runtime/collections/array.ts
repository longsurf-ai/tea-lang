// Purpose: Immutable array headers and sealed eager-copy backing operations; every mutator returns a replacement and never edits existing storage.

import {fatal} from '../../base/print';
import {ExecutionError} from '../errors';
import type {CollectionMutation} from '../module-abi';
import {isArrayValue, type ArrayValue, type Value} from '../value';
import type {StorageDescriptor} from '../heap';
import {visitRuntimeValueStorageRefs, type LayoutId} from '../value-layout';
import {
  arrayValue,
  assertExactLayout,
  assertScalarResultLayout,
  assertLimit,
  collectionLayout,
  index,
  requireCollection,
  shape,
  type CollectionContext,
} from './common';

export interface ArrayStorage {
  readonly values: readonly Value[];
  readonly logicalBytes: number;
}

interface ArrayStorageArgs {
  readonly values: readonly Value[];
  readonly logicalBytes: number;
}

export const ARRAY_STORAGE: StorageDescriptor<ArrayStorage, ArrayStorageArgs> =
  {
    id: Symbol('tea.array.storage'),
    debugName: 'array storage',
    logicalBytesFor(args) {
      return args.logicalBytes;
    },
    create(args) {
      return Object.freeze({
        values: Object.freeze([...args.values]),
        logicalBytes: args.logicalBytes,
      });
    },
    trace(payload, tracer) {
      payload.values.forEach(value =>
        visitRuntimeValueStorageRefs(value, ref => tracer.storage(ref)),
      );
    },
    logicalBytes(payload) {
      return payload.logicalBytes;
    },
  };

export function arrayCall(
  ctx: CollectionContext,
  operation: string,
  resultLayout: LayoutId,
  args: readonly Value[],
): Value {
  if (operation === 'array.new') {
    if (args.length === 0) {
      return createArray(ctx, resultLayout, []);
    }
    if (args.length !== 1 && args.length !== 2) {
      return fatal(`array.new received ${args.length} arguments`);
    }
    const size = shape(args[0], 'array size');
    assertLimit(size, ctx.maxElements);
    const layout = collectionLayout(ctx.layouts, resultLayout, 'array');
    const initial =
      args.length === 1 ? ctx.layouts.empty(layout.element) : args[1];
    ctx.assertValue(layout.element, initial, 'array initial value');
    return createArray(
      ctx,
      resultLayout,
      Array.from({length: size}, () => initial),
    );
  }
  if (operation === 'array.from') {
    return createArray(ctx, resultLayout, args);
  }
  const receiver = requireArrayArg(ctx, args, operation);
  const layout = collectionLayout(ctx.layouts, receiver.layout, 'array');
  switch (operation) {
    case 'array.size':
      requireArgs(operation, args, 1);
      assertScalarResultLayout(ctx.layouts, resultLayout, 'int', operation);
      return receiver.length;
    case 'array.is_empty':
      requireArgs(operation, args, 1);
      assertScalarResultLayout(ctx.layouts, resultLayout, 'boolean', operation);
      return receiver.length === 0;
    case 'array.get': {
      requireArgs(operation, args, 2);
      assertExactLayout(resultLayout, layout.element, operation);
      return values(ctx, receiver)[index(args[1], receiver.length)];
    }
    case 'array.first':
      requireArgs(operation, args, 1);
      assertExactLayout(resultLayout, layout.element, operation);
      assertNotEmpty(receiver);
      return values(ctx, receiver)[0];
    case 'array.last':
      requireArgs(operation, args, 1);
      assertExactLayout(resultLayout, layout.element, operation);
      assertNotEmpty(receiver);
      return values(ctx, receiver)[receiver.length - 1];
    case 'array.copy':
      requireArgs(operation, args, 1);
      assertExactLayout(resultLayout, receiver.layout, operation);
      return arrayValue(
        receiver.layout,
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
  layoutId: LayoutId,
  receiverValue: Value,
  args: readonly Value[],
): CollectionMutation {
  const receiver = requireCollection(ctx, receiverValue, layoutId, 'array');
  const layout = collectionLayout(ctx.layouts, layoutId, 'array');
  const old = values(ctx, receiver);
  switch (operation) {
    case 'array.set': {
      requireArgs(operation, args, 2);
      const at = index(args[0], receiver.length);
      ctx.assertValue(layout.element, args[1], 'array.set value');
      const next = [...old];
      next[at] = args[1];
      return {replacement: replace(ctx, receiver, next), result: undefined};
    }
    case 'array.push': {
      requireArgs(operation, args, 1);
      assertLimit(receiver.length + 1, ctx.maxElements);
      ctx.assertValue(layout.element, args[0], 'array.push value');
      const capacity =
        receiver.length < receiver.capacity
          ? receiver.capacity
          : Math.max(1, receiver.capacity * 2);
      return {
        replacement: replace(ctx, receiver, [...old, args[0]], capacity),
        result: undefined,
      };
    }
    case 'array.pop': {
      requireArgs(operation, args, 0);
      assertNotEmpty(receiver);
      const result = old[old.length - 1];
      return {
        replacement: replace(ctx, receiver, old.slice(0, -1)),
        result,
      };
    }
    case 'array.clear':
      requireArgs(operation, args, 0);
      return {replacement: replace(ctx, receiver, []), result: undefined};
    default:
      return fatal(`unknown mutating array operation '${operation}'`);
  }
}

export function createArray(
  ctx: CollectionContext,
  layoutId: LayoutId,
  elements: readonly Value[],
  capacity = elements.length,
): ArrayValue {
  const layout = collectionLayout(ctx.layouts, layoutId, 'array');
  assertLimit(elements.length, ctx.maxElements);
  if (!Number.isSafeInteger(capacity) || capacity < elements.length) {
    return fatal(`invalid private array capacity ${capacity}`);
  }
  elements.forEach((value, at) =>
    ctx.assertValue(layout.element, value, `array element ${at}`),
  );
  const storage = allocateStorage(ctx, layout.element, elements);
  return arrayValue(layoutId, storage, elements.length, capacity);
}

export function arraySnapshot(
  ctx: Pick<CollectionContext, 'heap' | 'layouts' | 'assertValue'>,
  value: Value,
): readonly Value[] {
  if (!isArrayValue(value)) {
    throw new ExecutionError('NA_COLLECTION', 'array iteration on na');
  }
  ctx.assertValue(value.layout, value, 'array iteration');
  return Object.freeze([...values(ctx, value)]);
}

function replace(
  ctx: CollectionContext,
  receiver: ArrayValue,
  elements: readonly Value[],
  capacity = receiver.capacity,
): ArrayValue {
  const layout = collectionLayout(ctx.layouts, receiver.layout, 'array');
  const storage = allocateStorage(ctx, layout.element, elements);
  return arrayValue(receiver.layout, storage, elements.length, capacity);
}

function values(
  ctx: Pick<CollectionContext, 'heap'>,
  receiver: ArrayValue,
): readonly Value[] {
  const payload = ctx.heap.read<ArrayStorage, ArrayStorageArgs>(
    receiver.storage,
    ARRAY_STORAGE,
  );
  if (payload.values.length !== receiver.length) {
    return fatal(
      `array header length ${receiver.length} disagrees with storage ${payload.values.length}`,
    );
  }
  return payload.values;
}

function allocateStorage(
  ctx: CollectionContext,
  elementLayout: LayoutId,
  elements: readonly Value[],
): ArrayValue['storage'] {
  return ctx.transaction.allocate(ARRAY_STORAGE, {
    values: elements,
    logicalBytes:
      16 + elements.length * ctx.layouts.shallowBytes(elementLayout),
  });
}

function requireArrayArg(
  ctx: CollectionContext,
  args: readonly Value[],
  operation: string,
): ArrayValue {
  if (args.length === 0) {
    return fatal(`${operation} is missing its receiver`);
  }
  const value = args[0];
  if (!isArrayValue(value)) {
    if (value === null) {
      throw new ExecutionError('NA_COLLECTION', `${operation} on na`);
    }
    return fatal(`${operation} received a non-array receiver`);
  }
  ctx.assertValue(value.layout, value, `${operation} receiver`);
  return value;
}

function requireArgs(
  operation: string,
  args: readonly Value[],
  expected: number,
): void {
  if (args.length !== expected) {
    fatal(
      `${operation} received ${args.length} arguments, expected ${expected}`,
    );
  }
}

function assertNotEmpty(receiver: ArrayValue): void {
  if (receiver.length === 0) {
    throw new ExecutionError('EMPTY_COLLECTION', 'array is empty');
  }
}
