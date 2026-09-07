// Purpose: Class identity, captured fields, NA, rollback and cyclic reachability.

import {describe, expect, test} from 'vitest';
import {ArenaHeap, type Ref} from './heap';
import {StructStorageRuntime} from './struct-storage';
import {bool, int, text, Value} from './value';

class Child {
  constructor(public value = int(NaN)) {}
  doubled(): number {
    return this.value.value * 2;
  }
}
class Parent {
  child = new Value<Ref<Child> | null>(null, 'Child', undefined, {ctor: Child});
  enabled = bool(false);
  label = text(null);
}
class Node {
  constructor(
    public next = new Value<Ref<Node> | null>(null, 'Node', undefined, {
      ctor: Node,
    }),
  ) {}
}

function harness() {
  const heap = new ArenaHeap();
  const structs = new StructStorageRuntime(heap);
  return {heap, structs};
}

describe('struct storage', () => {
  test('class bodies retain named captured fields through Heap writes', () => {
    const {heap, structs} = harness();
    const source = new Child(int(1));
    using transaction = heap.begin('class');
    const ref = structs.newStruct(transaction, source, 24);
    const body = transaction.read(ref);
    expect(body).toBeInstanceOf(Child);
    expect(body).not.toBe(source);
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.keys(body)).toEqual(['value']);
    expect(body.doubled()).toBe(2);
    structs.storeField(transaction, ref, Child, 'value', int(9));
    const updated = transaction.read(ref);
    expect(updated).toBeInstanceOf(Child);
    expect(updated.value).toBeInstanceOf(Value);
    expect(updated.doubled()).toBe(18);
    expect(source.value.value).toBe(1);
    expect(
      structs.field(ref, Child, 'value', int(NaN), transaction).value,
    ).toBe(9);
    transaction.commit();
    heap.replaceRoots([ref]);
    heap.collect();
    expect(heap.stats().retainedLogicalBytes).toBe(24);
    using failed = heap.begin('failed class write');
    structs.storeField(failed, ref, Child, 'value', int(12));
    failed.abort();
    expect(heap.read(ref).doubled()).toBe(18);
  });

  test('na field reads return the supplied captured empty', () => {
    const {structs} = harness();
    const parent = new Parent();
    expect(structs.field(null, Parent, 'child', parent.child)).toBe(
      parent.child,
    );
    expect(structs.field(null, Parent, 'enabled', parent.enabled).value).toBe(
      false,
    );
    expect(structs.field(null, Parent, 'label', parent.label).value).toBeNull();
    expect(structs.field(null, Child, 'value', int(NaN)).value).toBeNaN();
  });

  test('assignment aliases one body while fresh construction has new identity', () => {
    const {heap, structs} = harness();
    using transaction = heap.begin('row');
    const a = structs.newStruct(transaction, new Child(int(1)), 24);
    const alias = a;
    const other = structs.newStruct(transaction, new Child(int(1)), 24);
    const captured = structs.field(a, Child, 'value', int(NaN), transaction);
    structs.storeField(transaction, alias, Child, 'value', int(9));
    expect(captured.value).toBe(1);
    expect(structs.field(a, Child, 'value', int(NaN), transaction).value).toBe(
      9,
    );
    expect(
      structs.field(other, Child, 'value', int(NaN), transaction).value,
    ).toBe(1);
    transaction.commit();
  });

  test('abort restores committed fields and invalidates tentative objects', () => {
    const {heap, structs} = harness();
    const first = heap.begin('first');
    const child = structs.newStruct(first, new Child(int(1)), 24);
    first.commit();
    using failed = heap.begin('failed');
    structs.storeField(failed, child, Child, 'value', int(2));
    const tentative = structs.newStruct(failed, new Child(int(3)), 24);
    failed.abort();
    expect(structs.field(child, Child, 'value', int(NaN)).value).toBe(1);
    expect(() => structs.field(tentative, Child, 'value', int(NaN))).toThrow(
      'stale',
    );
  });

  test('constructor identity, field types and writes through na are checked', () => {
    class OtherChild {
      value = int(1);
    }
    const {heap, structs} = harness();
    using transaction = heap.begin('row');
    const child = structs.newStruct(transaction, new Child(int(1)), 24);
    expect(() =>
      structs.field(child, OtherChild, 'value', int(NaN), transaction),
    ).toThrow('VALUE_LAYOUT_MISMATCH');
    expect(() => structs.requireStruct(null, Child)).toThrow('NA_STRUCT_WRITE');
    expect(() =>
      structs.storeField(transaction, child, Child, 'value', text('wrong')),
    ).toThrow('VALUE_LAYOUT_MISMATCH');
    expect(() => structs.newStruct(transaction, {value: 'wrong'}, 24)).toThrow(
      'VALUE_LAYOUT_MISMATCH',
    );
    expect(
      structs.field(child, Child, 'value', int(NaN), transaction).value,
    ).toBe(1);
  });

  test('recursive captured references preserve cycles and exact retained bytes', () => {
    const {heap, structs} = harness();
    using transaction = heap.begin('class graph');
    const left = structs.newStruct(transaction, new Node(), 24);
    const right = structs.newStruct(
      transaction,
      new Node(new Value(left, 'Node', undefined, {ctor: Node})),
      24,
    );
    structs.storeField(
      transaction,
      left,
      Node,
      'next',
      new Value(right, 'Node', undefined, {ctor: Node}),
    );
    transaction.commit();
    heap.replaceRoots([left]);
    heap.collect();
    expect(heap.stats().retainedCells).toBe(2);
    expect(heap.stats().retainedLogicalBytes).toBe(48);
    expect(structs.field(left, Node, 'next', new Node().next).value).toBe(
      right,
    );
    expect(structs.field(right, Node, 'next', new Node().next).value).toBe(
      left,
    );
  });

  test('foreign references fail before any field change is accepted', () => {
    const {heap, structs} = harness();
    const other = harness();
    using transaction = heap.begin('local');
    using foreign = other.heap.begin('foreign');
    const left = structs.newStruct(transaction, new Node(), 24);
    const right = other.structs.newStruct(foreign, new Node(), 24);
    expect(() =>
      structs.storeField(
        transaction,
        left,
        Node,
        'next',
        new Value(right, 'Node', undefined, {ctor: Node}),
      ),
    ).toThrow('another Heap arena');
    expect(
      structs.field(left, Node, 'next', new Node().next, transaction).value,
    ).toBeNull();
  });
});
