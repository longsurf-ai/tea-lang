// Purpose: User-facing runtime failures and execution control-flow errors.

import {OperationalError} from '../base/operational-error';

export class BindError extends OperationalError {
  constructor(msg: string) {
    super(msg);
    this.name = 'BindError';
  }
}

export class RequestError extends OperationalError {
  constructor(msg: string) {
    super(msg);
    this.name = 'RequestError';
  }
}

export type ExecutionErrorCode =
  | 'NA_COLLECTION'
  | 'INDEX_OUT_OF_BOUNDS'
  | 'EMPTY_COLLECTION'
  | 'INVALID_SHAPE'
  | 'INVALID_MAP_KEY'
  | 'COLLECTION_LIMIT_EXCEEDED'
  | 'HEAP_LIMIT_EXCEEDED'
  | 'FIXED_VALUE_STORAGE_LIMIT_EXCEEDED'
  | 'NA_STRUCT_WRITE'
  | 'VALUE_LAYOUT_MISMATCH';

export class ExecutionError extends OperationalError {
  constructor(
    readonly code: ExecutionErrorCode,
    msg: string,
  ) {
    super(`${code}: ${msg}`);
    this.name = 'ExecutionError';
  }
}
