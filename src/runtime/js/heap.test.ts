// Purpose: Typed transaction, root snapshot, Mark-Sweep, accounting, limit, and stale-reference regression tests for Heap.

import {describe, expect, expectTypeOf, test} from 'vitest';
import {ExecutionError} from '../errors';
import {
  ArenaHeap,
  isRef,
  type HeapTransaction,
  type Ref,
  type TypeInfo,
} from './heap';

interface NodeValue {
  readonly value: number;
  readonly children: readonly Ref<unknown>[];
}

interface NodeArgs {
  readonly value: number;
  readonly children?: readonly Ref<unknown>[];
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
  roots: Iterable<Ref<unknown>>,
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

describe('Heap managed class views', () => {
  const tag = Symbol('tag');
  class Counter {
    child: Counter | null = null;
    readonly values = Object.freeze([1, 2]);
    readonly captured = Object.freeze({value: 2, kind: 'int'});
    [tag] = 1;
    constructor(public total: number) {}
    increment(): void {
      this.total++;
    }
    get doubled(): number {
      return this.total * 2;
    }
  }
  const counter: TypeInfo<number, Counter> = {
    id: Symbol('Counter'),
    name: 'Counter',
    bytesFor: () => 40,
    create: total => Object.freeze(new Counter(total)),
    bytesOf: () => 40,
    trace: (body, visit) => {
      if (body.child !== null) {
        if (!isRef(body.child)) throw new Error('unmanaged child');
        visit(body.child);
      }
    },
  };

  test('frozen class bodies support pending fields, aliases, methods and symbols', () => {
    const heap = new ArenaHeap();
    using transaction = heap.begin();
    const ref = transaction.allocate(counter, 10);
    const view = transaction.view(ref);
    expectTypeOf(view).toEqualTypeOf<Counter>();
    expect(view).toBe(transaction.view(ref));
    expect(view).toBeInstanceOf(Counter);
    expect(isRef(view)).toBe(true);
    const original = transaction.read(ref);
    view.increment();
    view[tag] = 2;
    expect(view.total).toBe(11);
    expect(view[tag]).toBe(2);
    expect(original.total).toBe(10);
    expect(transaction.read(ref)).toBeInstanceOf(Counter);
    expect(view.values).toBe(original.values);
    expect(view.captured).toBe(original.captured);
    expect(Object.keys(view)).toContain('total');
    expect(Object.getOwnPropertyDescriptor(view, 'total')?.value).toBe(11);
    transaction.commit();
    expect(heap.read(ref).total).toBe(11);
    expect(heap.stats().committedCells).toBe(1);
    expect(() => view.total).toThrow('active Heap transaction');
  });

  test('managed child views preserve cycles and roots across transaction boundaries', () => {
    const heap = new ArenaHeap();
    using transaction = heap.begin();
    const a = transaction.allocate(counter, 1);
    const b = transaction.allocate(counter, 2);
    const first = transaction.view(a);
    const second = transaction.view(b);
    first.child = second;
    second.child = first;
    expect(first.child?.child).toBe(first);
    transaction.commit();
    // The view is itself a managed identity; it can root the same cell as a Ref.
    if (!isRef(first)) throw new Error('expected managed view');
    heap.replaceRoots([first]);
    heap.collect();
    expect(heap.stats().retainedCells).toBe(2);
    expect(heap.stats().retainedLogicalBytes).toBe(80);
    using next = heap.begin();
    expect(next.view(a)).toBe(first);
    expect(next.view(b)).toBe(second);
    first.child!.increment();
    expect(second.total).toBe(3);
    next.abort();
    using after = heap.begin();
    expect(second.total).toBe(2);
    expect(first.child?.child).toBe(first);
  });

  test('one Heap rollback discards writes and allocations made through class views', () => {
    const heap = new ArenaHeap();
    const setup = heap.begin();
    const ref = setup.allocate(counter, 10);
    commit(heap, setup, [ref]);
    expect(() => {
      using failed = heap.begin();
      const view = failed.view(ref);
      view.total = 20;
      view.child = failed.view(failed.allocate(counter, 30));
      throw new Error('output failed');
    }).toThrow('output failed');
    expect(heap.read(ref).total).toBe(10);
    expect(heap.read(ref).child).toBe(null);
    expect(heap.stats().committedCells).toBe(1);
    expect(heap.stats().tentativeCells).toBe(0);
  });

  test('views preserve foreign-reference, stale-reference and disposal guards', () => {
    const heap = new ArenaHeap();
    const foreign = new ArenaHeap();
    const setup = heap.begin();
    const ref = setup.allocate(counter, 10);
    const view = setup.view(ref);
    commit(heap, setup, [ref]);
    using foreignTx = foreign.begin();
    const foreignRef = foreignTx.allocate(counter, 20);
    const foreignView = foreignTx.view(foreignRef);
    expect(() => foreignTx.view(ref)).toThrow('another Heap arena');
    const local = heap.begin();
    expect(() => {
      view.child = foreignView;
    }).toThrow('another Heap arena');
    expect(view.child).toBe(null);
    local.commit();
    heap.replaceRoots([]);
    heap.collect();
    using next = heap.begin();
    expect(() => view.total).toThrow('stale Ref');
    expect(() => next.view(ref)).toThrow('stale Ref');
    next.abort();
    heap.dispose();
    expect(() => view.total).toThrow('disposed');
  });

  test('structural changes and accessor paths cannot bypass the write set', () => {
    const heap = new ArenaHeap();
    using transaction = heap.begin();
    const ref = transaction.allocate(counter, 10);
    const view = transaction.view(ref);
    expect(() => Reflect.set(view, 'newField', 1)).toThrow('data-field writes');
    expect(() => Reflect.defineProperty(view, 'total', {value: 2})).toThrow();
    expect(() => Reflect.deleteProperty(view, 'total')).toThrow();
    expect(() => Reflect.setPrototypeOf(view, {})).toThrow();
    expect(() => Reflect.preventExtensions(view)).toThrow();
    expect(() => view.doubled).toThrow('data-field writes');
    expect(view.total).toBe(10);
  });
});
