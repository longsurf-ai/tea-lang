// Purpose: Typed transaction, root snapshot, Mark-Sweep, accounting, limit, and stale-reference regression tests for Heap.

import {describe, expect, expectTypeOf, test} from 'vitest';
import {ExecutionError} from './errors';
import {
  ArenaHeap,
  isRef,
  type AnyRef,
  type HeapTransaction,
  type Ref,
  type TypeInfo,
} from './heap';

interface NodeValue {
  readonly value: number;
  readonly children: readonly AnyRef[];
}

interface NodeArgs {
  readonly value: number;
  readonly children?: readonly AnyRef[];
}

const NODE: TypeInfo<NodeArgs, NodeValue> = {
  id: Symbol('node'),
  name: 'test node',
  bytesFor(args) {
    return 8 + (args.children?.length ?? 0) * 8;
  },
  create(args) {
    return Object.freeze({
      value: args.value,
      children: Object.freeze([...(args.children ?? [])]),
    });
  },
  bytesOf(value) {
    return 8 + value.children.length * 8;
  },
  trace(value, visit) {
    value.children.forEach(visit);
  },
};

interface BoxValue {
  readonly value: number;
  readonly child: Ref<NodeValue> | null;
}

const BOX: TypeInfo<BoxValue, BoxValue> = {
  id: Symbol('box'),
  name: 'test box',
  bytesFor: () => 16,
  create: value => Object.freeze({...value}),
  bytesOf: () => 16,
  trace(value, visit) {
    if (value.child !== null) visit(value.child);
  },
};

function commit(
  heap: ArenaHeap,
  transaction: HeapTransaction,
  roots: Iterable<AnyRef>,
): void {
  transaction.commit();
  heap.replaceRoots(roots);
  heap.collect();
}

describe('Heap arena', () => {
  test('transaction reads tentative values and Mark-Sweep keeps only rooted closure', () => {
    const heap = new ArenaHeap();
    const transaction = heap.begin('row');
    const child = transaction.allocate(NODE, {value: 2});
    const kept = transaction.allocate(NODE, {value: 1, children: [child]});
    const dropped = transaction.allocate(NODE, {value: 3});

    expectTypeOf(kept).toEqualTypeOf<Ref<NodeValue>>();
    expect(isRef(kept)).toBe(true);
    expect(transaction.read(kept).value).toBe(1);
    expect(() => heap.read(kept)).toThrow('tentative Ref');

    transaction.commit();
    expect(heap.read(dropped).value).toBe(3);
    expect(() => heap.collect()).toThrow('refreshing Heap roots');
    heap.replaceRoots([kept]);
    heap.collect();

    expect(heap.stats()).toEqual({
      committedCells: 2,
      retainedCells: 2,
      retainedLogicalBytes: 24,
      tentativeCells: 0,
      tentativeLogicalBytes: 0,
    });
    expect(heap.read(child).value).toBe(2);
    expect(() => heap.read(dropped)).toThrow('stale Ref');
  });

  test('whole-payload writes are isolated until commit and disappear on abort', () => {
    const heap = new ArenaHeap();
    const allocation = heap.begin('allocate');
    const box = allocation.allocate(BOX, {value: 1, child: null});
    commit(heap, allocation, [box]);

    const failed = heap.begin('failed write');
    failed.write(box, {value: 2, child: null});
    failed.write(box, {value: 3, child: null});
    expect(failed.read(box).value).toBe(3);
    expect(heap.read(box).value).toBe(1);
    failed.abort();
    expect(heap.read(box).value).toBe(1);

    const successful = heap.begin('successful write');
    successful.write(box, {value: 4, child: null});
    expect(heap.read(box).value).toBe(1);
    successful.commit();
    expect(heap.read(box).value).toBe(4);
    heap.replaceRoots([box]);
    heap.collect();
  });

  test('writes validate introduced refs and Mark-Sweep handles sharing and cycles', () => {
    const heap = new ArenaHeap();
    const transaction = heap.begin('cycle');
    const a = transaction.allocate(BOX, {value: 1, child: null});
    const b = transaction.allocate(BOX, {value: 2, child: null});
    transaction.write(a, {value: 1, child: b as unknown as Ref<NodeValue>});
    transaction.write(b, {value: 2, child: a as unknown as Ref<NodeValue>});
    commit(heap, transaction, [a, b, a]);

    expect(heap.stats().retainedCells).toBe(2);
    heap.replaceRoots([]);
    heap.collect();
    expect(() => heap.read(a)).toThrow('stale Ref');
    expect(() => heap.read(b)).toThrow('stale Ref');
  });

  test('cross-arena refs fail before allocation or write becomes visible', () => {
    const left = new ArenaHeap();
    const right = new ArenaHeap();
    const rightTx = right.begin('right');
    const foreign = rightTx.allocate(NODE, {value: 9});
    commit(right, rightTx, [foreign]);

    const leftTx = left.begin('left');
    expect(() => leftTx.allocate(BOX, {value: 1, child: foreign})).toThrow(
      'another Heap arena',
    );
    expect(left.stats().tentativeCells).toBe(0);
    leftTx.abort();
  });

  test('transaction states reject overlap, late use, and double completion', () => {
    const heap = new ArenaHeap();
    const transaction = heap.begin('one');
    expect(() => heap.begin('two')).toThrow('cannot begin Heap transaction');
    const ref = transaction.allocate(NODE, {value: 1});
    transaction.commit();
    expect(() => transaction.allocate(NODE, {value: 2})).toThrow(
      'expected active',
    );
    expect(() => transaction.commit()).toThrow('expected active');
    expect(() => transaction.abort()).toThrow('cannot abort Heap transaction');
    heap.replaceRoots([ref]);
    heap.collect();
    expect(heap.begin('two')).toBeDefined();
  });

  test('slot reuse never revives a stale Ref', () => {
    const heap = new ArenaHeap();
    const first = heap.begin('first');
    const stale = first.allocate(NODE, {value: 1});
    commit(heap, first, []);
    expect(() => heap.read(stale)).toThrow('stale Ref');

    const second = heap.begin('second');
    const current = second.allocate(NODE, {value: 2});
    commit(heap, second, [current]);
    expect(heap.read(current).value).toBe(2);
    expect(() => heap.read(stale)).toThrow('stale Ref');
  });

  test('transient limits reject arguments before payload creation', () => {
    let creates = 0;
    const counted: TypeInfo<NodeArgs, NodeValue> = {
      ...NODE,
      id: Symbol('counted'),
      bytesFor: () => 16,
      create(args) {
        creates += 1;
        return NODE.create(args);
      },
      bytesOf: () => 16,
    };
    const heap = new ArenaHeap({maxTransientLogicalBytes: 15});
    const transaction = heap.begin('row');
    expect(() => transaction.allocate(counted, {value: 1})).toThrow(
      ExecutionError,
    );
    expect(creates).toBe(0);
    expect(heap.stats().tentativeCells).toBe(0);
    transaction.abort();
  });

  test('live limits are checked after mark and before sweep', () => {
    const heap = new ArenaHeap({
      maxStorageCells: 1,
      maxLogicalBytes: 8,
      maxTransientStorageCells: 2,
      maxTransientLogicalBytes: 16,
    });
    const transaction = heap.begin('row');
    const a = transaction.allocate(NODE, {value: 1});
    const b = transaction.allocate(NODE, {value: 2});
    transaction.commit();
    heap.replaceRoots([a, b]);
    expect(() => heap.collect()).toThrow(ExecutionError);
    expect(heap.stats().committedCells).toBe(2);

    heap.replaceRoots([a]);
    heap.collect();
    expect(heap.stats().committedCells).toBe(1);
    expect(() => heap.read(b)).toThrow('stale Ref');
  });

  test('dispose aborts active work and invalidates every Ref', () => {
    const heap = new ArenaHeap();
    const transaction = heap.begin('row');
    const ref = transaction.allocate(NODE, {value: 1});
    heap.dispose();
    heap.dispose();
    expect(() => transaction.read(ref)).toThrow('disposed');
    expect(() => heap.read(ref)).toThrow('disposed');
    expect(() => heap.begin('later')).toThrow('disposed');
  });
});
