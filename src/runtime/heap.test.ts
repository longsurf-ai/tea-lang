// Purpose: Heap arena state-machine, immutable sealing, reachability, accounting, limit, and stale-reference regression tests.

import {describe, expect, test} from 'bun:test';
import {ExecutionError} from './abi';
import {HeapArena, type StorageDescriptor, type StorageRef} from './heap';

interface NodePayload {
  readonly value: number;
  readonly children: readonly StorageRef[];
}

interface NodeBuilder {
  readonly value: number;
  readonly children?: readonly StorageRef[];
}

const NODE: StorageDescriptor<NodePayload, NodeBuilder> = {
  id: Symbol('node'),
  debugName: 'test node',
  builderLogicalBytes(builder) {
    return 8 + (builder.children?.length ?? 0) * 8;
  },
  seal(builder) {
    return Object.freeze({
      value: builder.value,
      children: Object.freeze([...(builder.children ?? [])]),
    });
  },
  trace(payload, tracer) {
    payload.children.forEach(child => tracer.storage(child));
  },
  logicalBytes(payload) {
    return 8 + payload.children.length * 8;
  },
};

const OTHER: StorageDescriptor<NodePayload, NodeBuilder> = {
  ...NODE,
  id: Symbol('other'),
  debugName: 'other node',
};

describe('Heap arena', () => {
  test('prepare is non-publishing; publish promotes only reachable cells', () => {
    const heap = new HeapArena();
    const attempt = heap.beginAttempt('row');
    const kept = attempt.allocateSealed(NODE, {value: 1});
    const dropped = attempt.allocateSealed(NODE, {value: 2});

    expect(heap.read(kept, NODE).value).toBe(1);
    const publication = attempt.preparePublication([kept]);
    expect(heap.stats()).toMatchObject({
      publishedCells: 0,
      tentativeCells: 2,
      retainedCells: 0,
    });

    publication.publish();
    expect(heap.stats()).toEqual({
      publishedCells: 1,
      retainedCells: 1,
      retainedLogicalBytes: 8,
      tentativeCells: 0,
      tentativeLogicalBytes: 0,
    });
    expect(heap.read(kept, NODE).value).toBe(1);
    expect(() => heap.read(dropped, NODE)).toThrow('stale StorageRef');
  });

  test('a prepared attempt can abort when a peer prepare fails', () => {
    const heap = new HeapArena();
    const attempt = heap.beginAttempt('row');
    const ref = attempt.allocateSealed(NODE, {value: 1});
    const publication = attempt.preparePublication([ref]);

    const preparePeer = () => {
      throw new Error('peer prepare failed');
    };
    expect(() => {
      try {
        preparePeer();
      } catch (error) {
        attempt.abort();
        throw error;
      }
    }).toThrow('peer prepare failed');

    expect(() => publication.publish()).toThrow(
      'is aborted, expected prepared',
    );
    expect(() => heap.read(ref, NODE)).toThrow('stale StorageRef');
    expect(() => attempt.abort()).toThrow('cannot abort Heap attempt');
  });

  test('attempt states reject overlapping, late allocation, and double publish', () => {
    const heap = new HeapArena();
    const attempt = heap.beginAttempt('one');
    expect(() => heap.beginAttempt('two')).toThrow('cannot begin Heap attempt');
    const ref = attempt.allocateSealed(NODE, {value: 1});
    const publication = attempt.preparePublication([ref]);
    expect(() => attempt.allocateSealed(NODE, {value: 2})).toThrow(
      'expected active',
    );
    expect(() => heap.beginAttempt('two')).toThrow('cannot begin Heap attempt');
    publication.publish();
    expect(() => publication.publish()).toThrow(
      'is published, expected prepared',
    );
    expect(() => attempt.abort()).toThrow('cannot abort Heap attempt');
    expect(heap.beginAttempt('two')).toBeDefined();
  });

  test('cross-arena, wrong-descriptor, stale, and reused refs fail loudly', () => {
    const heap = new HeapArena();
    const other = new HeapArena();
    const attempt = heap.beginAttempt('row');
    const ref = attempt.allocateSealed(NODE, {value: 1});
    attempt.preparePublication([ref]).publish();

    expect(() => other.read(ref, NODE)).toThrow('another Heap arena');
    expect(() => heap.read(ref, OTHER)).toThrow('descriptor mismatch');
    heap.collect([]);
    expect(() => heap.read(ref, NODE)).toThrow('stale StorageRef');

    const reuse = heap.beginAttempt('reuse');
    const replacement = reuse.allocateSealed(NODE, {value: 2});
    reuse.preparePublication([replacement]).publish();
    expect(heap.read(replacement, NODE).value).toBe(2);
    expect(() => heap.read(ref, NODE)).toThrow('StorageRef');
  });

  test('shared children count once and safety roots do not alter retention', () => {
    const heap = new HeapArena();
    const attempt = heap.beginAttempt('row');
    const child = attempt.allocateSealed(NODE, {value: 1});
    const left = attempt.allocateSealed(NODE, {value: 2, children: [child]});
    const right = attempt.allocateSealed(NODE, {value: 3, children: [child]});
    attempt.preparePublication([left, right]).publish();

    expect(heap.stats()).toMatchObject({
      retainedCells: 3,
      retainedLogicalBytes: 40,
    });
    // `child` is a physical safety root, but only `left` is retained.
    heap.collect([left, child], [left]);
    expect(heap.stats()).toMatchObject({
      publishedCells: 2,
      retainedCells: 2,
      retainedLogicalBytes: 24,
    });
    expect(() => heap.read(right, NODE)).toThrow('stale StorageRef');
  });

  test('one-shot root iterables retain and account the same closure', () => {
    const heap = new HeapArena();
    const attempt = heap.beginAttempt('row');
    const ref = attempt.allocateSealed(NODE, {value: 1});
    attempt.preparePublication([ref]).publish();

    heap.collect(
      (function* roots() {
        yield ref;
      })(),
    );
    expect(heap.stats()).toMatchObject({
      publishedCells: 1,
      retainedCells: 1,
      retainedLogicalBytes: 8,
    });
  });

  test('transient and retained limits fail before publication', () => {
    const transient = new HeapArena({
      maxTransientStorageCells: 1,
      maxTransientLogicalBytes: 100,
    });
    const first = transient.beginAttempt('row');
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
    const second = retained.beginAttempt('row');
    const a = second.allocateSealed(NODE, {value: 1});
    const b = second.allocateSealed(NODE, {value: 2});
    expect(() => second.preparePublication([a, b])).toThrow(ExecutionError);
    expect(retained.stats()).toMatchObject({
      publishedCells: 0,
      tentativeCells: 2,
    });
    second.abort();
  });

  test('transient byte limits reject a builder before descriptor sealing', () => {
    let seals = 0;
    const counted: StorageDescriptor<NodePayload, NodeBuilder> = {
      ...NODE,
      id: Symbol('counted'),
      builderLogicalBytes: () => 16,
      seal(builder) {
        seals += 1;
        return NODE.seal(builder);
      },
      logicalBytes: () => 16,
    };
    const heap = new HeapArena({maxTransientLogicalBytes: 15});
    const attempt = heap.beginAttempt('row');
    expect(() => attempt.allocateSealed(counted, {value: 1})).toThrow(
      ExecutionError,
    );
    expect(seals).toBe(0);
    expect(heap.stats().tentativeCells).toBe(0);
    attempt.abort();
  });

  test('descriptors cannot publish mutable aliases', () => {
    const unsealed: StorageDescriptor<{items: number[]}, number[]> = {
      id: Symbol('unsealed'),
      debugName: 'unsealed',
      builderLogicalBytes: builder => builder.length * 8,
      seal: builder => Object.freeze({items: builder}),
      trace() {},
      logicalBytes: payload => payload.items.length * 8,
    };
    const heap = new HeapArena();
    const attempt = heap.beginAttempt('row');
    expect(() => attempt.allocateSealed(unsealed, [1])).toThrow(
      "descriptor 'unsealed' returned an unsealed payload",
    );
    expect(heap.stats().tentativeCells).toBe(0);
    attempt.abort();
  });

  test('dispose aborts an attempt and invalidates all refs', () => {
    const heap = new HeapArena();
    const attempt = heap.beginAttempt('row');
    const ref = attempt.allocateSealed(NODE, {value: 1});
    heap.dispose();
    heap.dispose();
    expect(() => heap.read(ref, NODE)).toThrow('disposed');
    expect(() => heap.beginAttempt('later')).toThrow('disposed');
  });
});
