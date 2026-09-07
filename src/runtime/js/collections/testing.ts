// Fixtures use the same captured Values as generated code; no descriptor adapter.
import type {
  CollectionMutationOperation,
  CollectionOperation,
} from '../../module-abi';
import {
  type ArrayValue,
  type MatrixValue,
  type MapValue,
  type CollectionValue,
  type Stored,
  visitValueRefs,
} from '../../value';
import {ArenaHeap, type Ref} from '../heap';
import {Value} from '../value';
import {StructStorageRuntime} from '../struct-storage';
import {CollectionRuntime} from './index';

export function harness(maxElements = 10_000) {
  const heap = new ArenaHeap();
  return {
    heap,
    collections: new CollectionRuntime(heap, maxElements),
    structs: new StructStorageRuntime(heap),
  };
}

export const array = <T extends Value<unknown>>(element: T) =>
  new Value<ArrayValue<T> | null, 'array'>(null, 'array', undefined, {element});
export const matrix = <T extends Value<unknown>>(element: T) =>
  new Value<MatrixValue<T> | null, 'matrix'>(null, 'matrix', undefined, {
    element,
  });
export const map = <K extends Value<unknown>, V extends Value<unknown>>(
  key: K,
  element: V,
) =>
  new Value<MapValue<K, V> | null, 'map'>(null, 'map', undefined, {
    key,
    element,
  });

export function call<T, K extends string>(
  h: ReturnType<typeof harness>,
  operation: CollectionOperation,
  empty: Value<T, K>,
  args: readonly Value<unknown>[] = [],
): Value<T, K> {
  using transaction = h.heap.begin(operation);
  const result = h.collections.call(transaction, operation, empty, args);
  transaction.commit();
  return result as Value<T, K>;
}

export function mutate<T extends CollectionValue | null, K extends string>(
  h: ReturnType<typeof harness>,
  operation: CollectionMutationOperation,
  receiver: Value<T, K>,
  args: readonly Value<unknown>[] = [],
) {
  using transaction = h.heap.begin(operation);
  const result = h.collections.mutate(transaction, operation, receiver, args);
  transaction.commit();
  return {
    replacement: receiver.withStored(result.replacement as T),
    result: result.result,
  };
}

export function arrayValues(
  h: ReturnType<typeof harness>,
  value: Value<unknown>,
): readonly unknown[] {
  return (
    h.collections.entries(value.value as Stored) as readonly Value<unknown>[]
  ).map(value => value.value);
}

export function mapValues(
  h: ReturnType<typeof harness>,
  value: Value<unknown>,
): readonly (readonly [unknown, unknown])[] {
  return (
    h.collections.entries(value.value as Stored) as readonly (readonly [
      Value<unknown>,
      Value<unknown>,
    ])[]
  ).map(([key, value]) => [key.value, value.value]);
}

export function roots(values: readonly Value<unknown>[]): Ref[] {
  const refs: Ref[] = [];
  values.forEach(value => visitValueRefs(value, ref => refs.push(ref)));
  return refs;
}
