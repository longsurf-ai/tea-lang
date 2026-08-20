// Purpose: Type-neutral storage arena with one explicit allocation/mutation transaction, prepared commit, deterministic reachability accounting, and stale-reference guards.

import {fatal} from '../base/print';
import {ExecutionError} from './errors';

declare const storageRefBrand: unique symbol;

export interface StorageRef<TPayload = unknown> {
  readonly [storageRefBrand]: TPayload;
}

export function isStorageRef(value: unknown): value is StorageRef<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    REFS.has(value as object)
  );
}

export type DescriptorId = symbol;
export type TransactionKey = string | number;

export interface StorageTracer {
  storage(ref: StorageRef<unknown>): void;
}

export type StorageJournalKey = string | number | symbol;

export interface PreparedStorageEdit<TUndo> {
  readonly key: StorageJournalKey;
  readonly undo: TUndo;
}

export interface StorageMutationDescriptor<TPayload, TEdit, TUndo> {
  // This is the throwing half of a mutation. It validates the edit and
  // captures everything restore needs before the payload changes.
  prepare(
    payload: Readonly<TPayload>,
    edit: Readonly<TEdit>,
  ): PreparedStorageEdit<TUndo>;
  // References introduced by the edit are checked before apply so apply and
  // restore can remain nonthrowing operations.
  traceEdit(edit: Readonly<TEdit>, tracer: StorageTracer): void;
  apply(payload: TPayload, edit: Readonly<TEdit>): void;
  restore(payload: TPayload, key: StorageJournalKey, undo: TUndo): void;
}

export interface StorageDescriptor<
  TPayload,
  TArgs,
  TEdit = never,
  TUndo = never,
> {
  readonly id: DescriptorId;
  readonly debugName: string;
  logicalBytesFor(args: Readonly<TArgs>): number;
  create(args: TArgs): TPayload;
  trace(payload: Readonly<TPayload>, tracer: StorageTracer): void;
  logicalBytes(payload: Readonly<TPayload>): number;
  readonly mutation?: StorageMutationDescriptor<TPayload, TEdit, TUndo>;
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
  readonly committedCells: number;
  readonly retainedCells: number;
  readonly retainedLogicalBytes: number;
  readonly tentativeCells: number;
  readonly tentativeLogicalBytes: number;
}

export interface Heap {
  beginTransaction(key: TransactionKey): HeapTransaction;
  read<TPayload, TArgs = unknown, TEdit = never, TUndo = never>(
    ref: StorageRef<unknown>,
    descriptor?: StorageDescriptor<TPayload, TArgs, TEdit, TUndo>,
  ): Readonly<TPayload>;
  collect(
    roots: Iterable<StorageRef<unknown>>,
    retainedRoots?: Iterable<StorageRef<unknown>>,
  ): void;
  dispose(): void;
  stats(): HeapStats;
}

export interface HeapTransaction {
  allocate<TPayload, TArgs, TEdit = never, TUndo = never>(
    descriptor: StorageDescriptor<TPayload, TArgs, TEdit, TUndo>,
    args: TArgs,
  ): StorageRef<TPayload>;
  mutate<TPayload, TArgs, TEdit, TUndo>(
    ref: StorageRef<unknown>,
    descriptor: StorageDescriptor<TPayload, TArgs, TEdit, TUndo>,
    edit: TEdit,
  ): void;
  prepareCommit(
    candidateRoots: Iterable<StorageRef<unknown>>,
  ): PreparedHeapCommit;
  abort(): void;
}

export interface PreparedHeapCommit {
  commit(): void;
}

type CellState = 'tentative' | 'committed';
type TransactionState = 'active' | 'prepared' | 'committed' | 'aborted';

interface RefRecord {
  readonly arena: HeapArena;
  readonly slot: number;
  readonly version: number;
  readonly descriptor: DescriptorId;
}

interface Cell {
  readonly version: number;
  readonly descriptor: StorageDescriptor<unknown, unknown, unknown, unknown>;
  readonly payload: unknown;
  readonly logicalBytes: number;
  state: CellState;
  transactionId: number | null;
}

interface UndoEntry {
  readonly slot: number;
  readonly key: StorageJournalKey;
  readonly mutation: StorageMutationDescriptor<unknown, unknown, unknown>;
  readonly undo: unknown;
}

const REFS = new WeakMap<object, RefRecord>();

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fatal(`invalid Heap limit ${name}=${value}`);
  }
  return value;
}

export class HeapArena implements Heap {
  private readonly limits: HeapLimits;
  private readonly cells: (Cell | null)[] = [];
  private readonly versions: number[] = [];
  private readonly free: number[] = [];
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

  beginTransaction(key: TransactionKey): HeapTransaction {
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

  read<TPayload, TArgs = unknown, TEdit = never, TUndo = never>(
    ref: StorageRef<unknown>,
    descriptor?: StorageDescriptor<TPayload, TArgs, TEdit, TUndo>,
  ): Readonly<TPayload> {
    this.assertLive();
    const record = this.refRecord(ref);
    const cell = this.cell(record);
    if (descriptor !== undefined && descriptor.id !== record.descriptor) {
      return fatal(
        `storage descriptor mismatch: expected '${descriptor.debugName}'`,
      );
    }
    if (cell.state === 'tentative') {
      const transaction = this.transaction;
      if (
        transaction === null ||
        transaction.terminal ||
        cell.transactionId !== transaction.id
      ) {
        return fatal(
          'tentative StorageRef is not owned by the current transaction',
        );
      }
    }
    return cell.payload as Readonly<TPayload>;
  }

  collect(
    roots: Iterable<StorageRef<unknown>>,
    retainedRoots?: Iterable<StorageRef<unknown>>,
  ): void {
    this.assertLive();
    if (this.transaction !== null && !this.transaction.terminal) {
      return fatal(
        `cannot collect while Heap transaction is ${this.transaction.state}`,
      );
    }
    // Snapshot once: an Iterable may be a single-use generator. When the
    // caller supplies one root view, physical and retained accounting must
    // see the identical sequence.
    const physicalRootList = [...roots];
    const retainedRootList =
      retainedRoots === undefined ? physicalRootList : [...retainedRoots];
    const reachable = this.traceClosure(physicalRootList, null, false);
    const retained = this.traceClosure(retainedRootList, null, false);
    for (const slot of retained) {
      if (!reachable.has(slot)) {
        return fatal('retained Heap roots are absent from physical roots');
      }
    }
    for (let slot = 0; slot < this.cells.length; slot += 1) {
      const cell = this.cells[slot];
      if (cell?.state === 'committed' && !reachable.has(slot)) {
        this.release(slot);
      }
    }
    this.updateRetained(retained);
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
        this.release(slot);
      }
    }
    this.retainedCells = 0;
    this.retainedLogicalBytes = 0;
    this.disposed = true;
  }

  stats(): HeapStats {
    let committedCells = 0;
    let tentativeCells = 0;
    let tentativeLogicalBytes = 0;
    for (const cell of this.cells) {
      if (cell?.state === 'committed') {
        committedCells += 1;
      } else if (cell?.state === 'tentative') {
        tentativeCells += 1;
        tentativeLogicalBytes += cell.logicalBytes;
      }
    }
    return {
      committedCells,
      retainedCells: this.retainedCells,
      retainedLogicalBytes: this.retainedLogicalBytes,
      tentativeCells,
      tentativeLogicalBytes,
    };
  }

  allocate<TPayload, TArgs, TEdit, TUndo>(
    transaction: TransactionImpl,
    descriptor: StorageDescriptor<TPayload, TArgs, TEdit, TUndo>,
    args: TArgs,
  ): StorageRef<TPayload> {
    this.assertCurrent(transaction, 'active');
    const estimatedBytes = descriptor.logicalBytesFor(args);
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) {
      return fatal(
        `storage descriptor '${descriptor.debugName}' returned invalid args logical bytes ${estimatedBytes}`,
      );
    }
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
    const payload = descriptor.create(args);
    const bytes = descriptor.logicalBytes(payload);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return fatal(
        `storage descriptor '${descriptor.debugName}' returned invalid logical bytes ${bytes}`,
      );
    }
    if (bytes !== estimatedBytes) {
      return fatal(
        `storage descriptor '${descriptor.debugName}' args estimate ${estimatedBytes} disagrees with created logical bytes ${bytes}`,
      );
    }

    const slot = this.free.pop() ?? this.cells.length;
    const version = (this.versions[slot] ?? 0) + 1;
    this.versions[slot] = version;
    const erased = descriptor as unknown as StorageDescriptor<
      unknown,
      unknown,
      unknown,
      unknown
    >;
    this.cells[slot] = {
      version,
      descriptor: erased,
      payload,
      logicalBytes: bytes,
      state: 'tentative',
      transactionId: transaction.id,
    };
    const ref = Object.freeze({}) as StorageRef<TPayload>;
    REFS.set(ref as object, {
      arena: this,
      slot,
      version,
      descriptor: descriptor.id,
    });
    transaction.tentative.add(slot);
    transaction.transientBytes += bytes;

    try {
      descriptor.trace(payload, {
        storage: child => this.assertPayloadRef(transaction, child),
      });
    } catch (error) {
      transaction.tentative.delete(slot);
      transaction.transientBytes -= bytes;
      this.release(slot);
      throw error;
    }
    return ref;
  }

  mutate<TPayload, TArgs, TEdit, TUndo>(
    transaction: TransactionImpl,
    ref: StorageRef<unknown>,
    descriptor: StorageDescriptor<TPayload, TArgs, TEdit, TUndo>,
    edit: TEdit,
  ): void {
    this.assertCurrent(transaction, 'active');
    const record = this.refRecord(ref);
    const cell = this.cell(record);
    if (descriptor.id !== record.descriptor) {
      return fatal(
        `storage descriptor mismatch: expected '${descriptor.debugName}'`,
      );
    }
    if (cell.state === 'tentative' && cell.transactionId !== transaction.id) {
      return fatal(
        'tentative StorageRef is not owned by the current transaction',
      );
    }
    const mutation = descriptor.mutation;
    if (mutation === undefined) {
      return fatal(
        `storage descriptor '${descriptor.debugName}' does not admit mutation`,
      );
    }

    // prepare and traceEdit are the only potentially throwing descriptor
    // operations. Complete both before changing the payload.
    const prepared = mutation.prepare(cell.payload as Readonly<TPayload>, edit);
    mutation.traceEdit(edit, {
      storage: child => this.assertPayloadRef(transaction, child),
    });

    if (cell.state === 'committed') {
      transaction.recordUndo(
        record.slot,
        prepared.key,
        mutation as unknown as StorageMutationDescriptor<
          unknown,
          unknown,
          unknown
        >,
        prepared.undo,
      );
    }
    mutation.apply(cell.payload as TPayload, edit);
    const bytes = descriptor.logicalBytes(cell.payload as Readonly<TPayload>);
    if (bytes !== cell.logicalBytes) {
      return fatal(
        `storage descriptor '${descriptor.debugName}' changed logical bytes during in-place mutation`,
      );
    }
  }

  prepare(
    transaction: TransactionImpl,
    candidateRoots: Iterable<StorageRef<unknown>>,
  ): PreparedHeapCommit {
    this.assertCurrent(transaction, 'active');
    const roots = [...candidateRoots];
    const reachable = this.traceClosure(roots, transaction, true);
    let bytes = 0;
    for (const slot of reachable) {
      const cell = this.cells[slot];
      if (cell === null || cell === undefined) {
        return fatal(`reachable Heap slot ${slot} disappeared during prepare`);
      }
      bytes += cell.logicalBytes;
    }
    if (
      reachable.size > this.limits.maxStorageCells ||
      bytes > this.limits.maxLogicalBytes
    ) {
      throw new ExecutionError(
        'HEAP_LIMIT_EXCEEDED',
        'retained Heap storage limit exceeded',
      );
    }
    const promote = [...transaction.tentative].filter(slot =>
      reachable.has(slot),
    );
    const discard = [...transaction.tentative].filter(
      slot => !reachable.has(slot),
    );
    transaction.state = 'prepared';
    return new PreparedCommit(
      this,
      transaction,
      reachable,
      bytes,
      promote,
      discard,
    );
  }

  commit(
    commit: PreparedCommit,
    transaction: TransactionImpl,
    reachable: ReadonlySet<number>,
    bytes: number,
    promote: readonly number[],
    discard: readonly number[],
  ): void {
    this.assertCurrent(transaction, 'prepared');
    if (commit.consumed) {
      return fatal('Heap commit was already consumed');
    }
    commit.consumed = true;
    for (const slot of promote) {
      const cell = this.cells[slot];
      if (cell === null || cell === undefined) {
        return fatal(`prepared Heap slot ${slot} disappeared before commit`);
      }
      cell.state = 'committed';
      cell.transactionId = null;
    }
    for (const slot of discard) {
      this.release(slot);
    }
    transaction.tentative.clear();
    transaction.transientBytes = 0;
    transaction.clearUndo();
    transaction.state = 'committed';
    this.updateRetained(reachable, bytes);
  }

  abort(transaction: TransactionImpl): void {
    if (transaction.terminal) {
      return fatal(`cannot abort Heap transaction after ${transaction.state}`);
    }
    if (this.transaction !== transaction) {
      return fatal(
        'cannot abort a Heap transaction owned by another arena state',
      );
    }
    transaction.restoreUndo(this.cells);
    for (const slot of transaction.tentative) {
      this.release(slot);
    }
    transaction.tentative.clear();
    transaction.transientBytes = 0;
    transaction.state = 'aborted';
  }

  private assertPayloadRef(
    transaction: TransactionImpl,
    ref: StorageRef<unknown>,
  ): void {
    const record = this.refRecord(ref);
    const cell = this.cell(record);
    if (cell.state === 'committed') {
      return;
    }
    if (cell.transactionId !== transaction.id) {
      fatal(
        'storage payload points to tentative storage from another transaction',
      );
    }
  }

  private traceClosure(
    roots: Iterable<StorageRef<unknown>>,
    transaction: TransactionImpl | null,
    allowTentative: boolean,
  ): Set<number> {
    const reachable = new Set<number>();
    const pending = [...roots];
    while (pending.length > 0) {
      const ref = pending.pop();
      if (ref === undefined) {
        continue;
      }
      const record = this.refRecord(ref);
      const cell = this.cell(record);
      if (cell.state === 'tentative') {
        if (
          !allowTentative ||
          transaction === null ||
          cell.transactionId !== transaction.id
        ) {
          fatal(
            'commit root reaches tentative storage outside its transaction',
          );
        }
      }
      if (reachable.has(record.slot)) {
        continue;
      }
      reachable.add(record.slot);
      cell.descriptor.trace(cell.payload as Readonly<unknown>, {
        storage: child => pending.push(child),
      });
    }
    return reachable;
  }

  private updateRetained(
    reachable: ReadonlySet<number>,
    knownBytes?: number,
  ): void {
    let bytes = knownBytes ?? 0;
    if (knownBytes === undefined) {
      for (const slot of reachable) {
        const cell = this.cells[slot];
        if (cell === null || cell === undefined) {
          return fatal(`retained Heap slot ${slot} is absent`);
        }
        bytes += cell.logicalBytes;
      }
    }
    this.retainedCells = reachable.size;
    this.retainedLogicalBytes = bytes;
  }

  private refRecord(ref: StorageRef<unknown>): RefRecord {
    if (
      (typeof ref !== 'object' && typeof ref !== 'function') ||
      ref === null
    ) {
      return fatal('invalid StorageRef');
    }
    const record = REFS.get(ref as object);
    if (record === undefined) {
      return fatal('forged or unknown StorageRef');
    }
    if (record.arena !== this) {
      return fatal('StorageRef belongs to another Heap arena');
    }
    return record;
  }

  private cell(record: RefRecord): Cell {
    const cell = this.cells[record.slot];
    if (cell === null || cell === undefined) {
      return fatal('stale StorageRef');
    }
    if (cell.version !== record.version) {
      return fatal('stale StorageRef version');
    }
    if (cell.descriptor.id !== record.descriptor) {
      return fatal('StorageRef descriptor does not match its cell');
    }
    return cell;
  }

  private release(slot: number): void {
    if (this.cells[slot] === null || this.cells[slot] === undefined) {
      return;
    }
    this.cells[slot] = null;
    this.free.push(slot);
  }

  private assertCurrent(
    transaction: TransactionImpl,
    state: 'active' | 'prepared',
  ): void {
    this.assertLive();
    if (this.transaction !== transaction) {
      return fatal('Heap transaction is not current');
    }
    if (transaction.state !== state) {
      return fatal(
        `Heap transaction '${String(transaction.key)}' is ${transaction.state}, expected ${state}`,
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
  transientBytes = 0;
  private readonly undo: UndoEntry[] = [];
  private readonly undoKeys = new Map<number, Set<StorageJournalKey>>();

  constructor(
    private readonly arena: HeapArena,
    readonly id: number,
    readonly key: TransactionKey,
  ) {}

  get terminal(): boolean {
    return this.state === 'committed' || this.state === 'aborted';
  }

  allocate<TPayload, TArgs, TEdit = never, TUndo = never>(
    descriptor: StorageDescriptor<TPayload, TArgs, TEdit, TUndo>,
    args: TArgs,
  ): StorageRef<TPayload> {
    return this.arena.allocate(this, descriptor, args);
  }

  mutate<TPayload, TArgs, TEdit, TUndo>(
    ref: StorageRef<unknown>,
    descriptor: StorageDescriptor<TPayload, TArgs, TEdit, TUndo>,
    edit: TEdit,
  ): void {
    this.arena.mutate(this, ref, descriptor, edit);
  }

  recordUndo(
    slot: number,
    key: StorageJournalKey,
    mutation: StorageMutationDescriptor<unknown, unknown, unknown>,
    undo: unknown,
  ): void {
    let keys = this.undoKeys.get(slot);
    if (keys === undefined) {
      keys = new Set();
      this.undoKeys.set(slot, keys);
    }
    if (keys.has(key)) {
      return;
    }
    keys.add(key);
    this.undo.push({slot, key, mutation, undo});
  }

  restoreUndo(cells: readonly (Cell | null)[]): void {
    for (let index = this.undo.length - 1; index >= 0; index -= 1) {
      const entry = this.undo[index];
      const cell = cells[entry.slot];
      if (cell === null || cell === undefined) {
        return fatal(`journaled Heap slot ${entry.slot} disappeared`);
      }
      entry.mutation.restore(cell.payload, entry.key, entry.undo);
    }
    this.clearUndo();
  }

  clearUndo(): void {
    this.undo.length = 0;
    this.undoKeys.clear();
  }

  prepareCommit(
    candidateRoots: Iterable<StorageRef<unknown>>,
  ): PreparedHeapCommit {
    return this.arena.prepare(this, candidateRoots);
  }

  abort(): void {
    this.arena.abort(this);
  }
}

class PreparedCommit implements PreparedHeapCommit {
  consumed = false;

  constructor(
    private readonly arena: HeapArena,
    private readonly transaction: TransactionImpl,
    private readonly reachable: ReadonlySet<number>,
    private readonly bytes: number,
    private readonly promote: readonly number[],
    private readonly discard: readonly number[],
  ) {}

  commit(): void {
    this.arena.commit(
      this,
      this.transaction,
      this.reachable,
      this.bytes,
      this.promote,
      this.discard,
    );
  }
}
