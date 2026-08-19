# Tea value and memory model

This document owns source-observable copy, mutation, history, collection,
user-type, and future pointer semantics. [ir.md](ir.md) owns the static Program
contract; [runtime.md](runtime.md) owns physical representation and execution.

## Values, not hidden references

Tea user-defined types are nominal value types. A non-`na` `Foo` has one
observable form everywhere: assignment, arguments, returns, tuples, fields,
collection elements, and history all make the same shallow value copy.

Tea tuples themselves remain compiler/runtime transport values in V1: a tuple
result must be destructured at its declaration and cannot be stored under one
source name or given independent history. A typed-empty transport tuple
destructures into each element type's empty value.

```tea
Point p = Point.new(1, 2)
Point q = p
q.x := 3

// p.x is still 1.
```

Collections are value-semantic headers backed by immutable storage.
Copying an array, matrix, or map copies its header. A mutating operation builds
a replacement header and writes it back to exactly one current rooted place;
it cannot change another current alias or any historical value.

```tea
a = array.from(1)
b = a
b.push(2)

// a contains [1]; b contains [1, 2].
```

Physical sharing is an optimization only. It never gives ordinary user values
or collection values source-visible identity. Drawing and table handles are a
separate resource domain: copying one copies the same live external identity.

## Collections

V1 has these collection types:

- `array<T>`: a variable-length ordered sequence. Its capacity is private.
- `matrix<T>`: a fixed-shape rectangular row-major collection.
- `map<K, V>`: an insertion-ordered map. Keys are `int`, finite `float`,
  `bool`, `string`, `color`, or a nominal enum.

Collections store the ordinary runtime representation of `T`. There is no
boxing or collection-boundary conversion for user-defined values. Direct
nested collections store their headers by value.

Accessors return rvalues. V1 therefore uses get-modify-set for nested updates:

```tea
Point p = points.get(0)
p.x := 9
points.set(0, p)
```

`points.get(0).x := 9`, mutation of a temporary, and mutation through a
historical expression are checker errors. A collection loop snapshots the
complete header at loop entry, so later writes do not change the iteration.

A successful mutator evaluates its receiver once, evaluates arguments
left-to-right once, validates and builds a replacement, then performs one
root writeback. Rebuilding a nested path starts from the then-current root, so
argument-side writes to sibling fields survive while the mutator replacement
wins at its receiver leaf. A failed execution or suspension publishes none of
the transaction.

## User-defined value types

A block-form `struct Foo` and a block-form `type Foo` both declare the same
kind of fresh nominal user-defined value type. The spelling does not affect
assignment, layout, construction, or method behavior. `type Foo = Bar` is
reserved for a future transparent-alias feature; `struct` can never introduce
an alias.

A constructor builds one immutable logical record in canonical field order.
Updating `root.a.b` validates and rebuilds that value path, then writes the root
once. V1 supports simple `:=` field replacement; aggregate equality and
compound field assignment are not defined.

Methods are declared inside their owning user type. They have an implicit
receiver named `this`, so no receiver parameter or `inout` source syntax
exists:

```tea
struct Counter
    int value

    int add(int amount) =>
        this.value := this.value + amount
        this.value

    int read() const =>
        this.value
```

The implicit receiver is mutable unless the method has a trailing `const`.
A mutable call requires one current writable root or field path. The caller
captures that path and receiver value once, evaluates explicit arguments
left-to-right, and on normal return writes the replacement receiver through
the captured path once. A `const` method cannot update `this`, call a mutable
method through it, or invoke a collection mutator rooted in it; because it
needs no writeback, it may be called on temporaries and historical values.
Throwing or suspending performs no receiver writeback.

Method parameter defaults are caller-side expressions in the declaration's
outer scope. They may not refer to `this` or to any parameter of that method;
receiver-dependent defaults would require a separate callee-context feature.
Every method body is checked when its declaration is published, even if no
call site uses it. Calls may still create additional qualifier-specific method
instances, but an unused method cannot hide an invalid result, unknown name, or
illegal mutation through a `const` receiver.

`this` is an implicit, non-escaping receiver pointer/place capability, not a
first-class source value. V1 permits only `this.field` and
`this.method(...)`; bare `this` cannot be stored, returned, passed, compared,
dereferenced, or history-indexed. The backend may implement mutable methods as
copy-in/copy-out over immutable values. That physical choice is unobservable
and creates no alias between ordinary user values.

Direct recursive value containment is invalid because it has infinite size:

```tea
type BadNode
    BadNode next = na // rejected
```

A collection header breaks direct containment, so this is finite and legal:

```tea
type Node
    array<Node> children
```

## History and persistence

`value[N]` reads the ordinary value committed `N` iterations ago. History does
not return a live object or grant mutation rights. A historical user value is
the prior record; a historical collection value is the prior header whose
backing remains immutable.

`var` and `varip` are properties of root Ring slots, not values or backing
storage. `varip` selects which current root survives a provisional retry;
immutable sharing requires no per-object persistence metadata or edit replay.

A persistent declaration initializes when execution first reaches that source
location, not when its frame is allocated. Its initializer therefore observes
the current call arguments and surrounding control flow. Initialization is
transactional with the row transaction: an error or request suspension erases a
tentative first initialization; final commit makes it durable. `varip` may
retain both its value and initialized state after a successful provisional
execution of the same row.

## Empty values and errors

V1 retains Tea's typed-empty model rather than Go zero initialization. A `na`
collection is distinct from an empty collection and rejects collection
operations other than `na(value)`. Reading a field through a `na` user value
returns that field type's empty value; writing through it fails.

All bounds, shape, key, layout, and configured storage-limit failures occur
before the single root write. Runtime failures use stable error codes owned by
the runtime contract.

## Future pointers

V1 has no first-class source pointer type, raw allocation, pointer arithmetic,
or hidden reference carrier stored in a user-defined value. The implicit
method-only `this` capability cannot escape its call and therefore introduces
no observable pointer identity. A future safe pointer such as `*Foo` may make
references storable and introduce explicit identity and cycles, but its
pointee history, mutation, equality, rollback, lifetime, and collection
behavior require a separate language proposal.
