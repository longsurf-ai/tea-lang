// Purpose: Insertion-ordered immutable maps with static-domain key canonicalization and sealed eager-copy backing.

import {fatal} from '../../base/print';
import {
  ExecutionError,
  isMapValue,
  type CollectionMutation,
  type MapValue,
  type Value,
} from '../abi';
import type {StorageDescriptor} from '../heap';
import {
  visitRuntimeValueStorageRefs,
  type LayoutId,
  type ValueLayout,
} from '../value-layout';
import {createArray} from './array';
import {
  assertLimit,
  assertExactLayout,
  assertScalarResultLayout,
  collectionLayout,
  mapValue,
  requireCollection,
  type CollectionContext,
} from './common';

export interface MapEntry {
  readonly key: Value;
  readonly value: Value;
}

export interface MapStorage {
  readonly entries: readonly MapEntry[];
  readonly logicalBytes: number;
}

interface MapStorageBuilder {
  readonly entries: readonly MapEntry[];
  readonly logicalBytes: number;
}

export const MAP_STORAGE: StorageDescriptor<MapStorage, MapStorageBuilder> = {
  id: Symbol('tea.map.storage'),
  debugName: 'map storage',
  builderLogicalBytes(builder) {
    return builder.logicalBytes;
  },
  seal(builder) {
    return Object.freeze({
      entries: Object.freeze(
        builder.entries.map(entry =>
          Object.freeze({key: entry.key, value: entry.value}),
        ),
      ),
      logicalBytes: builder.logicalBytes,
    });
  },
  trace(payload, tracer) {
    payload.entries.forEach(entry => {
      visitRuntimeValueStorageRefs(entry.key, ref => tracer.storage(ref));
      visitRuntimeValueStorageRefs(entry.value, ref => tracer.storage(ref));
    });
  },
  logicalBytes(payload) {
    return payload.logicalBytes;
  },
};

export function mapCall(
  ctx: CollectionContext,
  operation: string,
  resultLayout: LayoutId,
  args: readonly Value[],
): Value {
  if (operation === 'map.new') {
    if (args.length !== 0) {
      return fatal(`map.new received ${args.length} arguments`);
    }
    return createMap(ctx, resultLayout, []);
  }
  const receiver = requireMapArg(ctx, args, operation);
  const layout = collectionLayout(ctx.layouts, receiver.layout, 'map');
  const stored = entries(ctx, receiver);
  switch (operation) {
    case 'map.size':
      requireArgs(operation, args, 1);
      assertScalarResultLayout(ctx.layouts, resultLayout, 'int', operation);
      return receiver.size;
    case 'map.is_empty':
      requireArgs(operation, args, 1);
      assertScalarResultLayout(ctx.layouts, resultLayout, 'boolean', operation);
      return receiver.size === 0;
    case 'map.contains': {
      requireArgs(operation, args, 2);
      assertScalarResultLayout(ctx.layouts, resultLayout, 'boolean', operation);
      const key = canonicalKey(ctx, layout.key, args[1]);
      return find(stored, key) >= 0;
    }
    case 'map.get': {
      requireArgs(operation, args, 2);
      assertExactLayout(resultLayout, layout.value, operation);
      const key = canonicalKey(ctx, layout.key, args[1]);
      const at = find(stored, key);
      return at < 0 ? ctx.layouts.empty(layout.value) : stored[at].value;
    }
    case 'map.keys':
      requireArgs(operation, args, 1);
      assertArrayElementLayout(ctx, resultLayout, layout.key, operation);
      return createArray(
        ctx,
        resultLayout,
        stored.map(entry => entry.key),
      );
    case 'map.values':
      requireArgs(operation, args, 1);
      assertArrayElementLayout(ctx, resultLayout, layout.value, operation);
      return createArray(
        ctx,
        resultLayout,
        stored.map(entry => entry.value),
      );
    case 'map.copy':
      requireArgs(operation, args, 1);
      assertExactLayout(resultLayout, receiver.layout, operation);
      return mapValue(receiver.layout, receiver.storage, receiver.size);
    default:
      return fatal(`unknown non-mutating map operation '${operation}'`);
  }
}

function assertArrayElementLayout(
  ctx: CollectionContext,
  resultLayout: LayoutId,
  elementLayout: LayoutId,
  operation: string,
): void {
  const result = collectionLayout(ctx.layouts, resultLayout, 'array');
  assertExactLayout(result.element, elementLayout, operation);
}

export function mapMutate(
  ctx: CollectionContext,
  operation: string,
  layoutId: LayoutId,
  receiverValue: Value,
  args: readonly Value[],
): CollectionMutation {
  const receiver = requireCollection(
    ctx.layouts,
    receiverValue,
    layoutId,
    'map',
  );
  const layout = collectionLayout(ctx.layouts, layoutId, 'map');
  const old = entries(ctx, receiver);
  switch (operation) {
    case 'map.put': {
      requireArgs(operation, args, 2);
      const key = canonicalKey(ctx, layout.key, args[0]);
      ctx.layouts.assertValue(layout.value, args[1], 'map.put value');
      const at = find(old, key);
      if (at < 0) {
        assertLimit(receiver.size + 1, ctx.maxElements);
      }
      const next = [...old];
      if (at < 0) {
        next.push({key, value: args[1]});
      } else {
        next[at] = {key: old[at].key, value: args[1]};
      }
      return {replacement: replace(ctx, receiver, next), result: undefined};
    }
    case 'map.remove': {
      requireArgs(operation, args, 1);
      const key = canonicalKey(ctx, layout.key, args[0]);
      const at = find(old, key);
      if (at < 0) {
        return {
          replacement: mapValue(
            receiver.layout,
            receiver.storage,
            receiver.size,
          ),
          result: ctx.layouts.empty(layout.value),
        };
      }
      return {
        replacement: replace(ctx, receiver, [
          ...old.slice(0, at),
          ...old.slice(at + 1),
        ]),
        result: old[at].value,
      };
    }
    case 'map.clear':
      requireArgs(operation, args, 0);
      return {replacement: replace(ctx, receiver, []), result: undefined};
    default:
      return fatal(`unknown mutating map operation '${operation}'`);
  }
}

export function mapSnapshot(
  ctx: Pick<CollectionContext, 'heap' | 'layouts'>,
  value: Value,
): readonly (readonly [Value, Value])[] {
  if (!isMapValue(value)) {
    throw new ExecutionError('NA_COLLECTION', 'map iteration on na');
  }
  ctx.layouts.assertValue(value.layout, value, 'map iteration');
  return Object.freeze(
    entries(ctx, value).map(entry =>
      Object.freeze([entry.key, entry.value] as const),
    ),
  );
}

function createMap(
  ctx: CollectionContext,
  layoutId: LayoutId,
  items: readonly MapEntry[],
): MapValue {
  const layout = collectionLayout(ctx.layouts, layoutId, 'map');
  assertMapKeyLayout(ctx.layouts.layout(layout.key));
  assertLimit(items.length, ctx.maxElements);
  items.forEach((entry, at) => {
    canonicalKey(ctx, layout.key, entry.key);
    ctx.layouts.assertValue(layout.value, entry.value, `map value ${at}`);
  });
  const storage = allocateStorage(ctx, layout.key, layout.value, items);
  return mapValue(layoutId, storage, items.length);
}

function replace(
  ctx: CollectionContext,
  receiver: MapValue,
  items: readonly MapEntry[],
): MapValue {
  const layout = collectionLayout(ctx.layouts, receiver.layout, 'map');
  const storage = allocateStorage(ctx, layout.key, layout.value, items);
  return mapValue(receiver.layout, storage, items.length);
}

function entries(
  ctx: Pick<CollectionContext, 'heap'>,
  receiver: MapValue,
): readonly MapEntry[] {
  const payload = ctx.heap.read<MapStorage, MapStorageBuilder>(
    receiver.storage,
    MAP_STORAGE,
  );
  if (payload.entries.length !== receiver.size) {
    return fatal(
      `map header size ${receiver.size} disagrees with storage ${payload.entries.length}`,
    );
  }
  return payload.entries;
}

function allocateStorage(
  ctx: CollectionContext,
  keyLayout: LayoutId,
  valueLayout: LayoutId,
  entries: readonly MapEntry[],
): MapValue['storage'] {
  const entryBytes =
    ctx.layouts.shallowBytes(keyLayout) + ctx.layouts.shallowBytes(valueLayout);
  return ctx.attempt.allocateSealed(MAP_STORAGE, {
    entries,
    logicalBytes: 16 + entries.length * entryBytes,
  });
}

function canonicalKey(
  ctx: CollectionContext,
  layoutId: LayoutId,
  value: Value,
): Value {
  const layout = ctx.layouts.layout(layoutId);
  assertMapKeyLayout(layout);
  if (
    value === null ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new ExecutionError('INVALID_MAP_KEY', 'map key cannot be na');
  }
  ctx.layouts.assertValue(layoutId, value, 'map key');
  if (
    layout.kind === 'number' &&
    layout.numeric === 'int' &&
    typeof value === 'number' &&
    !Number.isSafeInteger(value)
  ) {
    throw new ExecutionError(
      'INVALID_MAP_KEY',
      'int map key must be a safe integer',
    );
  }
  if (typeof value === 'number' && Object.is(value, -0)) {
    return 0;
  }
  return value;
}

function assertMapKeyLayout(layout: ValueLayout): void {
  if (
    layout.kind !== 'number' &&
    layout.kind !== 'boolean' &&
    layout.kind !== 'nullable-scalar' &&
    layout.kind !== 'enum'
  ) {
    fatal(`layout kind ${layout.kind} cannot be a map key`);
  }
}

function find(entries: readonly MapEntry[], key: Value): number {
  return entries.findIndex(entry => entry.key === key);
}

function requireMapArg(
  ctx: CollectionContext,
  args: readonly Value[],
  operation: string,
): MapValue {
  if (args.length === 0) {
    return fatal(`${operation} is missing its receiver`);
  }
  const value = args[0];
  if (!isMapValue(value)) {
    if (value === null) {
      throw new ExecutionError('NA_COLLECTION', `${operation} on na`);
    }
    return fatal(`${operation} received a non-map receiver`);
  }
  ctx.layouts.assertValue(value.layout, value, `${operation} receiver`);
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
