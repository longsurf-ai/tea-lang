---
title: Tea value and memory model
sidebarTitle: Memory model
---

This document owns source-observable assignment, mutation, history,
collections, structs, and persistence. [ir.md](ir.md) owns the static Program
contract; [runtime.md](runtime.md) owns physical representation and execution.

## Values and references

Tea has three relevant source-value behaviors:

- primitives and enums carry their value directly;
- arrays, matrices, and maps are value-semantic headers over persistent
  storage;
- nominal structs are mutable reference values.

A non-`na` struct value denotes one storage identity. Assignment, arguments,
returns, tuples, fields, and collection elements copy that reference:

```tea
struct Point
    int x
    int y

Point p = Point.new(1, 2)
Point q = p
q.x := 3

// p.x and q.x are both 3.

q := Point.new(4, 5)
// q was rebound; p still denotes the first Point.
```

Every successful constructor evaluation creates a fresh identity. Tea exposes
no address, dereference, pointer arithmetic, or implicit struct-copy operation.
Physical stack, frame, or Heap placement is not source-observable.

Tea tuples remain compiler/runtime transport values: a tuple result must be
destructured at its declaration and cannot be stored under one source Name or
given independent history. Tuple elements carry their ordinary values, so a
struct element is a reference and a collection element is a header.

Drawing and table handles remain a separate external-resource domain.

## Structs

`struct Foo` is the canonical declaration spelling. Compatible block-form
`type Foo` declares the same fresh nominal `StructType`; `type Foo = Bar`
remains reserved for transparent alias syntax.

A constructor initializes the new struct's fields in canonical declaration
order while preserving source argument evaluation order. A field may contain
another struct reference or a collection header. Direct and mutual recursive
structs are finite because a struct field contains a nullable reference:

```tea
struct Node
    int value
    Node next = na
```

Field assignment evaluates and validates the receiver once before evaluating
the right-hand side, then transactionally stores the field through the
captured reference. If the right-hand side rebinds an ancestor Name, the
captured object remains the target.

Reading a field through a `na` struct reference returns that field's typed
empty value. Field mutation and mutable-method calls through `na` fail before
right-hand-side or explicit-argument effects execute.

Struct identity equality is not defined in this version. Use `na(value)` to
test for a null reference.

## Methods and shallow `const`

Methods are nested in their owning struct and have an implicit receiver named
`this`. The receiver is mutable unless the method has trailing `const`:

```tea
struct Counter
    int value

    int add(int amount) =>
        this.value := this.value + amount
        this.value

    int read() const =>
        this.value
```

A mutable method changes the referenced storage in place. It may be called on
any non-`na` struct-reference expression, including a reference returned from
a collection accessor or history read. There is no receiver copy-in/copy-out.

`const` is shallow: a const method cannot replace a direct field of `this`,
including a collection header stored there. It may mutate an independently
referenced child struct:

```tea
struct Parent
    int value
    Counter child
    array<int> samples

    void inspect() const =>
        this.value := 1       // rejected
        this.samples.push(1)  // rejected: replaces this.samples
        this.child.add(1)     // allowed: child is a separate reference
```

Bare `this` remains a non-escaping receiver capability in this version: it
cannot be stored, returned, passed, compared, dereferenced, or history-indexed.
Method parameter defaults remain caller-side declaration-scope expressions and
cannot reference `this` or another method parameter.

## Collections

Tea has these collection types:

- `array<T>`: a variable-length ordered sequence;
- `matrix<T>`: a fixed-shape rectangular row-major collection;
- `map<K, V>`: an insertion-ordered map whose keys are `int`, finite `float`,
  `bool`, `string`, `color`, or a nominal enum.

A collection value is a small immutable header. Assignment copies the header.
A mutator constructs replacement backing and stores a replacement header into
one writable location:

```tea
a = array.from(1)
b = a
b.push(2)

// a contains [1]; b contains [1, 2].
```

The sized array constructor may omit its initial value. The element layout's
typed empty is used:

```tea
array.new<float>(3) // [na, na, na]
array.new<bool>(2)  // [false, false]
array.new<Point>(2) // [na, na]
```

A struct field stores a collection header by value:

```tea
struct Holder
    array<float> values

var a = array.new<float>(1)
var holder = Holder.new(a)

holder.values.set(0, close)
a.push(1.2)

// holder.values.size() remains 1; a.size() grows.
```

A collection whose element type is a struct stores references. Accessors return
ordinary element values, so a returned struct reference is mutable:

```tea
point = Point.new(1, 2)
points = array.from(point)
points.get(0).x := 9

// point.x is 9.
```

An accessor returning a collection header still returns an rvalue, so
`outer.get(0).push(v)` remains invalid. A collection field reached through a
struct reference is a location, so `points.get(0).samples.push(v)` is valid
when `samples` is a collection field.

A collection loop snapshots its complete input header at loop entry. Later
writes do not extend or reorder that iteration.

## History versions bindings

Every runtime variable uses the same bounded history semantics. `name[N]` reads
the value committed to that binding `N` iterations ago:

- primitive history contains prior primitive values;
- collection history contains prior headers and immutable backing;
- struct history contains prior references, never struct-body snapshots.

If a struct Name was not rebound, current and historical entries may contain
the same reference and therefore observe the same live body. If the Name was
rebound, history may contain a different, older reference. Mutating through a
historical struct reference is legal:

```tea
foo[1].x := 3
```

Historical collection headers preserve membership, not transitive struct
bodies. A historical `array<Point>` retains its old element references, while
the Points reached through those references remain live.

History syntax applies only to a direct readable binding. Computed-expression
history is rejected:

```tea
foo[1]             // valid
foo[1].x           // valid
foo.x[1]           // invalid
Point.new(1, 2)[1] // invalid
(high + low)[1]    // invalid
```

Bind the observation explicitly when its history is needed:

```tea
x = foo.x
oldX = x[1]
```

An offset must be a non-negative safe integer. Invalid or unavailable offsets
return the binding layout's typed empty value.

## Transactions, realtime, `var`, and `varip`

One execution transaction owns tentative storage allocation, struct-field
mutation, same-row local candidates, frame activation, and buffered emissions.
An execution error aborts the transaction; successful execution commits it.

Successful provisional ticks commit struct-body mutations. Consequently, a
shared reference supports natural realtime accumulation:

```tea
struct Counter
    int value

var counter = Counter.new(0)
counter.value := counter.value + 1
plot(counter.value)
```

Successive ticks on one realtime bar observe `1`, then `2`, then `3`. If the
third tick fails after writing `3`, abort restores `2`, and retry starts from
`2`.

`var` and `varip` govern binding initialization and rebinding, not the body
reached through a reference. Aliases with different storage classes still see
one committed body. A first successful ordinary-`var` initialization on an
unconfirmed row retains an initialization-only same-row candidate so the
example also produces `1`, `2`, `3` on its first live row. Later ordinary-`var`
reassignments still roll back between ticks; `varip` retains them.

Persistent initialization occurs when execution first reaches the declaration,
not when its frame is allocated. Failure before a successful initializer commit
retains neither its value nor its initialized state.

## Runtime storage boundary

Within one runtime context, all source-hidden memory identities use the same
typed `Ref<V>` and Heap framework. Collection backing and struct field storage
have different `TypeInfo<A, V>` policies over the same reference, transaction,
version guard, limits, reachability graph, and garbage collector.

In `JSRuntime`, the Heap is an owned execution resource, not part of
the `Intermediate` value. `Intermediate` contains only same-row frame state;
`JSRuntime` owns and disposes the Heap and injects it into the state
transition. A transition result can therefore replace State/Intermediate
without transferring storage ownership to its caller.

Collection operations allocate persistent replacement backing. A struct field
write stages a complete replacement body for the existing `Ref`; transactional
reads see that overlay, commit installs it, and abort discards it. This physical
distinction does not introduce two source reference kinds or require an
edit/undo journal.

Effect emission snapshots permitted struct fields at call time. It never hands
a live struct reference to a sink. Each request child owns an independent Heap,
and request results are restricted to scalars or scalar-only tuples copied by
value into parent-owned storage. A `Ref` never crosses that boundary; aggregate
request results remain unsupported until an explicit graph-copy contract is
implemented.

## Empty values and errors

Tea keeps typed-empty semantics rather than Go zero initialization. `na`
collections and struct references are distinct from valid empty collections or
allocated structs. Bounds, shape, key, type-info, layout, stale-reference,
and configured storage-limit failures use stable runtime error codes.
