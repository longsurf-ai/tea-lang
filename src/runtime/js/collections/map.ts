// Ordered persistent maps; keys compare by Tea value, including Color channels.

import {fatal} from '../../../base/print';
import {ExecutionError} from '../../errors';
import type {CollectionMutation} from '../../module-abi';
import {MapValue, isMapValue, visitValueRefs, type Stored} from '../../value';
import type {TypeInfo} from '../heap';
import {Value, int, bool} from '../value';
import {createArray} from './array';
import {
  assertType,
  assertLimit,
  requireArgs,
  requireCollection,
  type CollectionContext,
  type CollectionReadContext,
} from './common';

export interface MapEntry {
  readonly key: Value<unknown>;
  readonly value: Value<unknown>;
}

export interface MapStorage {
  readonly entries: readonly MapEntry[];
  readonly logicalBytes: number;
}

export const MAP_STORAGE: TypeInfo<MapStorage, MapStorage> = {
  id: Symbol('tea.map.storage'),
  name: 'map storage',
  bytesFor: args => args.logicalBytes,
  create: args =>
    Object.freeze({
      entries: Object.freeze(
        args.entries.map(entry =>
          Object.freeze({key: entry.key, value: entry.value}),
        ),
      ),
      logicalBytes: args.logicalBytes,
    }),
  trace(payload, visit) {
    payload.entries.forEach(entry => {
      visitValueRefs(entry.key, visit);
      visitValueRefs(entry.value, visit);
    });
  },
  bytesOf: payload => payload.logicalBytes,
};

export function mapCall(
  ctx: CollectionContext,
  operation: string,
  result: Value<unknown>,
  args: readonly Value<unknown>[],
): Stored | Value<unknown> {
  if (operation === 'map.new') {
    requireArgs(operation, args, 0);
    const key = result.key ?? fatal('map constructor requires an empty key');
    const element =
      result.element ?? fatal('map constructor requires an empty element');
    assertKeyType(key);
    return new MapValue(
      key,
      element,
      allocateStorage(ctx, key, element, []),
      0,
    );
  }
  const receiver = requireCollection(ctx, args[0], 'map');
  const stored = entries(ctx, receiver);
  switch (operation) {
    case 'map.size':
      requireArgs(operation, args, 1);
      return int(receiver.size);
    case 'map.is_empty':
      requireArgs(operation, args, 1);
      return bool(receiver.size === 0);
    case 'map.contains':
      requireArgs(operation, args, 2);
      return bool(find(stored, canonicalKey(ctx, receiver.key, args[1])) >= 0);
    case 'map.get': {
      requireArgs(operation, args, 2);
      const at = find(stored, canonicalKey(ctx, receiver.key, args[1]));
      return at < 0 ? receiver.element : stored[at].value;
    }
    case 'map.keys':
      requireArgs(operation, args, 1);
      return createArray(
        ctx,
        receiver.key,
        stored.map(entry => entry.key),
      );
    case 'map.values':
      requireArgs(operation, args, 1);
      return createArray(
        ctx,
        receiver.element,
        stored.map(entry => entry.value),
      );
    case 'map.copy':
      requireArgs(operation, args, 1);
      return new MapValue(
        receiver.key,
        receiver.element,
        receiver.storage,
        receiver.size,
      );
    default:
      return fatal(`unknown non-mutating map operation '${operation}'`);
  }
}

export function mapMutate(
  ctx: CollectionContext,
  operation: string,
  value: Value<unknown>,
  args: readonly Value<unknown>[],
): CollectionMutation {
  const receiver = requireCollection(ctx, value, 'map');
  const old = entries(ctx, receiver);
  switch (operation) {
    case 'map.put': {
      requireArgs(operation, args, 2);
      const key = canonicalKey(ctx, receiver.key, args[0]);
      assertType(ctx, receiver.element, args[1], 'map.put value');
      const at = find(old, key);
      if (at < 0) assertLimit(receiver.size + 1, ctx.maxElements);
      const next = [...old];
      if (at < 0) next.push({key, value: args[1]});
      else next[at] = {key: old[at].key, value: args[1]};
      return {replacement: replace(ctx, receiver, next), result: undefined};
    }
    case 'map.remove': {
      requireArgs(operation, args, 1);
      const at = find(old, canonicalKey(ctx, receiver.key, args[0]));
      return at < 0
        ? {replacement: receiver, result: receiver.element}
        : {
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
  ctx: CollectionReadContext,
  value: Stored,
): readonly (readonly [Value<unknown>, Value<unknown>])[] {
  if (!isMapValue(value))
    throw new ExecutionError('NA_COLLECTION', 'map iteration on na');
  return Object.freeze(
    entries(ctx, value).map(entry =>
      Object.freeze([entry.key, entry.value] as const),
    ),
  );
}

function replace(
  ctx: CollectionContext,
  receiver: MapValue,
  items: readonly MapEntry[],
): MapValue {
  return new MapValue(
    receiver.key,
    receiver.element,
    allocateStorage(ctx, receiver.key, receiver.element, items),
    items.length,
  );
}

function entries(
  ctx: CollectionReadContext,
  receiver: MapValue,
): readonly MapEntry[] {
  const payload = ctx.transaction.read(receiver.storage);
  if (
    !Number.isSafeInteger(receiver.size) ||
    receiver.size < 0 ||
    payload.entries.length !== receiver.size
  )
    return fatal(
      `map header size ${receiver.size} disagrees with storage ${payload.entries.length}`,
    );
  return payload.entries;
}

function allocateStorage(
  ctx: CollectionContext,
  key: Value<unknown>,
  element: Value<unknown>,
  entries: readonly MapEntry[],
): MapValue['storage'] {
  return ctx.transaction.allocate(MAP_STORAGE, {
    entries,
    logicalBytes: 16 + entries.length * (key.byteSize + element.byteSize),
  });
}

function canonicalKey(
  ctx: CollectionContext,
  empty: Value<unknown>,
  value: Value<unknown>,
): Value<unknown> {
  assertKeyType(empty);
  const raw = value.value;
  if (raw === null || (typeof raw === 'number' && !Number.isFinite(raw)))
    throw new ExecutionError('INVALID_MAP_KEY', 'map key cannot be na');
  assertType(ctx, empty, value, 'map key');
  if (
    value.kind === 'int' &&
    typeof raw === 'number' &&
    !Number.isSafeInteger(raw)
  )
    throw new ExecutionError(
      'INVALID_MAP_KEY',
      'int map key must be a safe integer',
    );
  return typeof raw === 'number' && Object.is(raw, -0)
    ? value.withStored(0)
    : value;
}

function assertKeyType(value: Value<unknown>): void {
  if (
    !['int', 'float', 'bool', 'string', 'color'].includes(value.kind) &&
    value.enumValues === undefined
  )
    fatal(`${value.kind} cannot be a map key`);
}

function find(entries: readonly MapEntry[], key: Value<unknown>): number {
  return entries.findIndex(entry => entry.key.eq(key).value);
}
