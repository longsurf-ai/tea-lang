// Purpose: Heap arena state-machine, descriptor-owned storage policy, mutation journaling, reachability, accounting, limit, and stale-reference regression tests.

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
  create(args) {
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

interface BoxPayload {
  value: number;
  child: StorageRef | null;
}

interface BoxEdit {
  readonly field: 'value' | 'child';
  readonly value: number | StorageRef | null;
}

const BOX: StorageDescriptor<
  BoxPayload,
  BoxPayload,
  BoxEdit,
  number | StorageRef | null
> = {
  id: Symbol('box'),
  debugName: 'mutable box',
  logicalBytesFor: () => 16,
  create(args) {
    return {...args};
  },
  trace(payload, tracer) {
    if (payload.child !== null) tracer.storage(payload.child);
  },
  logicalBytes: () => 16,
  mutation: {
    prepare(payload, edit) {
      if (
        (edit.field === 'value' && typeof edit.value !== 'number') ||
        (edit.field === 'child' &&
          edit.value !== null &&
          typeof edit.value !== 'object')
      ) {
        throw new ExecutionError('VALUE_LAYOUT_MISMATCH', 'invalid box edit');
      }
      return {key: edit.field, undo: payload[edit.field]};
    },
    traceEdit(edit, tracer) {
      if (edit.field === 'child' && edit.value !== null) {
        tracer.storage(edit.value as StorageRef);
      }
    },
    apply(payload, edit) {
      if (edit.field === 'value') payload.value = edit.value as number;
      else payload.child = edit.value as StorageRef | null;
    },
    restore(payload, key, undo) {
      if (key === 'value') payload.value = undo as number;
      else payload.child = undo as StorageRef | null;
    },
  },
};

describe('Heap arena', () => {
  test('prepare is non-committing; commit promotes only reachable cells', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const kept = transaction.allocate(NODE, {value: 1});
    const dropped = transaction.allocate(NODE, {value: 2});

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
    const ref = transaction.allocate(NODE, {value: 1});
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
    const ref = transaction.allocate(NODE, {value: 1});
    const commit = transaction.prepareCommit([ref]);
    expect(() => transaction.allocate(NODE, {value: 2})).toThrow(
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
    const ref = transaction.allocate(NODE, {value: 1});
    transaction.prepareCommit([ref]).commit();

    expect(() => other.read(ref, NODE)).toThrow('another Heap arena');
    expect(() => heap.read(ref, OTHER)).toThrow('descriptor mismatch');
    heap.collect([]);
    expect(() => heap.read(ref, NODE)).toThrow('stale StorageRef');

    const reuse = heap.beginTransaction('reuse');
    const replacement = reuse.allocate(NODE, {value: 2});
    reuse.prepareCommit([replacement]).commit();
    expect(heap.read(replacement, NODE).value).toBe(2);
    expect(() => heap.read(ref, NODE)).toThrow('StorageRef');
  });

  test('shared children count once and safety roots do not alter retention', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const child = transaction.allocate(NODE, {value: 1});
    const left = transaction.allocate(NODE, {
      value: 2,
      children: [child],
    });
    const right = transaction.allocate(NODE, {
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
    const ref = transaction.allocate(NODE, {value: 1});
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
    first.allocate(NODE, {value: 1});
    expect(() => first.allocate(NODE, {value: 2})).toThrow(ExecutionError);
    expect(transient.stats().tentativeCells).toBe(1);
    first.abort();

    const retained = new HeapArena({
      maxStorageCells: 1,
      maxLogicalBytes: 100,
    });
    const second = retained.beginTransaction('row');
    const a = second.allocate(NODE, {value: 1});
    const b = second.allocate(NODE, {value: 2});
    expect(() => second.prepareCommit([a, b])).toThrow(ExecutionError);
    expect(retained.stats()).toMatchObject({
      committedCells: 0,
      tentativeCells: 2,
    });
    second.abort();
  });

  test('transient byte limits reject args before descriptor creation', () => {
    let creates = 0;
    const counted: StorageDescriptor<NodePayload, NodeArgs> = {
      ...NODE,
      id: Symbol('counted'),
      logicalBytesFor: () => 16,
      create(args) {
        creates += 1;
        return NODE.create(args);
      },
      logicalBytes: () => 16,
    };
    const heap = new HeapArena({maxTransientLogicalBytes: 15});
    const transaction = heap.beginTransaction('row');
    expect(() => transaction.allocate(counted, {value: 1})).toThrow(
      ExecutionError,
    );
    expect(creates).toBe(0);
    expect(heap.stats().tentativeCells).toBe(0);
    transaction.abort();
  });

  test('a descriptor may own mutable storage and abort restores its first-write journal', () => {
    const heap = new HeapArena();
    const allocate = heap.beginTransaction('allocate');
    const box = allocate.allocate(BOX, {value: 1, child: null});
    allocate.prepareCommit([box]).commit();

    const transaction = heap.beginTransaction('row');
    transaction.mutate(box, BOX, {field: 'value', value: 2});
    transaction.mutate(box, BOX, {field: 'value', value: 3});
    expect(heap.read(box, BOX).value).toBe(3);
    transaction.prepareCommit([box]);
    transaction.abort();
    expect(heap.read(box, BOX).value).toBe(1);

    const committed = heap.beginTransaction('commit');
    committed.mutate(box, BOX, {field: 'value', value: 4});
    committed.prepareCommit([box]).commit();
    expect(heap.read(box, BOX).value).toBe(4);
  });

  test('mutation validates introduced refs before apply and traces them at commit', () => {
    const heap = new HeapArena();
    const allocate = heap.beginTransaction('allocate');
    const box = allocate.allocate(BOX, {value: 1, child: null});
    allocate.prepareCommit([box]).commit();

    const transaction = heap.beginTransaction('row');
    const child = transaction.allocate(NODE, {value: 2});
    transaction.mutate(box, BOX, {field: 'child', value: child});
    transaction.prepareCommit([box]).commit();
    expect(heap.read(box, BOX).child).toBe(child);
    expect(heap.read(child, NODE).value).toBe(2);
  });

  test('dispose aborts a transaction and invalidates all refs', () => {
    const heap = new HeapArena();
    const transaction = heap.beginTransaction('row');
    const ref = transaction.allocate(NODE, {value: 1});
    heap.dispose();
    heap.dispose();
    expect(() => heap.read(ref, NODE)).toThrow('disposed');
    expect(() => heap.beginTransaction('later')).toThrow('disposed');
  });
});
