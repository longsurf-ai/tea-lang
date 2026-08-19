// Purpose: Heap arena state-machine, immutable sealing, reachability, accounting, limit, and stale-reference regression tests.

import {describe, expect, test} from 'bun:test';
import {ExecutionError} from './abi';
import {HeapArena, type StorageDescriptor, type StorageRef} from './heap';

interface NodePayload {
  readonly value: number;
  readonly children: readonly StorageRef[];
}

interface NodeArgs {
  readonly value: number;
  readonly children?: readonly StorageRef[];
}

const NODE: StorageDescriptor<NodePayload, NodeArgs> = {
  id: Symbol('node'),
  debugName: 'test node',
  logicalBytesFor(args) {
    return 8 + (args.children?.length ?? 0) * 8;
  },
  seal(args) {
    return Object.freeze({
      value: args.value,
      children: Object.freeze([...(args.children ?? [])]),
    });
  },
  trace(payload, tracer) {
    payload.children.forEach(child => tracer.storage(child));
  },
  logicalBytes(payload) {
    return 8 + payload.children.length * 8;
  },
};

const OTHER: StorageDescriptor<NodePayload, NodeArgs> = {
  ...NODE,
  id: Symbol('other'),
  debugName: 'other node',
};

describe('Heap arena', () => {
  test('prepare is non-committing; commit promotes only reachable cells', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const kept = transaction.allocateSealed(NODE, {value: 1});
    const dropped = transaction.allocateSealed(NODE, {value: 2});

    expect(heap.read(kept, NODE).value).toBe(1);
    const commit = transaction.prepareCommit([kept]);
    expect(heap.stats()).toMatchObject({
      committedCells: 0,
      tentativeCells: 2,
      retainedCells: 0,
    });

    commit.commit();
    expect(heap.stats()).toEqual({
      committedCells: 1,
      retainedCells: 1,
      retainedLogicalBytes: 8,
      tentativeCells: 0,
      tentativeLogicalBytes: 0,
    });
    expect(heap.read(kept, NODE).value).toBe(1);
    expect(() => heap.read(dropped, NODE)).toThrow('stale StorageRef');
  });

  test('a prepared transaction can abort when a peer prepare fails', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const ref = transaction.allocateSealed(NODE, {value: 1});
    const commit = transaction.prepareCommit([ref]);

    const preparePeer = () => {
      throw new Error('peer prepare failed');
    };
    expect(() => {
      try {
        preparePeer();
      } catch (error) {
        transaction.abort();
        throw error;
      }
    }).toThrow('peer prepare failed');

    expect(() => commit.commit()).toThrow('is aborted, expected prepared');
    expect(() => heap.read(ref, NODE)).toThrow('stale StorageRef');
    expect(() => transaction.abort()).toThrow('cannot abort Heap transaction');
  });

  test('transaction states reject overlapping, late allocation, and double commit', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('one');
    expect(() => heap.beginTransaction('two')).toThrow(
      'cannot begin Heap transaction',
    );
    const ref = transaction.allocateSealed(NODE, {value: 1});
    const commit = transaction.prepareCommit([ref]);
    expect(() => transaction.allocateSealed(NODE, {value: 2})).toThrow(
      'expected active',
    );
    expect(() => heap.beginTransaction('two')).toThrow(
      'cannot begin Heap transaction',
    );
    commit.commit();
    expect(() => commit.commit()).toThrow('is committed, expected prepared');
    expect(() => transaction.abort()).toThrow('cannot abort Heap transaction');
    expect(heap.beginTransaction('two')).toBeDefined();
  });

  test('cross-arena, wrong-descriptor, stale, and reused refs fail loudly', () => {
    const heap = new HeapArena();
    const other = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const ref = transaction.allocateSealed(NODE, {value: 1});
    transaction.prepareCommit([ref]).commit();

    expect(() => other.read(ref, NODE)).toThrow('another Heap arena');
    expect(() => heap.read(ref, OTHER)).toThrow('descriptor mismatch');
    heap.collect([]);
    expect(() => heap.read(ref, NODE)).toThrow('stale StorageRef');

    const reuse = heap.beginTransaction('reuse');
    const replacement = reuse.allocateSealed(NODE, {value: 2});
    reuse.prepareCommit([replacement]).commit();
    expect(heap.read(replacement, NODE).value).toBe(2);
    expect(() => heap.read(ref, NODE)).toThrow('StorageRef');
  });

  test('shared children count once and safety roots do not alter retention', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const child = transaction.allocateSealed(NODE, {value: 1});
    const left = transaction.allocateSealed(NODE, {
      value: 2,
      children: [child],
    });
    const right = transaction.allocateSealed(NODE, {
      value: 3,
      children: [child],
    });
    transaction.prepareCommit([left, right]).commit();

    expect(heap.stats()).toMatchObject({
      retainedCells: 3,
      retainedLogicalBytes: 40,
    });
    // `child` is a physical safety root, but only `left` is retained.
    heap.collect([left, child], [left]);
    expect(heap.stats()).toMatchObject({
      committedCells: 2,
      retainedCells: 2,
      retainedLogicalBytes: 24,
    });
    expect(() => heap.read(right, NODE)).toThrow('stale StorageRef');
  });

  test('one-shot root iterables retain and account the same closure', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const ref = transaction.allocateSealed(NODE, {value: 1});
    transaction.prepareCommit([ref]).commit();

    heap.collect(
      (function* roots() {
        yield ref;
      })(),
    );
    expect(heap.stats()).toMatchObject({
      committedCells: 1,
      retainedCells: 1,
      retainedLogicalBytes: 8,
    });
  });

  test('transient and retained limits fail before commit', () => {
    const transient = new HeapArena({
      maxTransientStorageCells: 1,
      maxTransientLogicalBytes: 100,
    });
    const first = transient.beginTransaction('row');
    first.allocateSealed(NODE, {value: 1});
    expect(() => first.allocateSealed(NODE, {value: 2})).toThrow(
      ExecutionError,
    );
    expect(transient.stats().tentativeCells).toBe(1);
    first.abort();

    const retained = new HeapArena({
      maxStorageCells: 1,
      maxLogicalBytes: 100,
    });
    const second = retained.beginTransaction('row');
    const a = second.allocateSealed(NODE, {value: 1});
    const b = second.allocateSealed(NODE, {value: 2});
    expect(() => second.prepareCommit([a, b])).toThrow(ExecutionError);
    expect(retained.stats()).toMatchObject({
      committedCells: 0,
      tentativeCells: 2,
    });
    second.abort();
  });

  test('transient byte limits reject args before descriptor sealing', () => {
    let seals = 0;
    const counted: StorageDescriptor<NodePayload, NodeArgs> = {
      ...NODE,
      id: Symbol('counted'),
      logicalBytesFor: () => 16,
      seal(args) {
        seals += 1;
        return NODE.seal(args);
      },
      logicalBytes: () => 16,
    };
    const heap = new HeapArena({maxTransientLogicalBytes: 15});
    const transaction = heap.beginTransaction('row');
    expect(() => transaction.allocateSealed(counted, {value: 1})).toThrow(
      ExecutionError,
    );
    expect(seals).toBe(0);
    expect(heap.stats().tentativeCells).toBe(0);
    transaction.abort();
  });

  test('descriptors cannot commit mutable aliases', () => {
    const unsealed: StorageDescriptor<{items: number[]}, number[]> = {
      id: Symbol('unsealed'),
      debugName: 'unsealed',
      logicalBytesFor: args => args.length * 8,
      seal: args => Object.freeze({items: args}),
      trace() {},
      logicalBytes: payload => payload.items.length * 8,
    };
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    expect(() => transaction.allocateSealed(unsealed, [1])).toThrow(
      "descriptor 'unsealed' returned an unsealed payload",
    );
    expect(heap.stats().tentativeCells).toBe(0);
    transaction.abort();
  });

  test('dispose aborts a transaction and invalidates all refs', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const ref = transaction.allocateSealed(NODE, {value: 1});
    heap.dispose();
    heap.dispose();
    expect(() => heap.read(ref, NODE)).toThrow('disposed');
    expect(() => heap.beginTransaction('later')).toThrow('disposed');
  });
});
