// Purpose: Fixed-shape matrix values backed by sealed row-major storage; row/column projections allocate independent array headers.

import {fatal} from '../../../base/print';
import {ExecutionError} from '../../errors';
import type {CollectionMutation} from '../../module-abi';
import {isMatrixValue, type MatrixValue, type Stored} from '../../value';
import type {TypeInfo} from '../heap';
import {visitRuntimeValueRefs} from '../../storage-types';
import {createArray} from './array';
import {
  assertLimit,
  assertExactLayout,
  assertScalarResultLayout,
  collectionLayout,
  index,
  matrixValue,
  requireCollection,
  shape,
  type CollectionContext,
  type CollectionReadContext,
} from './common';

export interface MatrixStorage {
  readonly values: readonly Stored[];
  readonly logicalBytes: number;
}

export const MATRIX_STORAGE: TypeInfo<MatrixStorage, MatrixStorage> = {
  id: Symbol('tea.matrix.storage'),
  name: 'matrix storage',
  bytesFor(args) {
    return args.logicalBytes;
  },
  create(args) {
    return Object.freeze({
      values: Object.freeze([...args.values]),
      logicalBytes: args.logicalBytes,
    });
  },
  trace(payload, visit) {
    payload.values.forEach(value => visitRuntimeValueRefs(value, visit));
  },
  bytesOf(payload) {
    return payload.logicalBytes;
  },
};

export function matrixCall(
  ctx: CollectionContext,
  operation: string,
  resultLayout: number,
  args: readonly Stored[],
): Stored {
  if (operation === 'matrix.new') {
    if (args.length === 0) {
      return createMatrix(ctx, resultLayout, 0, 0, []);
    }
    if (args.length !== 3) {
      return fatal(`matrix.new received ${args.length} arguments`);
    }
    const rows = shape(args[0], 'matrix rows');
    const columns = shape(args[1], 'matrix columns');
    const size = matrixSize(rows, columns, ctx.maxElements);
    const layout = collectionLayout(ctx.layouts, resultLayout, 'matrix');
    ctx.assertValue(layout.element, args[2], 'matrix initial value');
    return createMatrix(
      ctx,
      resultLayout,
      rows,
      columns,
      Array.from({length: size}, () => args[2]),
    );
  }
  const receiver = requireMatrixArg(ctx, args, operation);
  const layout = collectionLayout(ctx.layouts, receiver.layout, 'matrix');
  switch (operation) {
    case 'matrix.rows':
      requireArgs(operation, args, 1);
      assertScalarResultLayout(ctx.layouts, resultLayout, 'int', operation);
      return receiver.rows;
    case 'matrix.columns':
      requireArgs(operation, args, 1);
      assertScalarResultLayout(ctx.layouts, resultLayout, 'int', operation);
      return receiver.columns;
    case 'matrix.elements_count':
      requireArgs(operation, args, 1);
      assertScalarResultLayout(ctx.layouts, resultLayout, 'int', operation);
      return receiver.rows * receiver.columns;
    case 'matrix.get': {
      requireArgs(operation, args, 3);
      assertExactLayout(resultLayout, layout.element, operation);
      const row = index(args[1], receiver.rows, 'row');
      const column = index(args[2], receiver.columns, 'column');
      return values(ctx, receiver)[row * receiver.columns + column];
    }
    case 'matrix.row': {
      requireArgs(operation, args, 2);
      assertProjectionLayout(ctx, resultLayout, layout.element, operation);
      const row = index(args[1], receiver.rows, 'row');
      const start = row * receiver.columns;
      return createArray(
        ctx,
        resultLayout,
        values(ctx, receiver).slice(start, start + receiver.columns),
      );
    }
    case 'matrix.column': {
      requireArgs(operation, args, 2);
      assertProjectionLayout(ctx, resultLayout, layout.element, operation);
      const column = index(args[1], receiver.columns, 'column');
      const storage = values(ctx, receiver);
      const result: Stored[] = [];
      for (let row = 0; row < receiver.rows; row += 1) {
        result.push(storage[row * receiver.columns + column]);
      }
      return createArray(ctx, resultLayout, result);
    }
    case 'matrix.copy':
      requireArgs(operation, args, 1);
      assertExactLayout(resultLayout, receiver.layout, operation);
      return matrixValue(
        receiver.layout,
        receiver.storage,
        receiver.rows,
        receiver.columns,
      );
    default:
      return fatal(`unknown non-mutating matrix operation '${operation}'`);
  }
}

function assertProjectionLayout(
  ctx: CollectionContext,
  resultLayout: number,
  elementLayout: number,
  operation: string,
): void {
  const result = collectionLayout(ctx.layouts, resultLayout, 'array');
  assertExactLayout(result.element, elementLayout, operation);
}

export function matrixMutate(
  ctx: CollectionContext,
  operation: string,
  layoutId: number,
  receiverValue: Stored,
  args: readonly Stored[],
): CollectionMutation {
  const receiver = requireCollection(ctx, receiverValue, layoutId, 'matrix');
  const layout = collectionLayout(ctx.layouts, layoutId, 'matrix');
  const old = values(ctx, receiver);
  switch (operation) {
    case 'matrix.set': {
      requireArgs(operation, args, 3);
      const row = index(args[0], receiver.rows, 'row');
      const column = index(args[1], receiver.columns, 'column');
      ctx.assertValue(layout.element, args[2], 'matrix.set value');
      const next = [...old];
      next[row * receiver.columns + column] = args[2];
      return {replacement: replace(ctx, receiver, next), result: undefined};
    }
    case 'matrix.fill': {
      requireArgs(operation, args, 1);
      ctx.assertValue(layout.element, args[0], 'matrix.fill value');
      return {
        replacement: replace(
          ctx,
          receiver,
          Array.from({length: old.length}, () => args[0]),
        ),
        result: undefined,
      };
    }
    default:
      return fatal(`unknown mutating matrix operation '${operation}'`);
  }
}

function createMatrix(
  ctx: CollectionContext,
  layoutId: number,
  rows: number,
  columns: number,
  elements: readonly Stored[],
): MatrixValue {
  const layout = collectionLayout(ctx.layouts, layoutId, 'matrix');
  const size = matrixSize(rows, columns, ctx.maxElements);
  if (elements.length !== size) {
    return fatal(
      `matrix ${rows}x${columns} has ${elements.length} storage elements`,
    );
  }
  elements.forEach((value, at) =>
    ctx.assertValue(layout.element, value, `matrix element ${at}`),
  );
  const storage = allocateStorage(ctx, layout.element, elements);
  return matrixValue(layoutId, storage, rows, columns);
}

function replace(
  ctx: CollectionContext,
  receiver: MatrixValue,
  elements: readonly Stored[],
): MatrixValue {
  const layout = collectionLayout(ctx.layouts, receiver.layout, 'matrix');
  const storage = allocateStorage(ctx, layout.element, elements);
  return matrixValue(receiver.layout, storage, receiver.rows, receiver.columns);
}

function values(
  ctx: Pick<CollectionReadContext, 'transaction'>,
  receiver: MatrixValue,
): readonly Stored[] {
  const payload = ctx.transaction.read(receiver.storage);
  const size = receiver.rows * receiver.columns;
  if (payload.values.length !== size) {
    return fatal(
      `matrix header shape ${receiver.rows}x${receiver.columns} disagrees with storage ${payload.values.length}`,
    );
  }
  return payload.values;
}

function allocateStorage(
  ctx: CollectionContext,
  elementLayout: number,
  elements: readonly Stored[],
): MatrixValue['storage'] {
  return ctx.transaction.allocate(MATRIX_STORAGE, {
    values: elements,
    logicalBytes:
      16 + elements.length * ctx.layouts.shallowBytes(elementLayout),
  });
}

function matrixSize(rows: number, columns: number, max: number): number {
  const size = rows * columns;
  if (!Number.isSafeInteger(size)) {
    throw new ExecutionError('INVALID_SHAPE', 'matrix dimensions overflow');
  }
  assertLimit(size, max);
  return size;
}

function requireMatrixArg(
  ctx: CollectionContext,
  args: readonly Stored[],
  operation: string,
): MatrixValue {
  if (args.length === 0) {
    return fatal(`${operation} is missing its receiver`);
  }
  const value = args[0];
  return requireCollection(ctx, value, valueLayout(value), 'matrix');
}

function valueLayout(value: Stored): number {
  if (!isMatrixValue(value)) {
    if (value === null) {
      // The caller lacks a static layout here only because non-mutating calls
      // carry the receiver in args. The stable NA_COLLECTION error is enough.
      throw new ExecutionError('NA_COLLECTION', 'matrix operation on na');
    }
    return fatal('matrix operation received a non-matrix receiver');
  }
  return value.layout;
}

function requireArgs(
  operation: string,
  args: readonly Stored[],
  expected: number,
): void {
  if (args.length !== expected) {
    fatal(
      `${operation} received ${args.length} arguments, expected ${expected}`,
    );
  }
}
