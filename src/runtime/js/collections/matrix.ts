// Fixed-shape row-major matrices; projections allocate independent arrays.

import {fatal} from '../../../base/print';
import {ExecutionError} from '../../errors';
import type {CollectionMutation} from '../../module-abi';
import {MatrixValue, visitValueRefs, type Stored} from '../../value';
import type {TypeInfo} from '../heap';
import {Value, int} from '../value';
import {createArray} from './array';
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

export interface MatrixStorage {
  readonly values: readonly Value<unknown>[];
  readonly logicalBytes: number;
}

export const MATRIX_STORAGE: TypeInfo<MatrixStorage, MatrixStorage> = {
  id: Symbol('tea.matrix.storage'),
  name: 'matrix storage',
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

export function matrixCall(
  ctx: CollectionContext,
  operation: string,
  result: Value<unknown>,
  args: readonly Value<unknown>[],
): Stored | Value<unknown> {
  if (operation === 'matrix.new') {
    const element =
      result.element ?? fatal('matrix constructor requires an empty element');
    if (args.length === 0) return createMatrix(ctx, element, 0, 0, []);
    requireArgs(operation, args, 3);
    const rows = shape(args[0], 'matrix rows');
    const columns = shape(args[1], 'matrix columns');
    const size = matrixSize(rows, columns, ctx.maxElements);
    assertType(ctx, element, args[2], 'matrix initial value');
    return createMatrix(
      ctx,
      element,
      rows,
      columns,
      Array.from({length: size}, () => args[2]),
    );
  }
  const receiver = requireCollection(ctx, args[0], 'matrix');
  switch (operation) {
    case 'matrix.rows':
      requireArgs(operation, args, 1);
      return int(receiver.rows);
    case 'matrix.columns':
      requireArgs(operation, args, 1);
      return int(receiver.columns);
    case 'matrix.elements_count':
      requireArgs(operation, args, 1);
      return int(receiver.rows * receiver.columns);
    case 'matrix.get': {
      requireArgs(operation, args, 3);
      const row = index(args[1], receiver.rows, 'row');
      const column = index(args[2], receiver.columns, 'column');
      return values(ctx, receiver)[row * receiver.columns + column];
    }
    case 'matrix.row': {
      requireArgs(operation, args, 2);
      const row = index(args[1], receiver.rows, 'row');
      const start = row * receiver.columns;
      return createArray(
        ctx,
        receiver.element,
        values(ctx, receiver).slice(start, start + receiver.columns),
      );
    }
    case 'matrix.column': {
      requireArgs(operation, args, 2);
      const column = index(args[1], receiver.columns, 'column');
      const storage = values(ctx, receiver);
      return createArray(
        ctx,
        receiver.element,
        Array.from(
          {length: receiver.rows},
          (_, row) => storage[row * receiver.columns + column],
        ),
      );
    }
    case 'matrix.copy':
      requireArgs(operation, args, 1);
      return new MatrixValue(
        receiver.element,
        receiver.storage,
        receiver.rows,
        receiver.columns,
      );
    default:
      return fatal(`unknown non-mutating matrix operation '${operation}'`);
  }
}

export function matrixMutate(
  ctx: CollectionContext,
  operation: string,
  value: Value<unknown>,
  args: readonly Value<unknown>[],
): CollectionMutation {
  const receiver = requireCollection(ctx, value, 'matrix');
  const old = values(ctx, receiver);
  switch (operation) {
    case 'matrix.set': {
      requireArgs(operation, args, 3);
      const row = index(args[0], receiver.rows, 'row');
      const column = index(args[1], receiver.columns, 'column');
      assertType(ctx, receiver.element, args[2], 'matrix.set value');
      const next = [...old];
      next[row * receiver.columns + column] = args[2];
      return {replacement: replace(ctx, receiver, next), result: undefined};
    }
    case 'matrix.fill':
      requireArgs(operation, args, 1);
      assertType(ctx, receiver.element, args[0], 'matrix.fill value');
      return {
        replacement: replace(
          ctx,
          receiver,
          Array.from({length: old.length}, () => args[0]),
        ),
        result: undefined,
      };
    default:
      return fatal(`unknown mutating matrix operation '${operation}'`);
  }
}

function createMatrix(
  ctx: CollectionContext,
  element: Value<unknown>,
  rows: number,
  columns: number,
  elements: readonly Value<unknown>[],
): MatrixValue {
  const size = matrixSize(rows, columns, ctx.maxElements);
  if (elements.length !== size)
    return fatal(
      `matrix ${rows}x${columns} has ${elements.length} storage elements`,
    );
  elements.forEach((value, at) =>
    assertType(ctx, element, value, `matrix element ${at}`),
  );
  return new MatrixValue(
    element,
    allocateStorage(ctx, element, elements),
    rows,
    columns,
  );
}

function replace(
  ctx: CollectionContext,
  receiver: MatrixValue,
  elements: readonly Value<unknown>[],
): MatrixValue {
  return new MatrixValue(
    receiver.element,
    allocateStorage(ctx, receiver.element, elements),
    receiver.rows,
    receiver.columns,
  );
}

function values(
  ctx: CollectionReadContext,
  receiver: MatrixValue,
): readonly Value<unknown>[] {
  const payload = ctx.transaction.read(receiver.storage);
  const size = receiver.rows * receiver.columns;
  if (
    !Number.isSafeInteger(receiver.rows) ||
    receiver.rows < 0 ||
    !Number.isSafeInteger(receiver.columns) ||
    receiver.columns < 0 ||
    !Number.isSafeInteger(size) ||
    payload.values.length !== size
  )
    return fatal(
      `matrix header shape ${receiver.rows}x${receiver.columns} disagrees with storage ${payload.values.length}`,
    );
  return payload.values;
}

function allocateStorage(
  ctx: CollectionContext,
  element: Value<unknown>,
  elements: readonly Value<unknown>[],
): MatrixValue['storage'] {
  return ctx.transaction.allocate(MATRIX_STORAGE, {
    values: elements,
    logicalBytes: 16 + elements.length * element.byteSize,
  });
}

function matrixSize(rows: number, columns: number, max: number): number {
  const size = rows * columns;
  if (!Number.isSafeInteger(size))
    throw new ExecutionError('INVALID_SHAPE', 'matrix dimensions overflow');
  assertLimit(size, max);
  return size;
}
