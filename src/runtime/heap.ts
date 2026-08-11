// Purpose: Type-neutral immutable storage arena with one explicit execution attempt, prepared publication, deterministic reachability accounting, and stale-reference guards.

import {fatal} from '../base/print';
import {ExecutionError} from './abi';

declare const storageRefBrand: unique symbol;

export interface StorageRef<TPayload = unknown> {
  readonly [storageRefBrand]: TPayload;
}

export type DescriptorId = symbol;
export type ExecutionKey = string | number;

export interface StorageTracer {
  storage(ref: StorageRef<unknown>): void;
}

export interface StorageDescriptor<TPayload, TBuilder> {
  readonly id: DescriptorId;
  readonly debugName: string;
  builderLogicalBytes(builder: Readonly<TBuilder>): number;
  seal(builder: TBuilder): TPayload;
  trace(payload: Readonly<TPayload>, tracer: StorageTracer): void;
  logicalBytes(payload: Readonly<TPayload>): number;
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
  readonly publishedCells: number;
  readonly retainedCells: number;
  readonly retainedLogicalBytes: number;
  readonly tentativeCells: number;
  readonly tentativeLogicalBytes: number;
}

export interface Heap {
  beginAttempt(key: ExecutionKey): HeapAttempt;
  read<TPayload, TBuilder = unknown>(
    ref: StorageRef<unknown>,
    descriptor?: StorageDescriptor<TPayload, TBuilder>,
  ): Readonly<TPayload>;
  collect(
    roots: Iterable<StorageRef<unknown>>,
    retainedRoots?: Iterable<StorageRef<unknown>>,
  ): void;
  dispose(): void;
  stats(): HeapStats;
}

export interface HeapAttempt {
  allocateSealed<TPayload, TBuilder>(
    descriptor: StorageDescriptor<TPayload, TBuilder>,
    builder: TBuilder,
  ): StorageRef<TPayload>;
  preparePublication(
    candidateRoots: Iterable<StorageRef<unknown>>,
  ): PreparedHeapPublication;
  abort(): void;
}

export interface PreparedHeapPublication {
  publish(): void;
}

type CellState = 'tentative' | 'published';
type AttemptState = 'active' | 'prepared' | 'published' | 'aborted';

interface RefRecord {
  readonly arena: HeapArena;
  readonly slot: number;
  readonly incarnation: number;
  readonly descriptor: DescriptorId;
}

interface Cell {
  readonly incarnation: number;
  readonly descriptor: StorageDescriptor<unknown, unknown>;
  readonly payload: unknown;
  readonly logicalBytes: number;
  state: CellState;
  attemptId: number | null;
}

const REFS = new WeakMap<object, RefRecord>();

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fatal(`invalid Heap limit ${name}=${value}`);
  }
  return value;
}

function immutable(
  payload: unknown,
  name: string,
  seen = new WeakSet<object>(),
): void {
  if (payload === null || typeof payload !== 'object') {
    return;
  }
  if (seen.has(payload)) {
    return;
  }
  seen.add(payload);
  if (!Object.isFrozen(payload)) {
    fatal(`storage descriptor '${name}' returned an unsealed payload`);
  }
  for (const value of Object.values(payload)) {
    immutable(value, name, seen);
  }
}

export class HeapArena implements Heap {
  private readonly limits: HeapLimits;
  private readonly cells: (Cell | null)[] = [];
  private readonly incarnations: number[] = [];
  private readonly free: number[] = [];
  private attempt: AttemptImpl | null = null;
  private nextAttemptId = 1;
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

  beginAttempt(key: ExecutionKey): HeapAttempt {
    this.assertLive();
    if (this.attempt !== null && !this.attempt.terminal) {
      return fatal(
        `cannot begin Heap attempt '${String(key)}' while '${String(this.attempt.key)}' is ${this.attempt.state}`,
      );
    }
    const attempt = new AttemptImpl(this, this.nextAttemptId, key);
    this.nextAttemptId += 1;
    this.attempt = attempt;
    return attempt;
  }

  read<TPayload, TBuilder = unknown>(
    ref: StorageRef<unknown>,
    descriptor?: StorageDescriptor<TPayload, TBuilder>,
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
      const attempt = this.attempt;
      if (
        attempt === null ||
        attempt.terminal ||
        cell.attemptId !== attempt.id
      ) {
        return fatal(
          'tentative StorageRef is not owned by the current attempt',
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
    if (this.attempt !== null && !this.attempt.terminal) {
      return fatal(
        `cannot collect while Heap attempt is ${this.attempt.state}`,
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
      if (cell?.state === 'published' && !reachable.has(slot)) {
        this.release(slot);
      }
    }
    this.updateRetained(retained);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    if (this.attempt !== null && !this.attempt.terminal) {
      this.attempt.abort();
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
    let publishedCells = 0;
    let tentativeCells = 0;
    let tentativeLogicalBytes = 0;
    for (const cell of this.cells) {
      if (cell?.state === 'published') {
        publishedCells += 1;
      } else if (cell?.state === 'tentative') {
        tentativeCells += 1;
        tentativeLogicalBytes += cell.logicalBytes;
      }
    }
    return {
      publishedCells,
      retainedCells: this.retainedCells,
      retainedLogicalBytes: this.retainedLogicalBytes,
      tentativeCells,
      tentativeLogicalBytes,
    };
  }

  allocate<TPayload, TBuilder>(
    attempt: AttemptImpl,
    descriptor: StorageDescriptor<TPayload, TBuilder>,
    builder: TBuilder,
  ): StorageRef<TPayload> {
    this.assertCurrent(attempt, 'active');
    const estimatedBytes = descriptor.builderLogicalBytes(builder);
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) {
      return fatal(
        `storage descriptor '${descriptor.debugName}' returned invalid builder logical bytes ${estimatedBytes}`,
      );
    }
    if (
      attempt.tentative.size + 1 > this.limits.maxTransientStorageCells ||
      attempt.transientBytes + estimatedBytes >
        this.limits.maxTransientLogicalBytes
    ) {
      throw new ExecutionError(
        'HEAP_LIMIT_EXCEEDED',
        'transient Heap allocation limit exceeded',
      );
    }
    const payload = descriptor.seal(builder);
    immutable(payload, descriptor.debugName);
    const bytes = descriptor.logicalBytes(payload);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return fatal(
        `storage descriptor '${descriptor.debugName}' returned invalid logical bytes ${bytes}`,
      );
    }
    if (bytes !== estimatedBytes) {
      return fatal(
        `storage descriptor '${descriptor.debugName}' builder estimate ${estimatedBytes} disagrees with sealed logical bytes ${bytes}`,
      );
    }

    const slot = this.free.pop() ?? this.cells.length;
    const incarnation = (this.incarnations[slot] ?? 0) + 1;
    this.incarnations[slot] = incarnation;
    const erased = descriptor as unknown as StorageDescriptor<unknown, unknown>;
    this.cells[slot] = {
      incarnation,
      descriptor: erased,
      payload,
      logicalBytes: bytes,
      state: 'tentative',
      attemptId: attempt.id,
    };
    const ref = Object.freeze({}) as StorageRef<TPayload>;
    REFS.set(ref as object, {
      arena: this,
      slot,
      incarnation,
      descriptor: descriptor.id,
    });
    attempt.tentative.add(slot);
    attempt.transientBytes += bytes;

    try {
      descriptor.trace(payload, {
        storage: child => this.assertPayloadRef(attempt, child),
      });
    } catch (error) {
      attempt.tentative.delete(slot);
      attempt.transientBytes -= bytes;
      this.release(slot);
      throw error;
    }
    return ref;
  }

  prepare(
    attempt: AttemptImpl,
    candidateRoots: Iterable<StorageRef<unknown>>,
  ): PreparedHeapPublication {
    this.assertCurrent(attempt, 'active');
    const roots = [...candidateRoots];
    const reachable = this.traceClosure(roots, attempt, true);
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
    const promote = [...attempt.tentative].filter(slot => reachable.has(slot));
    const discard = [...attempt.tentative].filter(slot => !reachable.has(slot));
    attempt.state = 'prepared';
    return new PreparedPublication(
      this,
      attempt,
      reachable,
      bytes,
      promote,
      discard,
    );
  }

  publish(
    publication: PreparedPublication,
    attempt: AttemptImpl,
    reachable: ReadonlySet<number>,
    bytes: number,
    promote: readonly number[],
    discard: readonly number[],
  ): void {
    this.assertCurrent(attempt, 'prepared');
    if (publication.consumed) {
      return fatal('Heap publication was already consumed');
    }
    publication.consumed = true;
    for (const slot of promote) {
      const cell = this.cells[slot];
      if (cell === null || cell === undefined) {
        return fatal(`prepared Heap slot ${slot} disappeared before publish`);
      }
      cell.state = 'published';
      cell.attemptId = null;
    }
    for (const slot of discard) {
      this.release(slot);
    }
    attempt.tentative.clear();
    attempt.transientBytes = 0;
    attempt.state = 'published';
    this.updateRetained(reachable, bytes);
  }

  abort(attempt: AttemptImpl): void {
    if (attempt.terminal) {
      return fatal(`cannot abort Heap attempt after ${attempt.state}`);
    }
    if (this.attempt !== attempt) {
      return fatal('cannot abort a Heap attempt owned by another arena state');
    }
    for (const slot of attempt.tentative) {
      this.release(slot);
    }
    attempt.tentative.clear();
    attempt.transientBytes = 0;
    attempt.state = 'aborted';
  }

  private assertPayloadRef(
    attempt: AttemptImpl,
    ref: StorageRef<unknown>,
  ): void {
    const record = this.refRecord(ref);
    const cell = this.cell(record);
    if (cell.state === 'published') {
      return;
    }
    if (cell.attemptId !== attempt.id) {
      fatal('sealed storage points to tentative storage from another attempt');
    }
  }

  private traceClosure(
    roots: Iterable<StorageRef<unknown>>,
    attempt: AttemptImpl | null,
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
          attempt === null ||
          cell.attemptId !== attempt.id
        ) {
          fatal(
            'publication root reaches tentative storage outside its attempt',
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
    if (cell.incarnation !== record.incarnation) {
      return fatal('stale StorageRef incarnation');
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
    attempt: AttemptImpl,
    state: 'active' | 'prepared',
  ): void {
    this.assertLive();
    if (this.attempt !== attempt) {
      return fatal('Heap attempt is not current');
    }
    if (attempt.state !== state) {
      return fatal(
        `Heap attempt '${String(attempt.key)}' is ${attempt.state}, expected ${state}`,
      );
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      fatal('Heap arena is disposed');
    }
  }
}

class AttemptImpl implements HeapAttempt {
  state: AttemptState = 'active';
  readonly tentative = new Set<number>();
  transientBytes = 0;

  constructor(
    private readonly arena: HeapArena,
    readonly id: number,
    readonly key: ExecutionKey,
  ) {}

  get terminal(): boolean {
    return this.state === 'published' || this.state === 'aborted';
  }

  allocateSealed<TPayload, TBuilder>(
    descriptor: StorageDescriptor<TPayload, TBuilder>,
    builder: TBuilder,
  ): StorageRef<TPayload> {
    return this.arena.allocate(this, descriptor, builder);
  }

  preparePublication(
    candidateRoots: Iterable<StorageRef<unknown>>,
  ): PreparedHeapPublication {
    return this.arena.prepare(this, candidateRoots);
  }

  abort(): void {
    this.arena.abort(this);
  }
}

class PreparedPublication implements PreparedHeapPublication {
  consumed = false;

  constructor(
    private readonly arena: HeapArena,
    private readonly attempt: AttemptImpl,
    private readonly reachable: ReadonlySet<number>,
    private readonly bytes: number,
    private readonly promote: readonly number[],
    private readonly discard: readonly number[],
  ) {}

  publish(): void {
    this.arena.publish(
      this,
      this.attempt,
      this.reachable,
      this.bytes,
      this.promote,
      this.discard,
    );
  }
}
