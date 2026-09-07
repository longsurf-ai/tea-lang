// Typed collection operations execute inside the caller's Heap transaction.

import {fatal} from '../../../base/print';
import {ExecutionError} from '../../errors';
import type {
  CollectionEntries,
  CollectionMutation,
  CollectionMutationOperation,
  CollectionOperation,
} from '../../module-abi';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  type Stored,
} from '../../value';
import type {Heap, HeapTransaction} from '../heap';
import {Value} from '../value';
import {arrayCall, arrayMutate, arraySnapshot} from './array';
import {assertType, type CollectionContext} from './common';
import {mapCall, mapMutate, mapSnapshot} from './map';
import {matrixCall, matrixMutate} from './matrix';

/**
 * Persistent arrays, matrices and maps share the execution's Heap transaction.
 * Backing stores captured Values, so reads retain their types and reference
 * identity without reconstructing wrappers from a descriptor table.
 * @example A successful push returns a new header; aborting its transaction
 * discards the new backing while the original header remains readable.
 */
export class CollectionRuntime {
  constructor(
    private readonly heap: Heap,
    private readonly maxElements: number,
  ) {
    if (!Number.isSafeInteger(maxElements) || maxElements < 0)
      fatal(`invalid collection element limit ${maxElements}`);
  }

  /**
   * Execute a read or constructor using the result's existing empty Value.
   * Element reads return the stored capture; construction allocates backing in
   * this transaction. Invalid types, bounds, and references fail before commit.
   * @example `call(tx, 'array.get', int(NaN), [prices, int(0)])` reads item zero.
   */
  call(
    transaction: HeapTransaction,
    operation: CollectionOperation,
    empty: Value<unknown>,
    args: readonly Value<unknown>[],
  ): Value<unknown> {
    const ctx = this.context(transaction);
    const result = operation.startsWith('array.')
      ? arrayCall(ctx, operation, empty, args)
      : operation.startsWith('matrix.')
        ? matrixCall(ctx, operation, empty, args)
        : mapCall(ctx, operation, empty, args);
    const value = result instanceof Value ? result : empty.withStored(result);
    assertType(ctx, empty, value, `${operation} result`);
    return value;
  }

  /**
   * Return replacement backing without rebinding or changing the receiver.
   * The caller rebinds its Series or field; transaction rollback discards the
   * replacement allocation. Pop/remove also return the removed captured Value.
   * @example `mutate(tx, 'array.push', prices, [int(7)])` leaves prices unchanged.
   */
  mutate(
    transaction: HeapTransaction,
    operation: CollectionMutationOperation,
    receiver: Value<unknown>,
    args: readonly Value<unknown>[],
  ): CollectionMutation {
    const ctx = this.context(transaction);
    const result = operation.startsWith('array.')
      ? arrayMutate(ctx, operation, receiver, args)
      : operation.startsWith('matrix.')
        ? matrixMutate(ctx, operation, receiver, args)
        : mapMutate(ctx, operation, receiver, args);
    receiver.assertStored(result.replacement, transaction);
    return result;
  }

  /**
   * Capture stable iteration order. Later mutations cannot change the returned
   * array, but contained struct references retain their shared live identity.
   * @example `entries(prices.value!)` returns the array's captured elements.
   */
  entries(
    value: Stored,
    reader: Pick<Heap, 'read'> = this.heap,
  ): CollectionEntries {
    const ctx = {transaction: reader};
    if (value === null)
      throw new ExecutionError('NA_COLLECTION', 'collection iteration on na');
    if (isArrayValue(value)) return arraySnapshot(ctx, value);
    if (isMapValue(value)) return mapSnapshot(ctx, value);
    if (isMatrixValue(value))
      return fatal('matrix iteration is not supported in V1');
    return fatal('collectionEntries received a non-collection object');
  }

  private context(transaction: HeapTransaction): CollectionContext {
    return {transaction, maxElements: this.maxElements};
  }
}
