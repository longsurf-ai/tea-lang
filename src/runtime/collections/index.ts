// Purpose: Collection ABI dispatcher — routes catalog operations into array, matrix, and ordered-map value implementations under the current Heap transaction.

import {fatal} from '../../base/print';
import {ExecutionError} from '../errors';
import {
  type CollectionEntries,
  type CollectionMutation,
  type CollectionMutationOperation,
  type CollectionOperation,
} from '../module-abi';
import {isArrayValue, isMapValue, isMatrixValue, type Value} from '../value';
import type {Heap, HeapTransaction} from '../heap';
import {type LayoutId, ValueLayoutRegistry} from '../value-layout';
import {arrayCall, arrayMutate, arraySnapshot} from './array';
import type {CollectionContext} from './common';
import {mapCall, mapMutate, mapSnapshot} from './map';
import {matrixCall, matrixMutate} from './matrix';

export class CollectionRuntime {
  constructor(
    private readonly heap: Heap,
    private readonly layouts: ValueLayoutRegistry,
    private readonly maxElements: number,
  ) {
    if (!Number.isSafeInteger(maxElements) || maxElements < 0) {
      fatal(`invalid collection element limit ${maxElements}`);
    }
  }

  call(
    transaction: HeapTransaction,
    operation: CollectionOperation,
    resultLayout: LayoutId,
    args: readonly Value[],
  ): Value {
    const ctx = this.context(transaction);
    const result = operation.startsWith('array.')
      ? arrayCall(ctx, operation, resultLayout, args)
      : operation.startsWith('matrix.')
        ? matrixCall(ctx, operation, resultLayout, args)
        : mapCall(ctx, operation, resultLayout, args);
    this.layouts.assertValue(resultLayout, result, `${operation} result`);
    return result;
  }

  mutate(
    transaction: HeapTransaction,
    operation: CollectionMutationOperation,
    collectionLayout: LayoutId,
    receiver: Value,
    args: readonly Value[],
  ): CollectionMutation {
    const ctx = this.context(transaction);
    const result = operation.startsWith('array.')
      ? arrayMutate(ctx, operation, collectionLayout, receiver, args)
      : operation.startsWith('matrix.')
        ? matrixMutate(ctx, operation, collectionLayout, receiver, args)
        : mapMutate(ctx, operation, collectionLayout, receiver, args);
    this.layouts.assertValue(
      collectionLayout,
      result.replacement,
      `${operation} replacement`,
    );
    return result;
  }

  entries(value: Value): CollectionEntries {
    const ctx = {heap: this.heap, layouts: this.layouts};
    if (value === null) {
      throw new ExecutionError('NA_COLLECTION', 'collection iteration on na');
    }
    if (isArrayValue(value)) {
      return arraySnapshot(ctx, value);
    }
    if (isMapValue(value)) {
      return mapSnapshot(ctx, value);
    }
    if (isMatrixValue(value)) {
      return fatal('matrix iteration is not supported in V1');
    }
    return fatal('collectionEntries received a non-collection object');
  }

  private context(transaction: HeapTransaction): CollectionContext {
    return {
      heap: this.heap,
      transaction,
      layouts: this.layouts,
      maxElements: this.maxElements,
    };
  }
}
