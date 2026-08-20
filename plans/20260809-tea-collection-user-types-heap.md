# tea-lang: collections, user types, and heap storage

> Struct-reference supersession note (2026-08-19): this plan remains historical
> implementation context for collection headers and the Heap transaction, but
> its user-type value-copy, inline-record, rooted-rebuild, and future-pointer
> direction is superseded by
> [Tea struct references and unified Heap storage](20260819-tea-struct-references.md).

> Receiver syntax note (2026-08-11): the collection/value/Heap model in this
> plan remains authoritative for its implementation, but its top-level
> `method` and explicit `inout self` source design is superseded by
> [Tea struct methods and implicit `this`](20260811-tea-struct-methods-implicit-this.md).

## 1. System map

```text
Tea source
   |
loadPackage + resolveImports
   |
   v
checker: CheckedPackage {pkg, info}
   +-- Package -> Scope -> Object -> Type
   +-- root / FunctionInstance / request-capture Info
   |      +-- TypeAndValue
   |      +-- one CallResolution per call
   |      +-- checked rooted mutation targets
   v
noder: buildProgram
   +-- semantic Object -> Program-local object
   +-- FieldObject -> canonical field index
   +-- checked mutation -> Program operation
   v
Program -> codegen
   +-- one root-wide aggregate-layout registry
   +-- generated root and request-child modules
   v
JSRuntime: SharedExecutionState
        +------------------------------------------+
        | Rings: current values + history          |
        | Heap: immutable collection backing       |
        | Emissions: transaction-local buffered output |
        +------------------------------------------+
                       ^
                       |
              collection StorageRef

Runtime Value
   +-- scalar / ResourceHandle
   +-- UserTypeValue (ordinary value record)
   +-- ArrayValue / MatrixValue / MapValue (small value headers)
   +-- tuple (compiler/runtime transport only)
```

The ownership boundaries are:

- `docs/memory-model.md` owns source-observable assignment,
  copy, mutation, history, collection, user-type, and future pointer semantics.
- `docs/ir.md` owns the checked semantic facts consumed by
  noder and the static Program operations. It does not own runtime layout IDs,
  copy-on-write, Ring mechanics, or Heap commits.
- `docs/runtime.md` owns generated layout manifests, runtime
  value representations, the immutable Heap arena, Ring/Heap/buffered-emission
  commits, request sharing, tracing, and deterministic limits.
- `Package -> Scope -> Object -> Type` is the checker source of truth. The exact
  active `Info` owns syntax-occurrence facts. Noder is the sole projection into
  Program-owned names, fields, functions, paths, slots, and requests. Codegen
  alone assigns dense backend layout IDs.
- Rings own time and `var`/`varip` persistence. Collection implementations own
  immutable replacement backing. Heap owns physical backing allocation,
  validation, reachability, and accounting; it does not give ordinary Tea
  values identity.
- Resource handles have live external identity and are deliberately not the
  model for user types. Drawing/table execution and its effect registry remain
  a separate future subsystem.

V1 supports `array<T>`, `matrix<T>`, insertion-ordered `map<K,V>`, nominal
user-defined value types, and arbitrary finite nesting of those values. V1
does not add list/deque/set types, writable collection element selectors,
explicit pointers, raw heap allocation, deep copy, or aggregate equality.

## 2. Problem and chosen semantic model

Before this implementation, the shared type domain already contained
`ArrayType`, `MatrixType`, `MapType`, and nominal user types. The checker had
already moved to `CheckedPackage`, with canonical declarations in
`Package -> Scope -> Object -> Type` and exact root/function/request facts in
separate `Info` objects. Noder alone projected that graph into a Program, but
execution stopped before aggregates:

- `resolveTypeName()` rejected parsed generic collection syntax;
- the catalog could not express type variables or applied collection patterns;
- user-type constructors and field reads existed in Program, but field writes
  assumed arbitrary reference mutation;
- codegen/runtime had no executable aggregate representation, layout manifest,
  immutable storage, or root visitor;
- aggregate writes did not participate in Ring rollback, realtime replay,
  dynamic-request suspension, or coordinated commit.

Tea adopts Go-like observable value semantics for user types and Tea-specific
immutable/COW value semantics for collection headers. The header resembles a Go
slice descriptor physically, but Tea deliberately does not expose Go slice
backing-array aliasing:

```tea
Point p = Point.new(1, 2)
Point q = p                   // shallow value copy
q.x := 3
assert p.x == 1

a = array.from(1)
b = a                         // copies {storage, length, capacity}
b.push(2)                     // writes a replacement header into b
assert a.size() == 1

points = array.from(p, p)     // stores two Point values; no boxing boundary
Point r = points.get(0)       // value copy
r.x := 4
points.set(0, r)              // explicit collection writeback
assert p.x == 1
assert points.get(1).x == 1
```

The implementation may share immutable representations, but sharing is never
observable as user-type or collection identity. A history cell stores the
ordinary outer runtime value committed for that iteration: a user value record
or a collection header. No historical heap revision and no implicit object
reference are part of this model.

This intentionally diverges from the Pine behavior established by the probes:
Pine collection history exposes old collection contents, while Pine user-type
history can retain a live reference. Tea applies the collection-like value
rule uniformly to both. External resources such as labels keep their separate
live-handle semantics.

This decision deliberately separates three questions:

1. `Foo` is one nominal source type.
2. `Foo` has value-copy behavior everywhere in V1.
3. A backend may physically allocate an immutable representation wherever it
   is efficient, but physical placement cannot change (1) or (2).

Future explicit safe pointers may add identity and cycles. They will be a new
source type such as `*Foo`, not a hidden alternate carrier for `Foo`, and will
not expose pointer arithmetic, address casting, or raw memory access.

## 3. Implementation

### 3.1 Language-level invariants

These are semantic decisions, not optimization hints:

1. Every non-`na` value of a user-defined type has one observable form: an
   ordinary value. Assignment, argument passing, return, tuple transport,
   field storage, collection storage, and history all use the same shallow
   value-copy rule.
2. A non-`na` collection value is an immutable, copyable header. Its backing
   storage may be shared, but any mutation computes a replacement header and
   cannot change a value reachable from another current or historical header.
3. Collection storage applies no user-type-specific boxing or encoding rule.
   It stores the same runtime value representation that ordinary assignment
   copies.
4. A direct recursive user-type value layout is invalid because it has
   infinite size. A collection edge breaks inline containment, so
   `type Node { array<Node> children }` is legal.
5. Every aggregate mutation requires a current writable root. Historical
   expressions, temporaries, and collection `get()` results are rvalues.
6. An aggregate mutation validates and builds its complete replacement before
   one root writeback. If it fails, the mutator performs no replacement. A
   thrown execution error or suspension then aborts the entire runtime transaction,
   so no RHS/argument state from that transaction is committed.
7. `[N]` selects a Ring value. It does not switch a value into a different
   representation and it never grants mutation rights to history.
8. `var`/`varip` behavior is entirely a Ring-root property. Immutable backing
   storage carries no persistence bit and needs no edit journal.
9. Root and request-child runtimes share one aggregate layout registry and one
   Heap arena. A `StorageRef` never crosses into an independently owned arena.
10. Ring candidates, reachable tentative Heap storage, and transaction-local
    buffered emissions prepare together and commit without user code between
    them. External sink delivery happens after internal commit and is not
    claimed to be reversible. The future drawing/table effect registry must
    join this coordinated boundary when implemented.
11. Canonical parameter/channel/layout order never overrides source evaluation
    order. Explicit call and constructor arguments, output bind arguments and
    per-bar channels, and parent-owned request context arguments evaluate once
    in source order; Program records a separate schedule before codegen
    assembles canonical ABI vectors. Omitted defaults evaluate afterward in
    canonical declaration order.

Two adjacent choices are intentionally not inferred from Go-like copy
semantics:

- V1 keeps Tea's existing typed-empty/`na` model. A `na` collection rejects
  collection operations other than `na(value)`. Reading a field from a `na`
  user value returns the field's typed empty, while writing a field fails.
  Neither is a Go zero value. Whether Tea should later give `var Foo foo`
  recursively usable zero fields is a separate language proposal.
- V1 collection accessors return values, not writable element places.
  Get-modify-set is required. A future indexing/place feature can change the
  surface syntax without changing value semantics.

### 3.2 Collections

#### Supported types and generic checking

`array<T>` and `matrix<T>` accept every storable Tea value:

```text
int | float | bool | string | color | enum | ResourceHandle
collection header | user-type value
```

Functions, void, output references, and ephemeral compiler tuples are not
storable. Direct nested collections are legal and store nested headers by
value.

`map<K,V>` accepts the same value domain for `V`. `K` is restricted to:

```text
int | float | bool | string | color | nominal enum
```

All collection constructors are invariant in their type parameters:

```text
array<A> is assignable to array<B> iff A == B
matrix<A> is assignable to matrix<B> iff A == B
map<KA,VA> is assignable to map<KB,VB> iff KA == KB and VA == VB
```

`array.from(...)` infers one common type using the checker's existing
assignment conversions. Numeric `int` values may widen to `float`; unrelated
nominal or collection types have no common type. `na` contributes no inference
information, so an all-`na` or zero-argument call requires explicit `<T>`.
Nested collection parameters remain invariant after inference.

This extends the existing shared type domain. `resolveTypeName()` recursively
resolves syntax `GenericType`/`ArrayType` into existing `ArrayType`,
`MatrixType`, and `MapType` values; `typesEqual`, `assignable`, and
`unifyTypes` remain the relation owners. Generic arity, storable-value, and
map-key predicates live beside those relations.

The native catalog gains type parameters and recursive type patterns rather
than collection-specific overload machinery:

```ts
interface NativeTypeParam {
  readonly name: string;
  readonly constraint: 'storable' | 'map-key';
}

type GenericTypeRef =
  | {readonly kind: 'type-param'; readonly name: string}
  | {readonly kind: 'array'; readonly element: NativeTypeRef}
  | {readonly kind: 'matrix'; readonly element: NativeTypeRef}
  | {
      readonly kind: 'map';
      readonly key: NativeTypeRef;
      readonly value: NativeTypeRef;
    };

interface NativeFunc {
  // Existing fields follow. Empty for non-generic entries.
  readonly typeParams: readonly NativeTypeParam[];
}

interface NativeParam {
  // Existing type/default/nullability fields follow.
  readonly mode: 'value' | 'inout';
}

interface NativeCall {
  readonly kind: typeof CallKind.Native;
  readonly native: NativeFunc;
  readonly args: readonly (syntax.Expr | null)[];
  readonly argTypes: readonly Type[];
  readonly resultType: Type;
  readonly receiver: ResolvedReceiver | null;
}
```

`GenericTypeRef` is one new recursive `NativeTypeRef` variant. Both namespace
and method spelling resolve to the existing `CallKind.Native` record in the
active `Info`; noder consumes its instantiated signature and never repeats
inference. A native `inout` parameter is legal only as the first receiver.

Map keys cannot be `na`. Tea's finite-number invariant applies to dynamic
float keys; `-0.0` canonicalizes to `0.0` before hashing/equality. Hashing
includes the static key domain and nominal enum identity.

#### Initial V1 source API

Namespace and method spelling are equivalent:

```tea
// array<T>
array.new<T>()                                      -> array<T>
array.new<T>(size: int, initial: T)                 -> array<T>
array.from<T>(...values: T)                        -> array<T>
array.size<T>(self: array<T>)                      -> int
array.is_empty<T>(self: array<T>)                  -> bool
array.get<T>(self: array<T>, index: int)           -> T
array.first<T>(self: array<T>)                     -> T
array.last<T>(self: array<T>)                      -> T
array.set<T>(inout self: array<T>, index: int, value: T) -> void
array.push<T>(inout self: array<T>, value: T)       -> void
array.pop<T>(inout self: array<T>)                  -> T
array.clear<T>(inout self: array<T>)                -> void
array.copy<T>(self: array<T>)                       -> array<T>

// matrix<T>
matrix.new<T>()                                     -> matrix<T>
matrix.new<T>(rows: int, columns: int, initial: T)  -> matrix<T>
matrix.rows<T>(self: matrix<T>)                     -> int
matrix.columns<T>(self: matrix<T>)                  -> int
matrix.elements_count<T>(self: matrix<T>)           -> int
matrix.get<T>(self: matrix<T>, row: int, column: int) -> T
matrix.set<T>(
    inout self: matrix<T>, row: int, column: int, value: T
) -> void
matrix.fill<T>(inout self: matrix<T>, value: T)     -> void
matrix.row<T>(self: matrix<T>, row: int)            -> array<T>
matrix.column<T>(self: matrix<T>, column: int)      -> array<T>
matrix.copy<T>(self: matrix<T>)                     -> matrix<T>

// map<K,V>
map.new<K: MapKey, V>()                             -> map<K,V>
map.size<K,V>(self: map<K,V>)                       -> int
map.is_empty<K,V>(self: map<K,V>)                   -> bool
map.contains<K,V>(self: map<K,V>, key: K)           -> bool
map.get<K,V>(self: map<K,V>, key: K)                -> V
map.put<K,V>(inout self: map<K,V>, key: K, value: V) -> void
map.remove<K,V>(inout self: map<K,V>, key: K)       -> V
map.clear<K,V>(inout self: map<K,V>)                -> void
map.keys<K,V>(self: map<K,V>)                       -> array<K>
map.values<K,V>(self: map<K,V>)                     -> array<V>
map.copy<K,V>(self: map<K,V>)                       -> map<K,V>
```

`matrix<T>` is a distinct rectangular collection, not syntax sugar for
`array<array<T>>`. An array of arrays may be ragged and each row has an
independent header. A matrix has one row-major storage root and a
`rows * columns` shape invariant. V1 matrix shape is fixed after construction.

V1 intentionally exposes array length through `size()` but no capacity API.
Capacity remains a runtime allocation hint. Array insertion/slicing/sorting,
matrix structural edits/arithmetic, map bulk operations, formatting, and
statistics are follow-on library/API work, not additional memory models.

#### One value-copy rule; no collection encoding boundary

There is deliberately no `encodeCollectionElement`,
`copyValueIntoCollectionStorage`, materialization, or boxing step. Each runtime
value already has the representation copied by assignment:

```text
number / boolean / nullable scalar -> copy scalar representation
ResourceHandle                     -> copy the live external handle
UserTypeValue                      -> shallow-copy the value record
Array/Matrix/MapValue              -> copy the collection header
na                                 -> copy the type's empty representation
```

Collection operations validate the static element layout and store that
ordinary value. Internal immutable sharing is allowed but cannot create
observable identity.

```tea
Point p = Point.new(1, 2)
points = array.from(p, p)

Point first = points.get(0)
first.x := 9

assert p.x == 1
assert points.get(0).x == 1
assert points.get(1).x == 1

points.set(0, first)
assert points.get(0).x == 9
assert points.get(1).x == 1
```

`array.new<Point>(3, p)` logically stores three values equal to `p`.
`matrix.fill(p)` logically replaces each cell with a value copy. An
implementation may share their immutable representation; later mutation still
requires a local value plus explicit collection writeback and cannot affect a
sibling slot.

#### Mutation and receiver writeback

A mutating call has one evaluation protocol:

```text
1. evaluate once and capture {writebackPath, receiverValue};
2. evaluate arguments left-to-right once;
3. use captured receiverValue as the operation base;
4. validate arguments, bounds, shape, key, and limits;
5. build {replacement, result} without changing the root;
6. after success, rebuild the captured path against the then-current root;
7. preserve argument-side writes to sibling fields, while replacement wins at
   the receiver leaf;
8. write the rebuilt root once;
9. yield result.
```

Failure before the final write adds no replacement from the mutator. Tentative
immutable storage allocated while building the replacement becomes
unreachable. A thrown execution error/suspension then follows the runtime's
whole-transaction abort path, so no argument effect publishes either. On success,
if argument evaluation wrote the same receiver leaf, the outer call still uses
its captured base and its replacement wins. For a nested receiver such as
`holder.values`, argument-side writes to other fields of `holder` survive
because path reconstruction starts from the then-current `holder`. If an
argument turns an enclosing path value into `na`, final validation throws, no
receiver replacement is written, and the transaction aborts.

Writable receivers are rooted current values:

```tea
xs.push(v)
holder.values.push(v)       // rebuild holder.values, then holder, then root
state.inner.values.set(0,v) // rebuild the complete value path
```

These are rvalues and are not writable:

```tea
xs[1].push(v)               // historical header
outer.get(0).push(v)        // accessor result
points.get(0).x := 3        // user value returned by accessor
makeArray().push(v)         // unrooted temporary
```

The explicit form for a nested collection element is get-modify-set:

```tea
inner = outer.get(0)
inner.push(v)
outer.set(0, inner)
```

By-value argument passing isolates transaction-local collection construction. An
`inout` receiver uses copy-in/copy-out. Transferring an exclusive edit token is
a later optimization and cannot alter this protocol.

#### Assignment, nesting, history, and iteration

Collection assignment and `.copy()` have the same shallow,
value-observable behavior. Both produce an independent header that may share
immutable storage; future writes affect only the written receiver.

```tea
inner = array.from(1)
outer = array.from(inner)

inner.push(2)
assert outer.get(0).size() == 1

nested = outer.get(0)
nested.push(2)
assert outer.get(0).size() == 1

outer.set(0, nested)
assert outer.get(0).size() == 2
```

History stores the old header/value, not a live mutable object:

```tea
xs[1].set(0, 9)       // checker error: history is not a place

if bar_index > 0
    old = xs[1]       // current value copied from the prior header
    old.set(0, 9)     // legal; xs[1] is unchanged

    prior = points[1].get(0)
    prior.x := 9      // legal local update; points[1] is unchanged
```

- Indices are zero-based; `get`/`set` require `0 <= index < size`.
- `first`, `last`, and `pop` fail on an empty array.
- `matrix.row`/`column` return independent array values, never writable views.
- `map.get`/`remove` return the value type's typed empty when absent; callers
  use `contains` to distinguish absence from a stored empty.
- Maps preserve insertion order. Replacement keeps position; remove/reinsert
  moves a key to the end. `keys()` and `values()` return aligned snapshots.
- Array/map loops capture the complete header at loop entry. Later mutation
  cannot alter values yielded by that snapshot.
- Arrays support `for value in xs` and `for [index, value] in xs`; maps support
  `for [key, value] in m`. Matrix V1 uses explicit row/column loops.

A `na` collection is distinct from an empty collection. Any collection
operation/loop over `na`, other than `na(value)`, raises an execution error.
Collection `==` and `!=` are checker errors in V1.

Stable execution codes:

```text
NA_COLLECTION
INDEX_OUT_OF_BOUNDS
EMPTY_COLLECTION
INVALID_SHAPE
INVALID_MAP_KEY
COLLECTION_LIMIT_EXCEEDED
HEAP_LIMIT_EXCEEDED
FIXED_VALUE_STORAGE_LIMIT_EXCEEDED
```

`MUTATION_REQUIRES_PLACE`, `MUTATION_OF_CONST`, invalid generic arity, and
invalid map-key type are checker diagnostics. `maxCollectionElements` is a
per-value logical bound. `maxHeapStorageCells` and
`maxHeapLogicalBytes` are shared-execution-state bounds; the Heap section adds
a separate transient-transaction bound. `maxFixedValueLogicalBytes` (default
64 MiB) separately bounds recursive fixed-width Ring/frame and materialized
request-column values.

One runtime function owns typed empties:

```ts
emptyValue(layout: LayoutId): Value
```

It returns `NaN` for numeric layouts, `false` for Tea's non-nullable bool,
and `null` for nullable scalar/resource, collection, and user-type layouts. It
never substitutes `0`, `""`, or a newly constructed empty collection. This is
the current Tea choice, independent of the copy model.

#### Header and immutable storage contract

```ts
interface ArrayValue {
  readonly kind: 'array';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly length: number;
  readonly capacity: number;
}

interface MatrixValue {
  readonly kind: 'matrix';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly rows: number;
  readonly columns: number;
}

interface MapValue {
  readonly kind: 'map';
  readonly layout: LayoutId;
  readonly storage: StorageRef;
  readonly size: number;
}

interface CollectionMutation<C, R = void> {
  readonly replacement: C;
  readonly result: R;
}
```

The source cannot observe `StorageRef` or capacity. Capacity is copied with an
array header but only guides allocation. Whether an append can reuse
transaction-local exclusive storage must not affect aliasing. Every successful
mutation returns a replacement header; all other current headers and every
historical header continue to expose their previous contents.

The same invariant covers both dimensions the language exposes: two headers
created by same-iteration assignment, and headers retained in different Ring
iterations. Heap does not implement a second collection-history mechanism;
ordinary Ring history plus immutable/COW backing is sufficient.

Initial correctness-first V1 storage uses sealed immutable flat payloads:

- array: one sealed ordered element payload;
- matrix: one sealed dense row-major payload;
- map: one sealed insertion-ordered entry payload.

Each mutation eagerly builds and seals a replacement payload. This is the
smallest implementation of the observable COW contract and the differential
oracle for later structural sharing. Persistent radix trees/chunked tails,
dense persistent chunks, and hash tries plus persistent order sequences are
post-conformance optimizations; they must not change headers, errors, limits,
iteration order, or copy behavior.

`pop`, `clear`, and shrink operations must make removed logical slots
unreachable or explicitly empty even when a future implementation retains
capacity. A later append must never reveal a stale high-water slot.

A collection implementation may use private mutable construction state while
computing a replacement, but that state is not a Heap cell and has no `StorageRef`.
Sealing must freeze or copy away every mutable alias before the first
`StorageRef` is created. Only sealed immutable refs may enter a collection
header, another payload, a Ring, an iterator, or history. Correctness never
depends on a mutable-construction fast path.

### 3.3 User-defined value types

#### Canonical semantic type and runtime value

Tea has one source-level nominal construct: `type Foo`. The checker owns one
canonical `UserTypeObject` in its package `Scope`; it owns one nominal
`UserType` and ordered `FieldObject`s. Runtime value representation is not a
second type.

The terminology migration is atomic across the semantic graph:

```text
ObjectKind.Udt   -> ObjectKind.UserType
UdtObject        -> UserTypeObject
TypeKind.Udt     -> TypeKind.UserType
UdtType          -> UserType
UdtField         -> UserField
IrKind.NewUdt    -> IrKind.NewUserValue
```

`CallKind.Constructor` remains because it names a resolved operation, not a
representation. The single runtime value representation is:

```ts
interface UserTypeValue {
  readonly kind: 'user-type';
  readonly layout: UserTypeLayoutId;
  readonly fields: readonly Value[];
}

type NullableUserTypeValue = UserTypeValue | null;
```

`UserTypeValue` is logically immutable. A backend may use immutable structural
sharing, native structs, or host heap objects, but Tea exposes neither its
address nor identity. `UserTypeLayoutId` exists only in generated/runtime ABI;
it never enters `Package`, `Scope`, checker `Object`, shared `Type`, or `Info`.

`UserTypeObject.fields`, shared with `UserType.fields`, is the canonical field
order. `SelectionKind.Field`, constructor arguments, and checked defaults point
to exact `FieldObject`s. Give every field an explicit owner and source index:

```ts
interface FieldObject {
  readonly kind: typeof ObjectKind.Field;
  readonly owner: UserTypeObject;
  readonly index: number;
  readonly name: string;
  readonly type: Type;
  readonly decl: FieldDecl;
  // The only checker-build slot: assigned once in the source-order pass.
  defaultValue: CheckedDefaultExpression | null;
}
```

Create the `UserType`, `UserTypeObject`, and shared field vector first, fill it
in source order, then finalize it. Noder projects selections through
`field.owner.type` and `field.index`; it never builds a reverse type-to-object
map. Codegen sees only Program `UserType` and emits that same ordered vector.

#### Declaration passes and finite layout

User-type checking is package-owned:

1. predeclare package-level `UserTypeObject`/`UserType` identities;
2. resolve field signatures and build canonical ordered fields;
3. construct the graph of direct user-type value-field edges and reject every
   self or mutual cycle;
4. preserve the existing source-order semantic pass; when it reaches a
   `TypeDecl`, check/finalize field defaults in the scope visible there and
   retain each `CheckedExpression {expr, info, tv}` plus dependencies.

Type identities and field signatures become forward-visible for annotation
resolution and cycle checking. Constructor calls become legal only after the
source-order pass reaches that `TypeDecl` and finalizes its defaults; an earlier
`Later.new(...)` is rejected rather than resolved with incomplete default
facts. Existing earlier ordinary bindings remain available to later defaults;
later ordinary bindings do not become visible early.
`FieldObject.defaultValue` starts empty, is assigned once when the declaration
is visited, and is read-only after `CheckedPackage` publication. `binding.ts`
remains variable/reassignment-only. Tests assert the single-assignment
boundary; no downstream phase receives an API that mutates the published field
object.

Direct containment is rejected; collection-mediated recursion is finite:

```tea
type BadNode
    int value
    BadNode next = na          // checker error: infinite value layout

type Node
    int value
    array<Node> children       // legal: array header breaks containment
```

No recursive-layout construction form, carrier classification, or
instance-form fact is needed. Library-exported user types remain deferred in
V1 because the current importer exposes functions only; enabling them requires
an importer contract extension.

#### Construction, assignment, history, and `na`

- Explicit constructor arguments evaluate once in source order, including
  named arguments written out of canonical field order. Omitted defaults then
  evaluate once in canonical field order. Only final record assembly follows
  canonical field order.
- Every constructor builds a `UserTypeValue`; missing arguments require field
  defaults.
- Assignment, parameter passing, return, tuple transport, field storage,
  collection storage, and history shallow-copy the ordinary value.
- A collection field copies its header; a `ResourceHandle` field copies the
  resource's live external identity. Those field-type rules do not give the
  enclosing user value identity.
- V1 adds no builtin user-type `copy()` operation: assignment already performs
  the shallow value copy. User code may define an ordinary method with that
  name. Any future builtin convenience spelling must be exactly equivalent to
  assignment and cannot introduce deep copy or identity.
- User-type `==`/`!=` remain checker errors in V1 because structural aggregate
  equality has not been specified. The old identity-versus-value rationale is
  deleted. `na(value)` remains supported.

History therefore behaves uniformly:

```tea
p = Point.new(bar_index, 0)
p.x := bar_index + 1000

if bar_index > 0
    prior = p[1]
    prior.x := -1          // updates current local prior only
    assert p[1].x != -1    // historical Point is unchanged
```

Reading a field through `na` returns the field layout's typed empty. Writing
through `na` raises `NA_USER_VALUE_WRITE`. Uniform source-location payloads
for runtime execution errors remain a separate diagnostics improvement.

#### User type containing a collection

The user value copies the collection header in its field:

```tea
type Foo
    array<float> values

Foo a = Foo.new(array.from(1.0))
Foo b = a

b.values.push(2.0)

assert a.values.size() == 1
assert b.values.size() == 2
```

`b.values.push` first builds a new array header, then rebuilds `b`, then writes
`b` once. The old `a`, and any already-retained `a[1]`, keep the previous
header.

#### Collection containing a user type

The collection stores and returns the same ordinary value:

```tea
items = array.from(Point.new(1, 2))

Point p = items.get(0)
p.x := 9
assert items.get(0).x == 1

items.set(0, p)
assert items.get(0).x == 9
```

`items.get(0).x := 9` is rejected in V1 because `get()` returns an rvalue. No
reference alias exists for such an update to target.

#### Atomic field paths and methods

A rooted update is evaluated and validated before one write:

```text
1. evaluate once and capture {root binding, canonical FieldObject path,
   receiverValue};
2. reject na or a runtime UserTypeLayoutId mismatch in receiverValue;
3. compute the new leaf value or replacement collection header;
4. revalidate and rebuild the field path against the then-current root,
   preserving RHS/argument-side sibling writes;
5. write the new root Ring scratch value once.
```

Program exposes this as one atomic `UpdateValuePath`. Runtime mechanics never
leak as separate prepare/apply Program nodes.

V1 supports simple `:=` field replacement only. Compound field assignment is a
checker error, matching the current checker; adding it later requires a
separate read-compute-write evaluation contract but no new memory model.

V1 permits `inout` only on the first receiver parameter of a method. It is not
available on arbitrary parameters, avoiding overlapping multiple writeback
paths. The receiver cannot have a default. `inout` is contextual in that
position and is stored as `Param.mode`, never as a type qualifier.

Method declarations remain canonical `FunctionObject`s and calls remain the
existing `FunctionCall` resolution. Because methods may target collections as
well as user types, `Scope` owns a receiver-indexed method set:

```ts
type ReceiverMode = 'value' | 'inout';

interface FunctionObject {
  // Existing declaration/template fields follow.
  readonly receiver: {
    readonly type: Type;
    readonly mode: ReceiverMode;
  } | null;
}

interface Scope {
  declareMethod(method: FunctionObject): boolean;
  lookupMethods(name: string): readonly FunctionObject[];
}
```

`lookupMethods` walks the scope chain. Resolution filters by shared
`typesEqual`, rejects duplicate name+receiver-type declarations, and allows the
same method name for different receiver types. A catalog method signature is
reserved: a user method with the same name and receiver type is rejected. This
keeps `array.push(xs, v)` and `xs.push(v)` equivalent; user extensions on that
receiver remain legal under other names.

Every mutating receiver has one rooted target shape:

```ts
interface CheckedWritebackTarget {
  readonly receiver: CheckedExpression;
  readonly root: VariableObject;
  readonly fields: readonly FieldObject[];
}

type ResolvedReceiver =
  | {
      readonly mode: 'value';
      readonly value: CheckedExpression;
    }
  | {
      readonly mode: 'inout';
      readonly value: CheckedExpression;
      readonly writeback: CheckedWritebackTarget;
    };
```

Direct `:=` updates live in one per-`Info` update map. Native/function call
receivers stay on their existing single `CallResolution`; no feature-specific
call maps are added. There is no object-rvalue mutation target.

```tea
method append(inout Foo self, float value) =>
    self.values.push(value)

foo.append(1.0)
```

Call protocol:

```text
1. evaluate and capture {callerPath, receiverValue} once;
2. evaluate remaining arguments left-to-right once;
3. call with the receiver value;
4. callee returns {replacementReceiver, result};
5. on normal return, rebuild callerPath against the then-current root, keeping
   argument-side sibling writes and letting replacementReceiver win at the
   receiver leaf;
6. write that root once;
7. on throw/suspension, perform no copy-out and let JSRuntime abort the whole
   transaction.
```

An ordinary by-value method may update its local receiver copy but cannot
change the caller. It has no hidden reference behavior. No mutation-origin,
access-witness, or persistence operand is needed: the caller's final Ring root
write determines `var`/`varip` policy. Field-level `varip` remains rejected in
V1, and the legacy field persistence bit is removed from `UserField` and
`FieldObject` rather than published as permanently false metadata.

### 3.4 Type-neutral Heap arena

#### Responsibility and interface

V1 Heap is a source-hidden arena for immutable, variable-sized collection
backing. It is not a semantic object store. Its only handle is `StorageRef`:

```ts
declare const storageRefBrand: unique symbol;

interface StorageRef<TPayload = unknown> {
  readonly [storageRefBrand]: TPayload;
}

interface StorageTracer {
  storage(ref: StorageRef<unknown>): void;
}

interface StorageDescriptor<TPayload, TArgs> {
  readonly id: DescriptorId;
  readonly debugName: string;
  // Exact owned bytes the sealed payload will report. Heap checks transient
  // capacity from the args before seal is allowed to copy/freeze them.
  logicalBytesFor(args: Readonly<TArgs>): number;
  // Called inside Heap. The result has no mutable alias reachable by caller.
  seal(args: TArgs): TPayload;
  trace(payload: Readonly<TPayload>, tracer: StorageTracer): void;
  // Counts bytes owned by this cell only, excluding child StorageRefs.
  logicalBytes(payload: Readonly<TPayload>): number;
}

interface Heap {
  beginTransaction(key: TransactionKey): HeapTransaction;
  read<TPayload>(ref: StorageRef<TPayload>): Readonly<TPayload>;
  collect(
    physicalRoots: Iterable<StorageRef<unknown>>,
    retainedRoots?: Iterable<StorageRef<unknown>>,
  ): void;
  dispose(): void;
}

interface HeapTransaction {
  allocateSealed<TPayload, TArgs>(
    descriptor: StorageDescriptor<TPayload, TArgs>,
    args: TArgs,
  ): StorageRef<TPayload>;

  prepareCommit(
    candidateRoots: Iterable<StorageRef<unknown>>,
  ): PreparedHeapCommit;

  abort(): void;
}

interface PreparedHeapCommit {
  commit(): void; // validation/accounting already finished; cannot throw
}
```

Descriptors, not Heap, understand the V1 sealed flat array, dense row-major
matrix, and insertion-ordered map payloads, or how stored `Value`s contain
further `StorageRef`s. A descriptor's `seal` must freeze or copy its args so
no mutable alias remains; Heap never accepts a supposedly immutable
caller-owned payload. Future page/chunk/trie descriptors may replace those
payloads behind the same interface. Heap has no edit type, `stageEdit`,
`readRetained`, revision, historical snapshot, or persistence policy.

Preparation is commit/cell-state side-effect-free: it traces, validates,
accounts, freezes a promotion/discard plan, and moves the transaction to
`prepared`, but changes no cell state. Only
`PreparedHeapCommit.commit()` promotes reachable tentative cells,
discards the rest, closes the transaction, and does so without throwing. If any
other row component fails to prepare, `abort()` can still discard the entire
prepared-but-uncommitted transaction. Older committed garbage is reclaimed only by
later safe-point collection.

A private `StorageRef` may contain an arena token, slot, reuse version, and
descriptor ID so stale, cross-arena, and wrong-descriptor reads fail loudly.
The version only detects slot reuse; it is not an iteration snapshot.
Host GC may reclaim a disposed arena implementation, but deterministic limits
and semantic reachability use the arena registry, not host-GC timing.

Transaction and reference state is explicit:

```text
active -> prepared -> committed
active -> aborted
prepared -> aborted
```

- allocation is legal only while active;
- `prepareCommit` is called once, freezes its candidate root set, and
  moves active -> prepared without committing;
- exactly one terminal `commit` or `abort` invalidates the transaction object;
- `Heap.read` accepts a committed ref, or a tentative ref owned by the current
  active/prepared transaction; abort/discard makes a tentative ref stale;
- a sealed payload may point only to same-arena committed refs or refs owned by
  that same transaction;
- preparation rejects any candidate closure that would commit a cell pointing
  to tentative storage outside the frozen reachable closure.

If a future backend stores immutable `UserTypeValue` representations in this
arena, that remains an unobservable optimization: copying `Foo` still copies a
value, and no such internal handle may enter source-visible equality or
mutation rules. V1 need not introduce that optimization.

#### Transaction lifecycle and atomic commit

Transaction allocation prevents failed writes from leaking physical storage:

```text
begin transaction
  -> execute generated main
     -> provisional success:
          form Ring candidates
          retain only varip candidates according to Ring policy
          prepare reachable Heap storage + Ring/emission transition
          commit internal state without throwing
          deliver explicitly provisional effects
     -> final success:
          form final Ring candidates
          prepare reachable Heap storage + Ring/emission transition
          commit internal state without throwing
          deliver immutable final emissions to external sink
     -> suspension or failure:
          invalidate this transaction's Ring scratch and emissions
          restore the exact pre-transaction varip state
          abort tentative Heap allocation
```

All allocation/limit/layout checks occur before commit. `JSRuntime` owns
one opaque prepared row transition:

```ts
interface PreparedRowCommit {
  commitInternalState(): void; // Heap + Rings + emission state; cannot throw
  deliverEmissions(): void; // post-commit external boundary
}
```

Generated code cannot begin, prepare, commit, or abort Heap transactions. If an
external sink throws, Tea state remains committed and the host reports a
delivery failure.

At most one nonterminal (`active` or `prepared`) transaction exists in the shared
Heap; `beginTransaction` fails while either state exists. Dynamic request suspension
aborts the parent transaction and invalidates its scratch/emissions before a child
runtime executes. Retry starts a new parent transaction. Bind-time aggregate work
runs in a dedicated abort-only transaction so discarded bind frames cannot leave
storage cells.

Because values/backing are immutable, mixed `var` and `varip` aliases require
no field-edit replay or causal promotion. After a provisional run, Ring policy
chooses the surviving headers/values; Heap retains exactly the storage
reachable from those candidate roots.

#### Reachability, limits, requests, and effects

Physical collection runs only after the current transaction has committed or
aborted, invalid scratch/temporaries have been cleared, and unregistered JS
temporaries can no longer be sole owners. `prepareCommit` tracing is not
physical collection. Runtime owners expose two distinct root views:

```ts
Ring.visitCommitValues(mode, visit)
MergedView.visitValues(visit)
JSRuntime.visitHeapCommitRoots(
  mode: 'committed-only' | 'provisional-candidate' | 'final-candidate',
  visit,
)
JSRuntime.visitHeapTransactionSafetyRoots(visit)
```

The runtime layout walker finds `StorageRef`s inside collection headers nested
in user values/tuples. Storage descriptors then trace refs inside collection
payloads. Commit roots are the exact post-commit owner graph:

- committed/history Ring cells that remain after candidate replacement and
  eviction;
- the exact provisional/final candidate cells selected by Ring policy;
- static/dynamic request result Rings, merged views, pair views, and registered
  request-child result builders that remain owners after commit.

Overwritten/evicted cells and a pre-transaction varip snapshot that disappears on
success are not commit roots and are not charged to the retained limit.
`visitHeapTransactionSafetyRoots` separately covers that snapshot and any other
temporary owner needed until commit/abort; safety roots cannot influence the
prepared retention/accounting result.

`runChildRows` registers a result builder before capturing its first aggregate
value and transfers ownership to the completed `MergedView` before collection
can run. This covers keep-zero result Rings.

Direct recursive user values are rejected and V1 has no pointers, so aggregate
graphs are finite immutable DAGs. Collection still uses visited-set tracing to
handle structural sharing and to leave room for future explicit pointers.

`prepareCommit` traces the complete commit-root set and counts each
reachable cell once. `logicalBytes(payload)` counts bytes owned by that cell,
excluding child cells reached through `StorageRef`, so shared persistent
subtrees are not double-counted. Deterministic limits never depend on host GC
timing. Before calling a descriptor's potentially allocating `seal`, Heap
validates the transient cell bound and the exact
`logicalBytesFor(args)` estimate; after sealing, `logicalBytes(payload)`
must equal that estimate or the descriptor has violated an internal invariant.
Thus the separate transient-transaction bound prevents the allocation spike, not
merely commitment of an already oversized copy. Rename the source-facing
budget from `maxHeapObjects` to
`maxHeapStorageCells`; ordinary user values are not heap objects.
Their fixed-width footprint is recursively derived from `ValueLayout` (stopping
at collection headers) and reserved from shared
`maxFixedValueLogicalBytes` before frame/Ring/request-column allocation;
variable collection backing is charged separately to Heap.

The root runtime creates one `SharedExecutionState` containing the layout
registry, Heap, and request-context budget, and injects it into every request
child. Aggregate request values cannot ship before this shared ownership and
result-builder rooting are complete. Every cached `(edge, symbol, timeframe)`
pair reserves one context-budget entry, including a pair cached as na by
`ignore_invalid_symbol`; only an uncached hard resolution failure releases its
reservation.

V1 output/effect channel types remain scalar/resource-only. Direct collection
or user-value outputs are rejected until deep serialization or host root leases
are specified; otherwise a sink could retain an unregistered `StorageRef`.

Drawings/tables remain outside Heap:

```tea
label.new(...)               // registers an effect even when unused
h = label.new(...)           // registration plus ResourceHandle
h[1].set_x(...)              // historical handle denotes same live resource
```

When drawing/table execution lands, its separate effect registry will own
construction, setter/delete ordering, rollback, commit, and resource
limits. V1 currently has only transaction-local emission buffering plus
post-commit sink delivery. Copying/storing a `ResourceHandle` copies that
external identity; collection copy never clones the resource, and Heap does
not trace its internals.

### 3.5 Compiler, ABI, and ownership

#### Aggregate layout manifest

Semantic user-type identity remains canonical `UserType` object identity in the
shared type domain. During generation, the root `ModuleEmitter` owns one
deterministic aggregate-layout registry shared by root/request modules:

```ts
type LayoutId = number;
type UserTypeLayoutId = LayoutId;

type ValueLayout =
  | {kind: 'number'; numeric: 'int' | 'float'}
  | {kind: 'boolean'}
  | {kind: 'nullable-scalar'; scalar: 'string' | 'color'}
  | {
      kind: 'enum';
      name: string;
      members: readonly string[];
    }
  | {kind: 'resource'; handle: HandleKind}
  | {
      kind: 'user-type';
      name: string;
      fields: readonly {
        readonly name: string;
        readonly layout: LayoutId;
      }[];
    }
  | {kind: 'array'; element: LayoutId}
  | {kind: 'matrix'; element: LayoutId}
  | {kind: 'map'; key: LayoutId; value: LayoutId}
  | {kind: 'tuple'; elements: readonly LayoutId[]};

interface LocalSpec {
  readonly storage: NameStorage;
  readonly depth: DepthSpec;
  readonly layout: LayoutId;
}

interface RequestSpec {
  // Existing merge/depth/resultSlot/dynamic fields follow.
  readonly layout: LayoutId;
}

interface AggregateLayoutManifest {
  readonly layouts: readonly ValueLayout[];
}

interface ModuleCode {
  // Existing code/manifest/request-child fields follow. Request children use
  // this shape and inherit the root ABI/layout/shared-state contract.
}

interface TeaModule extends ModuleCode {
  readonly abi: 3;
  // Present once on the root module; children receive it through shared state.
  readonly aggregateLayouts: AggregateLayoutManifest;
}

interface SharedExecutionState {
  readonly aggregateLayouts: ValueLayoutRegistry;
  readonly heap: Heap;
  readonly contextBudget: ContextBudget;
  readonly fixedValueStorage: FixedValueStorageBudget;
}
```

There is no `constructionForm`. A `UserTypeLayoutId` is simply an index whose
layout kind is `user-type`; keeping it in one table prevents competing ID
namespaces. No semantic object receives a layout ID. `ValueClass` may remain a
layout-derived Ring optimization but does not define assignment/history.
`ValueClass.Nullable` only selects `null` as the typed empty and must not imply
Tea reference semantics. `LocalSpec.layout` and `RequestSpec.layout` are the
manifest facts retained by Rings, merged request views, and registered result
builders so typed-empty selection and root walking are exact.

This is an ABI break and bumps generated modules from ABI 2 to ABI 3.
`runtime/load.ts` carries the ABI 3 module type, while `JSRuntime` remains the
single runtime ABI gate and rejects every other value before bind. Codegen,
handwritten runtime fixtures, and request-child module tests update together.

The registry reserves an ID before recursively filling its descriptor. That is
required for finite runtime values whose static type graph is recursive through
a collection, such as `Node { array<Node> children }`. Runtime tracing follows
actual values and storage nodes; it never infinitely expands the static layout
graph.

#### Checker -> noder -> Program -> runtime contract

```text
checker / exact active Info
  TypeAndValue (existing type + qualifier + const value)
  CallResolution = native | function | constructor | request
  update target = current root VariableObject + canonical FieldObjects
  receiver mode + source legality

noder / current ProgramLoweringContext
  VariableObject -> Name
  FieldObject -> field.owner.type + field.index
  NewUserValue(userType, arguments)
  UpdateValuePath(path, value)
  MutateCollection(path, operation, arguments)
  CallInout(path, callee, arguments)

lowering + runtime
  evaluate once -> validate -> allocate immutable replacement
  -> one Ring-root writeback
```

Program owns the projected path and inout function contract; it never embeds a
checker object:

```ts
interface IrValuePath {
  readonly root: Name;
  readonly fieldIndices: readonly number[];
}

interface ValueIrFunc extends IrFuncBase {
  readonly callMode: 'value';
}

interface InoutIrFunc extends IrFuncBase {
  readonly callMode: 'inout';
  // Noder constructs this as exactly params[0].
  readonly receiver: Name;
}

type IrFunc = ValueIrFunc | InoutIrFunc;

interface CallFuncExpr {
  readonly func: ValueIrFunc;
  // Existing call fields follow.
}

interface CallInoutExpr {
  readonly func: InoutIrFunc;
  readonly path: IrValuePath;
  // Existing call fields follow.
}
```

An `InoutIrFunc` returns a generated-code-only envelope
`{receiver, result}` on normal completion; it is not a Tea tuple or a Ring
value. `CallInoutExpr` consumes that envelope, rebuilds its `IrValuePath`, writes
once, and yields only `result`. Noder asserts `receiver === params[0]` at
construction. The discriminated call types prevent `CallFuncExpr` from
targeting an inout function and prevent `CallInoutExpr` from targeting a value
function, giving codegen a complete contract without checker imports.

No `InstanceFormFact`, carrier dispatch, object-edit target,
`MutationOrigin`, access witness, or static callee persistence enum exists.
One `InoutIrFunc` can be called through both `var` and `varip` roots because the
callee returns a replacement receiver and the caller performs the final write
to its own projected `Name`.

`WriteField`, which assumes arbitrary reference mutation, is replaced by the
rooted atomic path operation. Separate Program `PrepareUpdate`/`ApplyUpdate`
nodes are forbidden; allocation/commit belongs to runtime. Visitors,
dumpers, depth analysis, and lowering switch exhaustively over new operations.

Generic collection calls enrich the existing `NativeCall`. User methods remain
`FunctionCall`; constructors remain field-aligned `ConstructorCall`. The
checker adds one update map for direct assignments and receiver facts to the
existing calls, never parallel feature-specific call tables.

Current `NA_VALUE` ownership remains unchanged: checker publishes existing
`TypeAndValue`; noder contextualizes `NA_VALUE` using the concrete expected
type before Program construction, as required by the current noder invariant.
No carrier-form metadata is added to `TypeAndValue`, `VariableObject`, or
`FunctionInstance`, and function stencil keys remain `(FunctionObject, type +
qualifier signature)`.

#### Concrete owner files

- `src/syntax/{tokens,scanner,nodes,parser,dumper}.ts`, parser/golden tests, and
  `editors/vscode/scripts/generate-syntax.ts` plus its syntax test: add
  `Param.mode: 'value' | 'inout'`, preserve `method` as a contextual
  declaration keyword, and never encode `inout` as a qualifier.
- `src/ir/type.ts`: atomically rename `Udt*` to `UserType*`; retain one shared
  type domain, collection types, and relation owners. `UserType` owns its
  canonical ordered fields and no backend ID/carrier classification.
- `src/checker/{package,scope,object}.ts`: own the canonical semantic graph,
  user-type predeclaration/fields, explicit field owner/index, finite-layout
  rejection, method receiver metadata, and receiver-indexed lookup.
- `src/checker/info.ts`: own exact per-context `TypeAndValue`, selections,
  direct rooted update targets, and receiver facts on the single
  `CallResolution`. Canonically aligned call arguments retain a separate
  source evaluation order. Constructor arguments/defaults retain originating
  `CheckedExpression.info`.
- `src/checker/check.ts`: preserve source-order checking while adding generic
  annotations/inference, user-type declaration passes, method/receiver/place
  legality, and diagnostics.
- `src/checker/binding.ts`: continue to create variable/reassignment objects
  only; it never resolves types, layouts, fields, or Program objects.
- `src/checker/catalog.ts`: own collection primitives, generic type patterns,
  native receiver mode, qualifiers, and effect policy.
- `src/noder/noder.ts`: sole semantic -> Program projection; consume exact
  `Info`, project canonical field indices/rooted targets, and emit aggregate
  construction/mutation/inout operations without re-checking.
- `src/ir/{node,program,visit,dumper}.ts`: rename `NewUdt` to `NewUserValue`,
  own `IrValuePath`, aggregate operations, and the discriminated
  `ValueIrFunc`/`InoutIrFunc` call contract. They import no checker types and
  own no runtime layout IDs, Heap protocol, or COW mechanics.
- `src/codegen/{codegen,lower}.ts`: own one root `ModuleEmitter` layout registry,
  deterministic IDs, ABI 3 emission, aggregate lowering, and UDF receiver
  copy-in/copy-out envelopes.
- new `src/runtime/value-layout.ts`: own aggregate layout records, typed
  empties, recursive layout walking, and runtime layout guards.
- new `src/runtime/user-value.ts`: own `UserTypeValue` construction, field
  reads, and immutable path rebuilding.
- new `src/runtime/heap.ts`: own immutable storage registry, transactions,
  descriptors, validation, commit, tracing, deterministic accounting,
  and disposal.
- new `src/runtime/collections/{array,matrix,map}.ts`: own V1 sealed flat
  backing and semantic operations returning replacements; later structural
  sharing stays behind this boundary.
- `src/runtime/{abi,load}.ts`: own aggregate `Value`, the ABI 3 module/load
  shape, the single layout manifest, request-result layouts,
  `SharedExecutionState`, execution errors, Heap injection, and semantic `rt`
  calls.
- `src/runtime/{ring,merge,js-runtime}.ts`: own root visitors, shared request
  state, layout-aware request views, result-builder registration, transaction
  lifecycle, suspension abort, coordinated commit, and the ABI gate.
- owning `AGENTS.md` files and `docs/{memory-model,ir,runtime,conformance}.md`:
  encode localized invariants at their authoritative layer.

#### Dependency-ordered delivery

1. **Write authorities and conformance fixtures.** Add `docs/memory-model.md`;
   update IR/runtime docs; lock value-copy, rooted-mutation, direct-recursion,
   history, and COW behavior with compile-pass/fail fixtures.
2. **Complete the semantic naming/type work.** Rename `Udt*` to `UserType*`
   across Type/Object/Info/Program/docs/tests; add field owner/index, package
   predeclaration and direct-cycle rejection while preserving source-order
   default checking; resolve collection annotations/generics into existing
   shared collection types.
3. **Add rooted mutation and receiver syntax.** Parse receiver-only `inout`,
   add receiver-indexed method resolution and the one checked writeback target,
   and have noder emit atomic value paths and copy-in/copy-out calls.
4. **Land runtime value/layout foundations.** Add `UserTypeValue`, collection
   headers, typed empties, one root-wide layout registry, local/request layout
   ownership, the ABI 2 -> 3 gate, runtime guards, and exhaustive
   Program/codegen support. Keep aggregate requests disabled until shared
   execution state exists.
5. **Land immutable Heap + array core.** Add storage descriptors, transaction
   state/commit, sealed args boundaries, commit/safety roots and
   limits, sealed eager-copy array operations, same-iteration and history COW,
   nested headers, iteration snapshots, and errors.
6. **Land matrix then ordered map.** Reuse the same value-copy/writeback/Heap
   contracts; add dense row-major and insertion-ordered sealed payloads, key
   canonicalization, projections, iteration, and errors.
7. **Close realtime and request integration.** Coordinate Ring/Heap/emission
   preparation, suspension abort, shared root/request arena and layout table,
   keep-zero result-builder rooting, and aggregate request results.
8. **Optimize only after conformance.** Add transaction-local transient builders,
   structural-sharing improvements, and collection-aware COW heuristics without
   changing committed semantics.

No step may encode a `StorageRef` into numeric NaN payloads, use host object
identity as Tea value identity, or allow aggregate values to cross independent
Heap arenas.

## 4. Verification

- [x] Tea typecheck closes aggregate ABI/layout types, immutable Heap
      descriptors, root visitors, and exhaustive IR/codegen switches.
- [x] Checker tests cover generic invariance/inference, invalid map keys,
      direct/mutual user-type cycles, collection-mediated recursion,
      source-order defaults, constructor-before-finalization rejection,
      receiver overload/duplicate rules, reserved catalog-method collisions,
      receiver-only `inout`, rooted/non-rooted mutations, compound-field
      rejection, and copy-out only on success.
- [x] Ownership tests prove one canonical `UserTypeObject` appears in package
      `Scope`, `Info.defs`/`uses`, field `Selection`, and `ConstructorCall`;
      fields retain canonical identity/order/owner/index and no semantic object
      gets a runtime layout ID.
- [x] Boundary tests prove checker production imports neither `ir/node.ts` nor
      `ir/program.ts`, IR imports no checker types, every call has one exhaustive
      `CallResolution`, and noder uses the exact active `Info` without
      re-checking. IR construction makes `CallFuncExpr -> ValueIrFunc` and
      `CallInoutExpr -> InoutIrFunc` exhaustive and asserts the inout receiver
      is exactly `params[0]`.
- [x] Noder/codegen tests project one semantic `FunctionInstance`/`UserType`
      into distinct root/request Programs while one root `ModuleEmitter` emits
      a deterministic collision-free layout registry, including a type graph
      recursive through a collection.
- [x] ABI tests lock ABI 3 emission/loading, reject ABI 2 before bind, and prove
      locals, request results, Rings, merged views, and result builders retain
      exact layout IDs. Nominal enums and concrete resource kinds never collapse
      into one generic nullable layout.
- [x] User-type tests cover assignment independence, tuple/parameter/return
      transport, history snapshots, `na` reads/write failure, shallow nested
      values, user-type-containing-collection COW, collection-containing-user
      get-modify-set, and absence of an implicit special user-type copy
      carrier/builtin.
- [x] Compile-fail tests reject direct/mutual value recursion, historical/rootless
      mutation, `get()` result mutation, field-level `varip`, aggregate
      equality, an undeclared implicit user-type `copy()` builtin, unsupported
      aggregate outputs, and future pointer syntax.
- [x] Array/matrix/map property tests compare random traces with an eager-copy
      reference model and hash every retained header after each mutation.
- [x] Collection tests cover same-iteration alias isolation, historical header
      isolation, nested get-modify-set, append after assignment/pop, repeated
      user values, complete-header loop snapshots, map insertion order, missing
      versus stored empty, `na`, bounds, and every stable error code.
- [x] Storage tests prove pop/clear/shrink cannot retain or reveal stale slots;
      older longer headers remain valid; rollback plus append cannot resurrect a
      high-water value.
- [x] Realtime tests cover ordinary rollback, varip persistence, current/header
      alias isolation in both write orders, provisional reachable storage,
      nested receiver rebasing that preserves argument-side sibling writes,
      failed replacement allocation with no root write, final commit, and
      suspension after tentative allocation.
- [x] Commit tests prove every fallible validation/limit check occurs before
      commit; Heap preparation is commit/cell-state side-effect-free;
      failed peer preparation can still abort the prepared-but-uncommitted
      transaction; Heap/Rings/emission state commits without throwing; sink failure
      cannot roll back committed Tea state.
- [x] Request tests cover parent abort before dynamic child resolution, one
      shared arena/layout registry/budget, aggregate result history,
      keep-zero result builders, merged/pair-view roots, cross-arena rejection,
      and recursive request trees.
- [x] Heap tests cover immutable commit, deterministic reachable
      cell/logical-byte limits, transient-transaction limits, unreachable transaction
      allocations, sealed-args alias rejection, active-transaction reads,
      active/prepared/terminal transitions, stale aborted/reused/cross-arena/
      wrong-descriptor refs, frozen commit closure, commit-root versus
      safety-root accounting, safe-point collection, bind abort-only allocation,
      sharing, disposal, and separate fixed Ring-value versus variable Heap
      accounting.
- [x] Conformance includes concrete `UserType -> collection` and
      `collection<UserType>` Tea cases, plus same-iteration and historical COW
      traces under `tests/fixtures/execution/`.
- [x] Run:

      ```sh
      # From the repository root:
      NODE_OPTIONS=--max-old-space-size=8192 npm run check
      ```

      The standalone repository gate passes: compiler and website typechecks,
      all 525 tests, generated-reference checks, and the Docusaurus production
      build.

## 5. Explicit follow-ons, not V1 assumptions

- Decide whether Tea adopts recursively usable Go-style zero values. Until
  then, `na` user/collection values retain the current typed-empty behavior.
- Design a safe explicit pointer type, including pointee mutation, history,
  rollback/`varip`, equality, cycles, and GC. Do not prebuild these semantics as
  hidden behavior of ordinary user types.
- Decide whether indexing becomes a writable place. The current accessor API
  remains value-returning get-modify-set.
- Specify structural equality/deep serialization independently of physical
  sharing.
- Expose array capacity only through a separate source-language proposal; it
  is intentionally private in V1.
