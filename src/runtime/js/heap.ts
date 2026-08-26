// Purpose: Typed transactional storage arena with precise roots, stop-the-world Mark-Sweep collection, deterministic limits, and stale-reference guards.

import {fatal} from '../../base/print';
import {ExecutionError} from '../errors';

declare const refBrand: unique symbol;

/** An opaque handle whose type parameter is the payload stored in one cell. */
export interface Ref<V = unknown> {
  readonly [refBrand]: V;
}

export type AnyRef = Ref<unknown>;

export function isRef(value: unknown): value is AnyRef {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    REFS.has(value as object)
  );
}

export type TypeId = symbol;
export type TransactionKey = string | number;

/** Runtime policy for constructing, accounting, and tracing one payload type. */
export interface TypeInfo<A, V> {
  /** Stable runtime identity used by cell and reference invariant checks. */
  readonly id: TypeId;
  /** Human-readable name used only in diagnostics. */
  readonly name: string;
  /**
   * Return the exact bytes directly owned by the payload that `create(args)`
   * will produce. Referenced child cells are counted separately.
   */
  bytesFor(args: Readonly<A>): number;
  /** Construct the payload stored in one Heap cell. */
  create(args: A): V;
  /**
   * Return the exact bytes directly owned by an existing payload. Referenced
   * child cells are counted separately.
   */
  bytesOf(value: Readonly<V>): number;
  /**
   * Visit every direct outgoing Ref in `value`. Heap owns recursive traversal,
   * sharing, and cycle detection.
   */
  trace(value: Readonly<V>, visit: (ref: AnyRef) => void): void;
}

export interface HeapLimits {
  readonly maxStorageCells: number;
  readonly maxLogicalBytes: number;
  readonly maxTransientStorageCells: number;
  readonly maxTransientLogicalBytes: number;
}

export const DEFAULT_HEAP_LIMITS: HeapLimits = {
  maxStorageCells: 100_000,
  maxLogicalBytes: 64 * 1024 * 1024,
  maxTransientStorageCells: 10_000,
  maxTransientLogicalBytes: 16 * 1024 * 1024,
};

export interface HeapStats {
  /** All committed cells, including garbage not yet swept. */
  readonly committedCells: number;
  /** Cells reachable during the most recent collection. */
  readonly retainedCells: number;
  /** Direct bytes reachable during the most recent collection. */
  readonly retainedLogicalBytes: number;
  /** Cells allocated by the active transaction. */
  readonly tentativeCells: number;
  /** Direct bytes owned by active allocations and replacement payloads. */
  readonly tentativeLogicalBytes: number;
}

export interface Heap {
  begin(key?: TransactionKey): HeapTransaction;
  /** Read committed state. Transactional replacements are intentionally hidden. */
  read<V>(ref: Ref<V>): Readonly<V>;
  /** Replace the complete precise root snapshot at a collection safe point. */
  replaceRoots(roots: Iterable<AnyRef>): void;
  /** Mark from the stored roots and privately reclaim every unmarked cell. */
  collect(): void;
  dispose(): void;
  stats(): HeapStats;
}

export interface HeapTransaction {
  allocate<A, V>(info: TypeInfo<A, V>, args: A): Ref<V>;
  /** Read this transaction's replacement first, then committed state. */
  read<V>(ref: Ref<V>): Readonly<V>;
  /** Stage a complete replacement payload for the referenced identity. */
  write<V>(ref: Ref<V>, value: V): void;
  commit(): void;
  abort(): void;
}

type CellState = 'tentative' | 'committed';
type TransactionState = 'active' | 'committed' | 'aborted';

interface RefRecord {
  readonly arena: ArenaHeap;
  readonly slot: number;
  readonly version: number;
  readonly type: TypeId;
}

interface Cell {
  readonly version: number;
  readonly info: ErasedTypeInfo;
  payload: unknown;
  bytes: number;
  state: CellState;
  transactionId: number | null;
}

interface PendingWrite {
  readonly payload: unknown;
  readonly bytes: number;
}

interface ErasedTypeInfo {
  readonly id: TypeId;
  readonly name: string;
  bytesOf(value: unknown): number;
  trace(value: unknown, visit: (ref: AnyRef) => void): void;
}

const REFS = new WeakMap<object, RefRecord>();

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fatal(`invalid Heap limit ${name}=${value}`);
  }
  return value;
}

function bytes(value: number, info: ErasedTypeInfo, source: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fatal(
      `type info '${info.name}' returned invalid ${source} bytes ${value}`,
    );
  }
  return value;
}

export class ArenaHeap implements Heap {
  private readonly limits: HeapLimits;
  private readonly cells: (Cell | null)[] = [];
  private readonly versions: number[] = [];
  private readonly free: number[] = [];
  private roots: readonly AnyRef[] = [];
  private rootsFresh = true;
  private transaction: TransactionImpl | null = null;
  private nextTransactionId = 1;
  private disposed = false;
  private retainedCells = 0;
  private retainedLogicalBytes = 0;

  constructor(limits: Partial<HeapLimits> = {}) {
    this.limits = {
      maxStorageCells: limit(
        limits.maxStorageCells ?? DEFAULT_HEAP_LIMITS.maxStorageCells,
        'maxStorageCells',
      ),
      maxLogicalBytes: limit(
        limits.maxLogicalBytes ?? DEFAULT_HEAP_LIMITS.maxLogicalBytes,
        'maxLogicalBytes',
      ),
      maxTransientStorageCells: limit(
        limits.maxTransientStorageCells ??
          DEFAULT_HEAP_LIMITS.maxTransientStorageCells,
        'maxTransientStorageCells',
      ),
      maxTransientLogicalBytes: limit(
        limits.maxTransientLogicalBytes ??
          DEFAULT_HEAP_LIMITS.maxTransientLogicalBytes,
        'maxTransientLogicalBytes',
      ),
    };
  }

  begin(key: TransactionKey = 'transaction'): HeapTransaction {
    this.assertLive();
    if (this.transaction !== null && !this.transaction.terminal) {
      return fatal(
        `cannot begin Heap transaction '${String(key)}' while '${String(this.transaction.key)}' is ${this.transaction.state}`,
      );
    }
    const transaction = new TransactionImpl(this, this.nextTransactionId, key);
    this.nextTransactionId += 1;
    this.transaction = transaction;
    return transaction;
  }

  read<V>(ref: Ref<V>): Readonly<V> {
    this.assertLive();
    const cell = this.cell(this.refRecord(ref));
    if (cell.state !== 'committed') {
      return fatal('tentative Ref is readable only through its transaction');
    }
    return cell.payload as Readonly<V>;
  }

  replaceRoots(roots: Iterable<AnyRef>): void {
    this.assertLive();
    this.assertNoActiveTransaction('replace roots');
    const snapshot = [...new Set(roots)];
    for (const ref of snapshot) {
      const cell = this.cell(this.refRecord(ref));
      if (cell.state !== 'committed') {
        return fatal('Heap root refers to tentative storage');
      }
    }
    this.roots = snapshot;
    this.rootsFresh = true;
  }

  collect(): void {
    this.assertLive();
    this.assertNoActiveTransaction('collect');
    if (!this.rootsFresh) {
      return fatal('cannot collect before refreshing Heap roots');
    }
    const reachable = this.traceClosure(this.roots);
    let retainedBytes = 0;
    for (const slot of reachable) {
      const cell = this.cells[slot];
      if (cell === null || cell === undefined) {
        return fatal(`marked Heap slot ${slot} disappeared`);
      }
      retainedBytes += cell.bytes;
    }
    if (
      reachable.size > this.limits.maxStorageCells ||
      retainedBytes > this.limits.maxLogicalBytes
    ) {
      throw new ExecutionError(
        'HEAP_LIMIT_EXCEEDED',
        'live Heap storage limit exceeded',
      );
    }
    for (let slot = 0; slot < this.cells.length; slot += 1) {
      const cell = this.cells[slot];
      if (cell?.state === 'committed' && !reachable.has(slot)) {
        this.deallocate(slot);
      }
    }
    this.retainedCells = reachable.size;
    this.retainedLogicalBytes = retainedBytes;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    if (this.transaction !== null && !this.transaction.terminal) {
      this.transaction.abort();
    }
    for (let slot = 0; slot < this.cells.length; slot += 1) {
      if (this.cells[slot] !== null) {
        this.deallocate(slot);
      }
    }
    this.roots = [];
    this.retainedCells = 0;
    this.retainedLogicalBytes = 0;
    this.disposed = true;
  }

  stats(): HeapStats {
    let committedCells = 0;
    for (const cell of this.cells) {
      if (cell?.state === 'committed') {
        committedCells += 1;
      }
    }
    const transaction =
      this.transaction !== null && !this.transaction.terminal
        ? this.transaction
        : null;
    return {
      committedCells,
      retainedCells: this.retainedCells,
      retainedLogicalBytes: this.retainedLogicalBytes,
      tentativeCells: transaction?.tentative.size ?? 0,
      tentativeLogicalBytes: transaction?.transientBytes ?? 0,
    };
  }

  allocate<A, V>(
    transaction: TransactionImpl,
    info: TypeInfo<A, V>,
    args: A,
  ): Ref<V> {
    this.assertCurrent(transaction);
    const erased = info as unknown as ErasedTypeInfo;
    const estimatedBytes = bytes(info.bytesFor(args), erased, 'argument');
    if (
      transaction.tentative.size + 1 > this.limits.maxTransientStorageCells ||
      transaction.transientBytes + estimatedBytes >
        this.limits.maxTransientLogicalBytes
    ) {
      throw new ExecutionError(
        'HEAP_LIMIT_EXCEEDED',
        'transient Heap allocation limit exceeded',
      );
    }

    const payload = info.create(args);
    const actualBytes = bytes(info.bytesOf(payload), erased, 'payload');
    if (actualBytes !== estimatedBytes) {
      return fatal(
        `type info '${info.name}' argument estimate ${estimatedBytes} disagrees with created bytes ${actualBytes}`,
      );
    }

    const slot = this.free.pop() ?? this.cells.length;
    const version = (this.versions[slot] ?? 0) + 1;
    this.versions[slot] = version;
    this.cells[slot] = {
      version,
      info: erased,
      payload,
      bytes: actualBytes,
      state: 'tentative',
      transactionId: transaction.id,
    };
    const ref = Object.freeze({}) as Ref<V>;
    REFS.set(ref as object, {
      arena: this,
      slot,
      version,
      type: info.id,
    });
    transaction.tentative.add(slot);
    transaction.transientBytes += actualBytes;

    try {
      this.tracePayload(transaction, erased, payload);
    } catch (error) {
      transaction.tentative.delete(slot);
      transaction.transientBytes -= actualBytes;
      this.deallocate(slot);
      throw error;
    }
    return ref;
  }

  readTransaction<V>(transaction: TransactionImpl, ref: Ref<V>): Readonly<V> {
    this.assertCurrent(transaction);
    const record = this.refRecord(ref);
    const cell = this.cell(record);
    if (cell.state === 'tentative' && cell.transactionId !== transaction.id) {
      return fatal('tentative Ref belongs to another transaction');
    }
    const pending = transaction.writes.get(record.slot);
    return (pending?.payload ?? cell.payload) as Readonly<V>;
  }

  write<V>(transaction: TransactionImpl, ref: Ref<V>, payload: V): void {
    this.assertCurrent(transaction);
    const record = this.refRecord(ref);
    const cell = this.cell(record);
    if (cell.state === 'tentative' && cell.transactionId !== transaction.id) {
      return fatal('tentative Ref belongs to another transaction');
    }
    const nextBytes = bytes(
      cell.info.bytesOf(payload),
      cell.info,
      'replacement payload',
    );
    this.tracePayload(transaction, cell.info, payload);

    if (cell.state === 'tentative') {
      const nextTransient = transaction.transientBytes - cell.bytes + nextBytes;
      if (nextTransient > this.limits.maxTransientLogicalBytes) {
        throw new ExecutionError(
          'HEAP_LIMIT_EXCEEDED',
          'transient Heap write limit exceeded',
        );
      }
      cell.payload = payload;
      cell.bytes = nextBytes;
      transaction.transientBytes = nextTransient;
      return;
    }

    const previous = transaction.writes.get(record.slot);
    const nextTransient =
      transaction.transientBytes - (previous?.bytes ?? 0) + nextBytes;
    if (nextTransient > this.limits.maxTransientLogicalBytes) {
      throw new ExecutionError(
        'HEAP_LIMIT_EXCEEDED',
        'transient Heap write limit exceeded',
      );
    }
    transaction.writes.set(record.slot, {payload, bytes: nextBytes});
    transaction.transientBytes = nextTransient;
  }

  commit(transaction: TransactionImpl): void {
    this.assertCurrent(transaction);
    for (const [slot, pending] of transaction.writes) {
      const cell = this.cells[slot];
      if (cell === null || cell === undefined || cell.state !== 'committed') {
        return fatal(`written Heap slot ${slot} disappeared before commit`);
      }
      cell.payload = pending.payload;
      cell.bytes = pending.bytes;
    }
    for (const slot of transaction.tentative) {
      const cell = this.cells[slot];
      if (cell === null || cell === undefined) {
        return fatal(`tentative Heap slot ${slot} disappeared before commit`);
      }
      cell.state = 'committed';
      cell.transactionId = null;
    }
    transaction.clear();
    transaction.state = 'committed';
    this.rootsFresh = false;
  }

  abort(transaction: TransactionImpl): void {
    if (transaction.terminal) {
      return fatal(`cannot abort Heap transaction after ${transaction.state}`);
    }
    if (this.transaction !== transaction) {
      return fatal('cannot abort a Heap transaction owned by another arena');
    }
    for (const slot of transaction.tentative) {
      this.deallocate(slot);
    }
    transaction.clear();
    transaction.state = 'aborted';
  }

  private tracePayload(
    transaction: TransactionImpl,
    info: ErasedTypeInfo,
    payload: unknown,
  ): void {
    info.trace(payload, child => this.assertPayloadRef(transaction, child));
  }

  private assertPayloadRef(transaction: TransactionImpl, ref: AnyRef): void {
    const cell = this.cell(this.refRecord(ref));
    if (cell.state === 'committed') {
      return;
    }
    if (cell.transactionId !== transaction.id) {
      fatal('payload points to tentative storage from another transaction');
    }
  }

  private traceClosure(roots: Iterable<AnyRef>): Set<number> {
    const marked = new Set<number>();
    const worklist = [...roots];
    while (worklist.length > 0) {
      const ref = worklist.pop();
      if (ref === undefined) {
        continue;
      }
      const record = this.refRecord(ref);
      const cell = this.cell(record);
      if (cell.state !== 'committed') {
        return fatal('Mark-Sweep reached tentative storage');
      }
      if (marked.has(record.slot)) {
        continue;
      }
      marked.add(record.slot);
      cell.info.trace(cell.payload, child => worklist.push(child));
    }
    return marked;
  }

  private refRecord(ref: AnyRef): RefRecord {
    if (
      (typeof ref !== 'object' && typeof ref !== 'function') ||
      ref === null
    ) {
      return fatal('invalid Ref');
    }
    const record = REFS.get(ref as object);
    if (record === undefined) {
      return fatal('forged or unknown Ref');
    }
    if (record.arena !== this) {
      return fatal('Ref belongs to another Heap arena');
    }
    return record;
  }

  private cell(record: RefRecord): Cell {
    const cell = this.cells[record.slot];
    if (cell === null || cell === undefined) {
      return fatal('stale Ref');
    }
    if (cell.version !== record.version) {
      return fatal('stale Ref version');
    }
    if (cell.info.id !== record.type) {
      return fatal('Ref type does not match its cell');
    }
    return cell;
  }

  private deallocate(slot: number): void {
    if (this.cells[slot] === null || this.cells[slot] === undefined) {
      return;
    }
    this.cells[slot] = null;
    this.free.push(slot);
  }

  private assertCurrent(transaction: TransactionImpl): void {
    this.assertLive();
    if (this.transaction !== transaction) {
      return fatal('Heap transaction is not current');
    }
    if (transaction.state !== 'active') {
      return fatal(
        `Heap transaction '${String(transaction.key)}' is ${transaction.state}, expected active`,
      );
    }
  }

  private assertNoActiveTransaction(operation: string): void {
    if (this.transaction !== null && !this.transaction.terminal) {
      fatal(
        `cannot ${operation} while Heap transaction is ${this.transaction.state}`,
      );
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      fatal('Heap arena is disposed');
    }
  }
}

class TransactionImpl implements HeapTransaction {
  state: TransactionState = 'active';
  readonly tentative = new Set<number>();
  readonly writes = new Map<number, PendingWrite>();
  transientBytes = 0;

  constructor(
    private readonly arena: ArenaHeap,
    readonly id: number,
    readonly key: TransactionKey,
  ) {}

  get terminal(): boolean {
    return this.state === 'committed' || this.state === 'aborted';
  }

  allocate<A, V>(info: TypeInfo<A, V>, args: A): Ref<V> {
    return this.arena.allocate(this, info, args);
  }

  read<V>(ref: Ref<V>): Readonly<V> {
    return this.arena.readTransaction(this, ref);
  }

  write<V>(ref: Ref<V>, value: V): void {
    this.arena.write(this, ref, value);
  }

  commit(): void {
    this.arena.commit(this);
  }

  abort(): void {
    this.arena.abort(this);
  }

  clear(): void {
    this.tentative.clear();
    this.writes.clear();
    this.transientBytes = 0;
  }
}
