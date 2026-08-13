// Purpose: User-facing runtime failures and execution control-flow errors.

export class BindError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BindError';
  }
}

// A dynamic request met a pair with no resolved context. Control flow, not a
// failure: the host awaits resolvePending() and re-executes the row.
export class ContextSuspension extends Error {
  constructor(
    readonly symbol: string,
    readonly timeframe: string,
  ) {
    super(`unresolved request context '${symbol}','${timeframe}'`);
    this.name = 'ContextSuspension';
  }
}

export class RequestError extends Error {
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
  | 'NA_USER_VALUE_WRITE'
  | 'VALUE_LAYOUT_MISMATCH';

export class ExecutionError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    msg: string,
  ) {
    super(`${code}: ${msg}`);
    this.name = 'ExecutionError';
  }
}
