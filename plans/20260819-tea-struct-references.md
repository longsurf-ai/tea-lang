# Tea struct references and unified Heap storage

Status: implemented for the CPU pipeline on 2026-08-19. WGSL struct-reference
lowering remains intentionally deferred and fails closed.

This plan replaces Tea's Go-like value semantics for nominal structs with
reference semantics and standardizes the compiler vocabulary on `Struct*`.
It deliberately keeps collection values as versioned headers.

This plan supersedes:

- the user-type value-copy, inline-record, rooted-rebuild, and future-pointer
  sections of
  [collections, user types, and heap storage](20260809-tea-collection-user-types-heap.md);
- the copy-in/copy-out receiver and deep-`const` portions of
  [struct methods and implicit `this`](20260811-tea-struct-methods-implicit-this.md).

It preserves the existing collection contracts, deterministic limits,
transaction state machine, request-context ownership, compiler pipeline, and
generated-artifact boundary except where this plan explicitly changes them.

GPU struct lowering is not part of this implementation. The WGSL backend must
fail closed on the new struct-reference operations until a separate GPU plan is
written after CPU lowering is complete.

## 1. Objective

Tea should have one small, uniform semantic model:

```text
Name owns Ring<Value>

Value =
  scalar
  collection header
  StorageRef
  tuple transport
  resource handle
  ...

history(name, k) = name.ring.at(k)
```

A nominal `struct Foo` value is a `StorageRef` whose Heap cell contains Foo's
field storage. Assignment, arguments, returns, fields, tuples, and collection
elements copy that reference. Mutating a field changes the referenced storage,
so every alias observes the change. Rebinding one Name changes only that Name.

Collections retain their existing value contract. A collection value is a
small header whose backing is also reached through `StorageRef`; a collection
mutator builds replacement backing and stores a replacement header into one
writable location. Copying a collection header never creates struct-reference
semantics for the header itself.

The runtime owns one memory framework:

```text
HeapArena
  StorageRef -> StorageCell

HeapTransaction
  allocation
  transactional mutation
  prepareCommit
  commit | abort
  reachability and deterministic limits
```

There is no `ObjectRef`, `ObjectStore`, `MemoryTransaction`, source pointer
type, or parallel object heap.

## 2. Chosen source semantics

### 2.1 Struct vocabulary and syntax

`struct` is the canonical language and documentation term.

```tea
struct Point
    float x
    float y
```

The compiler vocabulary changes atomically:

```text
UserType                   -> StructType
UserField                  -> StructField
UserTypeDecl               -> StructDecl
UserTypeMember             -> StructMember
UserTypeObject             -> StructObject
GenericUserTypeObject      -> GenericStructObject
TypeKind.UserType          -> TypeKind.Struct
ObjectKind.UserType        -> ObjectKind.Struct
ObjectKind.GenericUserType -> ObjectKind.GenericStruct
NewUserValue               -> NewStruct
NewUserValueExpr           -> NewStructExpr
UserTypeLayoutId           -> StructLayoutId
UserTypeValue              -> StructValue during the vocabulary migration;
                              removed when a struct value becomes StorageRef | null
EffectUserTypeValue        -> EffectStructValue
'user-type' ABI/schema tag -> 'struct'
```

The rename applies to syntax, checker, Program IR, noder, codegen, runtime ABI
and layouts, generated references, diagnostics, tests, fixtures, examples, and
owning `AGENTS.md` files. It does not mechanically rename unrelated phrases
such as "user error" or "user code."

Block-form `type Foo` remains a parser-compatible spelling in this cut and
produces the same `StructDecl` with `writtenKeyword: 'type'`. Authored docs and
new examples use `struct`. Removing block-form `type` is a separate source
compatibility decision; `type Foo = Bar` remains reserved alias syntax.

Runtime representation names describe physical roles, not source types.
`StructType` is a nominal compiler type; `StorageRef` is the runtime carrier.

### 2.2 Construction, aliasing, and rebinding

Every successful evaluation of `Foo.new(...)` allocates a fresh Heap storage
identity:

```tea
Foo a = Foo.new(1)
Foo b = a

b.x := 2
// a.x == 2: a and b carry the same StorageRef.

b := Foo.new(3)
// b now carries a fresh StorageRef; a still carries the first one.
```

The uniform call-by-sharing rules are:

1. A struct variable contains `StorageRef<StructStorage> | null`.
2. Assignment copies the reference.
3. Passing a struct argument copies the reference; rebinding the callee's
   parameter does not rebind the caller, while field mutation is shared.
4. Returning a struct, placing it in a field or tuple, and inserting it into a
   collection copy the same reference.
5. Struct construction is a runtime allocation, produces a `series` result,
   and is never constant-folded or evaluated during module bind.
6. Merely transporting an existing reference does not invent a second
   reference-specific qualifier axis. Field selections and instance-method
   calls that can observe the mutable body are `series`, independent of which
   alias performs a write. This avoids syntactic-root mutation promotion while
   keeping reference identity and mutable body availability distinct.

No implicit or explicit struct copy operation is added. A future freeze or
snapshot operation must have explicit source syntax and a separate contract.

### 2.3 Methods and shallow `const`

`this` denotes the receiver's `StorageRef`. Mutable methods mutate receiver
storage in place and return only their declared result; they do not return a
replacement receiver and callers perform no copy-out.

Trailing `const` is deliberately shallow:

```tea
struct Child
    int value

struct Parent
    int value
    Child child
    array<int> samples

    void inspect() const =>
        this.value := 1          // error: writes a direct receiver field
        this.child := Child.new(2) // error: replaces a direct receiver field
        this.samples.push(3)     // error: replaces this.samples header
        this.child.value := 4    // allowed: mutates a referenced Child object
```

`const` does not freeze the transitive object graph and does not introduce a
deep-readonly type. V1 retains the existing non-escaping source restriction on
bare `this`; making `this` freely storable/passable/returnable is a later,
separate surface decision. No interprocedural deep-mutation analysis is added
in this cut.

Mutable methods are valid on every non-`na` struct reference expression,
including a reference returned from a collection accessor or history read:

```tea
points.get(0).move(1)
foo[1].move(1)
```

A mutable method invoked through `na` fails before its body executes.

### 2.4 `na`, equality, and recursion

`na` is the null struct reference.

- Reading a field through `na` keeps Tea's existing behavior and yields the
  field layout's typed empty value.
- Writing a field or invoking a mutable method through `na` raises the stable
  runtime error before evaluating the right-hand side or explicit arguments.
- `na(value)` detects a null struct reference.
- Struct `==`/`!=` remains unsupported in this cut. Identity equality can be
  proposed separately.

Direct and mutual recursive struct declarations become finite and legal:

```tea
struct Node
    Node next = na
```

The field contains a nullable `StorageRef`; it does not inline another Node
body. Runtime tracing must tolerate cycles.

### 2.5 Collections and struct references

Collection headers retain value semantics:

```tea
a = array.from(1)
b = a
b.push(2)

// a is [1]; b is [1, 2].
```

A collection field stores its header by value:

```tea
struct Foo
    array<float> arr

var a = array.new<float>(1, na)
var foo = Foo.new(a)

foo.arr.set(0, close) // replacement header is stored in foo.arr
a.push(1.2)           // replacement header is stored in a

plot(foo.arr.size())  // 1
plot(a.size())        // 2, 3, 4, ...
```

A collection of structs stores references:

```tea
point = Point.new(1)
points = array.from(point)
copy = points

copy.get(0).x := 9
// point.x, points.get(0).x, and copy.get(0).x are all 9.
```

Historical collection headers preserve historical membership and ordering,
not transitive struct bodies:

```tea
old = points[1]
old.get(0).x := 10 // legal: get returns a live struct reference
points[1].push(Point.new(2)) // error: historical collection header is an rvalue
```

Nested collection rvalues remain non-writable:

```tea
outer.get(0).push(1) // error when get(0) returns an array header
```

But a collection field reached through a struct reference is a writable
location:

```tea
points.get(0).samples.push(1) // legal; replaces that struct's samples field
```

### 2.6 `array.new<T>(size)`

Tea adds the sized overload with a typed-empty default:

```tea
array.new<float>(3) // [na, na, na]
array.new<Foo>(2)   // [na, na]
array.new<bool>(2)  // [false, false]; bool's typed empty is false
```

The public signatures become:

```text
array.new<T: storable>()
array.new<T: storable>(size: int, initial: T = na)
```

When `initial` is omitted, runtime collection construction obtains the element
layout's typed empty from `ValueLayoutRegistry`; it does not rely on an
untyped JS `null`. An explicit type argument or an already-supported expected
type context must determine `T`; `array.new(3)` still fails when `T` cannot be
inferred.

### 2.7 History versions bindings, not struct bodies

Every runtime variable follows the ordinary Ring machinery. There is no
StructType-specific history branch.

```text
foo Ring: [..., S3, S7, S7]
```

`foo[k]` reads the committed `StorageRef` at offset `k`:

- if `foo` was not rebound, current and historical cells may contain the same
  reference and therefore observe the same live body;
- if `foo` was rebound, history may contain a different, older reference;
- Heap reachability keeps every referenced body alive while any Ring,
  collection, struct field, request result, package global, or transaction root
  retains it.

History syntax applies only to a direct readable source binding. The checker
rejects computed operands and noder never creates a hidden synthetic history
slot:

```tea
foo[k]             // valid
foo[k].x           // valid
foo[k].x := 3      // valid; the historical reference is live

foo.x[k]           // invalid
Foo.new(1)[k]      // invalid
points.get(0)[k]   // invalid
f()[k]             // invalid
(a + b)[k]         // invalid
```

To retain observations rather than a struct body, bind the observation to a
Name explicitly:

```tea
x = foo.x
oldX = x[k]

xs = foo.arr
oldXs = xs[k]
```

The existing computed-expression `$hist` lowering is removed for every type,
including the offset-zero bypass. Direct catalog bindings that already project
to an IR `Place` retain their normal history behavior; calls, arithmetic,
conditions, field selections, and collection accessors do not acquire hidden
Names.

### 2.8 Realtime, `var`, and `varip`

Struct storage mutations are intrinsically intrabar-persistent after every
successful provisional execution:

```tea
struct Counter
    int value

var counter = Counter.new(0)
counter.value := counter.value + 1
plot(counter.value)
```

Successive successful ticks on one realtime bar publish `1`, `2`, and `3`.
Each successful provisional transaction commits the storage mutation. A failed
or suspended tick aborts only that tick and restores the field values present
at its start; retry begins from the most recent successful provisional state.

`var` and `varip` continue to govern Ring binding/rebinding and initialization,
not the body of storage reached through a reference. Aliases with different
storage classes still see one body.

To make the example true even when the first execution occurs on an
unconfirmed row, successful first initialization of an ordinary persistent
`var` retains a same-row initialization candidate: its initialized bit and
initializer value seed later ticks of that row. Subsequent ordinary `var`
reassignments still roll back between ticks; only the first successful
initialization is retained. This is a general persistent-initialization rule,
not a StructType special case. Failure or suspension before successful
initialization retains no candidate.

### 2.9 Requests, package globals, and effects

Root and request-child runtimes already share one Heap arena. Struct
`StorageRef`s therefore cross request results without a second ownership
domain. Request result Rings/views/builders are Heap roots. If several result
rows contain the same reference, they observe the same live body; parent-side
mutation changes that same storage.

Package-global struct construction remains per bound runtime/context/job, never
module-singleton state. Returning a package-global struct exposes a mutable
alias to its body even when the package-global Name itself is private.

Effects remain immutable transport snapshots. `emitEffect` dereferences struct
storage and recursively materializes `EffectStructValue` at the emission call,
before any later same-row mutation. It never buffers a live `StorageRef` for a
sink. Recursive struct payload types remain rejected because fixed transport
cannot serialize an unbounded cycle.

Dense output channels continue to reject aggregate/struct ownership until a
separate lease or serialization contract exists.

## 3. Unified Heap model

### 3.1 One reference and one cell arena

`StorageRef<TPayload>` is the only runtime memory handle. Struct variables,
struct fields, collection elements, and collection headers all ultimately
reach Heap cells through this same handle type.

The current Heap-wide immutability assumption is removed. Immutability remains
a collection-storage policy:

- collection implementations never mutate committed backing and allocate
  replacement cells;
- struct implementations mutate committed field storage only through the
  current `HeapTransaction`;
- the Heap owns identity, validation, transactions, reachability, and limits
  for both.

Conceptually, cells have descriptor-specific payload behavior:

```text
StorageCell
  version
  descriptor
  payload
  logicalBytes
  state: tentative | committed
  transactionId?
```

Examples:

```text
StorageRef S1 -> ArrayStorage payload [1, 2, 3]
StorageRef S7 -> StructStorage(Foo) payload fields [x, arr, ...]
```

The existing `version` name remains the slot-reuse guard. It is not a historical
body version: when a slot is reclaimed and reused, incrementing `version`
invalidates stale refs; a live struct cell has one mutable body and no per-bar
version chain.

### 3.2 Descriptor contract

`StorageDescriptor` remains the owner of payload validation, tracing, and
logical-byte accounting. The framework must no longer require every descriptor
to return a recursively frozen payload.

Collection descriptors retain sealed persistent payloads. Struct storage owns
an exact layout plus field vector validated against `ValueLayoutRegistry`.
Heap mutation is descriptor-driven rather than struct-aware. Conceptually, a
descriptor that admits mutation defines how to validate an opaque edit, derive
its stable transaction-journal key, apply it, and restore its opaque undo
value. `StructStorageDescriptor` uses the field index as that key and owns
field-layout/value validation. Collection descriptors expose no mutation edit
and continue to allocate replacements. Both forms return and consume the same
`StorageRef` and participate in the same Heap transaction.

Edit validation and undo capture finish before mutation. Descriptor `apply`
and `restore` operations are nonthrowing once validation succeeds. An in-place
edit must preserve the cell's owned `logicalBytes`; an operation that changes
variable-sized owned storage allocates a replacement cell instead. These rules
keep prepared commit nonthrowing and Heap limit accounting stable.

No mutable payload alias may escape to generated code or collection
implementations. Reads return values or controlled readonly views; writes cross
one checked HeapTransaction operation so journaling cannot be bypassed.

### 3.3 HeapTransaction

The existing transaction state machine remains the single runtime-memory
lifecycle:

```text
active -> prepared -> committed
   \----------------> aborted
```

It expands from allocation-only storage to allocation plus transactional
mutation:

```text
HeapTransaction
  allocate storage cell
  mutate(ref, descriptor, opaque edit)
  prepareCommit(roots)
  abort
```

Heap itself does not interpret a struct field. For a committed mutable cell,
the first write to `(StorageRef, descriptor-provided journal key)` in a
transaction records the descriptor's opaque undo value. Repeated writes with
the same key do not duplicate the undo entry. Abort asks the descriptor to
restore entries in reverse order; successful commit discards the journal.
`rt.storeStructField` is the StructType-specific adapter that constructs the
descriptor edit.

Tentative struct cells may be initialized and mutated without committed-value
undo, but abort invalidates their refs exactly like tentative collection
storage. A ref may reach another tentative cell only when both belong to the
same active transaction.

`prepareCommit` performs every potentially throwing validation before changing
committed ownership:

- candidate root validity;
- exact struct and collection layouts;
- cross-arena, stale-version, and descriptor checks;
- tentative-reference ownership;
- complete reachable closure;
- retained and transient cell/byte limits;
- a nonthrowing promotion/mutation commit plan.

The prepared commit commits tentative cells and discards the undo journal
without user code between those operations. Abort remains legal from active or
prepared state.

### 3.4 One reachability graph

`StorageTracer` remains a one-reference tracer:

```ts
interface StorageTracer {
  storage(ref: StorageRef<unknown>): void
}
```

Struct descriptors trace StorageRefs held by fields. Collection descriptors
trace StorageRefs held by elements or nested headers. One visited-slot set is
sufficient for arbitrary graphs and cycles:

```text
Ring -> StructStorage -> collection header -> ArrayStorage
     -> StructStorage -> StructStorage -> ...
```

Commit roots and safety roots include:

- current/committed Ring cells selected by storage policy;
- historical Ring cells;
- request result Rings, merged views, and result builders;
- package globals;
- provisional candidates and varip snapshots;
- effect materialization while executing;
- generated-code temporaries for the duration in which collection may safely
  run.

Transaction undo entries, including referenced old values, are transaction-
safety roots only. They are never commit candidates: `prepareCommit` traces the
post-transaction cell graph, while undo values exist solely so active or
prepared transactions can abort. They must not promote otherwise-dead
tentative graphs or count against retained post-commit limits.

Heap collection/GC runs only after a transaction is terminal and no generated
temporary can be the sole owner.

### 3.5 Realtime transaction mapping

The current JSRuntime protocol already provides the correct hook points:

- `executeRow(..., true)` begins a Heap transaction and commits it immediately
  after successful provisional execution, before sink delivery;
- error or `ContextSuspension` aborts the Heap transaction and restores its
  struct field journal;
- final execution prepares Heap state, effects, and Ring candidates;
- `commitRow()` commits prepared Heap state and Rings, then delivers the sink
  publication;
- sink failure is terminal and cannot roll back already committed Tea state.

No second transaction abstraction is added around this protocol.

## 4. Checker and Program model

### 4.1 Checked store locations

The current `CheckedWritebackTarget {root, fields}` assumes immutable struct
records and must be replaced by two concepts:

```text
StructFieldStore
  object expression
  canonical owning StructObject
  canonical FieldObject/index

CollectionLocation
  Name
  | StructField(object expression, owner, field)
```

A struct field store may target any non-`na` struct reference expression:

```tea
foo.x := 1
foo.child.x := 1
points.get(0).x := 1
foo[1].x := 1
```

It does not mark one syntactic root reassigned. Rebinding a Name and mutating
storage are separate semantic facts.

A collection mutator still needs a location for its replacement header. A
Name is written through its Ring slot; a struct field is written through the
captured struct `StorageRef`. A collection accessor result is not a location.

### 4.2 Evaluation order

Field assignment follows reference-property evaluation:

1. evaluate and capture the object expression once;
2. validate non-`na`, descriptor, layout, and field index;
3. evaluate the right-hand side once;
4. validate the field value;
5. journal and store the field through the captured reference.

If the right-hand side rebinds an ancestor Name, the captured object remains
the store target.

For a collection field mutator:

1. capture the target object and current collection header once;
2. evaluate explicit arguments left-to-right;
3. build and validate replacement backing/header;
4. transactionally store the replacement header into the captured struct
   field;
5. yield the mutator's ordinary result.

Argument-side writes to sibling fields survive; the final replacement wins at
the captured collection field.

### 4.3 Program operations

Program describes semantic storage operations without exposing Heap slots or
transaction mechanics:

```text
NewStruct
FieldGet
StoreField
MutateCollection {location, operation, args}
CallMutableMethod {receiver, slot, args}
```

`UpdateValuePath`, `IrValuePath`, recursive record rebuilding, and mutable
method replacement-receiver envelopes are removed. `WriteName` continues to
own declarations and rebinding.

`StoreField` carries the captured object expression, owning StructType/field
identity, and replacement expression. `CollectionLocation` is a location
value, never an effect node or a `StoreField` chain. In `foo.child.arr`, the
object expression is `FieldGet(foo, child)` and the final field is `arr`.

Program continues to contain no `StorageRef`, Heap slot, cell version, payload
layout, undo entry, GC policy, or transaction operation. Codegen maps Program
operations to the generated runtime ABI.

### 4.4 History lowering

Checker history validation first requires a direct readable binding. Offset
zero does not bypass this validation. Noder projects the binding to its ordinary
`Place` and emits `HistRead`; it never synthesizes `$hist` Names.

Depth analysis remains type-neutral. A StructType Name with history depth `N`
allocates the same Ring shape as any nullable fixed-width carrier; runtime
layout charges one StorageRef-sized cell, not recursive struct-body bytes.

## 5. Generated JS ABI and CPU runtime

### 5.1 Runtime value and layout

The runtime `Value` union admits a direct `StorageRef` struct value. Collection
headers continue to carry `StorageRef` backing internally. Layout validation
distinguishes them by the expected layout/descriptor, not by introducing a
second handle class.

Struct layout entries describe nominal type identity and ordered field layouts,
but their shallow Ring size is one reference. Validation of a struct value
checks `null` or the referenced Heap cell's exact struct layout; it does not
recursively inline-validate the body on every Ring write.

`ValueLayoutRegistry` remains the static layout registry; it cannot validate a
direct StorageRef by itself because ref ownership, descriptor, slot, and
version metadata belong to Heap. Runtime value validation therefore gains an
explicit Heap-aware seam (by threading Heap into the relevant validation/root
walk or by an equivalently narrow runtime helper). Struct validation asks Heap
to verify the expected struct storage descriptor/layout, while collection
header validation continues to verify the header and its backing ref. No code
may infer a StorageRef's kind from its host-object shape.

The inline `UserTypeValue {fields}` representation and
`runtime/user-value.ts` rebuild helpers are removed or replaced by struct
storage helpers over Heap.

### 5.2 Runtime ABI

The generated JS runtime surface becomes conceptually:

```text
rt.newStruct(layout, fields) -> StorageRef
rt.structField(ref, ownerLayout, fieldIndex) -> Value
rt.storeStructField(ref, ownerLayout, fieldIndex, value) -> void
```

All three use the current Heap/HeapTransaction. `rebuildUserPath` and
`MutableMethodCallResult {receiver, result}` disappear. Mutable methods return
only their declared result.

The runtime ABI version changes in place; no compatibility branch for the old
inline-record ABI is retained.

### 5.3 Codegen

JS lowering:

- captures field-store receivers before right-hand sides;
- lowers `NewStruct` to `rt.newStruct`;
- lowers `FieldGet` through `rt.structField`;
- lowers `StoreField` through `rt.storeStructField`;
- lowers collection mutation through its `CollectionLocation`;
- passes StorageRefs through calls/returns without copying bodies;
- emits mutable methods as ordinary result-returning functions;
- retains existing source argument and named/default evaluation schedules.

Bind lowering must reject StructType construction/state rather than allocate a
Heap reference inside the abort-only bind transaction. Struct-valued runtime
Names remain per-execution series state.

### 5.4 Requests and effects

Shared request runtimes reuse the root Heap. Result builders and views store
struct StorageRefs as ordinary Values and root them through the existing shared
reachability walk.

CPU effect conversion resolves a struct StorageRef immediately at
`emitEffect`, validates its layout, recursively copies permitted fields into
detached `EffectStructValue`, and records no live Heap ref in the emission
buffer. Abort discards the detached emission with the rest of the transaction.

## 6. Implementation stages

Every stage must preserve unrelated working-tree changes. The source-to-Program
pipeline remains `load -> imports -> check -> noder`; `src/main.ts` and
`src/compile.ts` do not acquire alternate struct compilation paths.

### Stage A: Rename vocabulary without changing value semantics

1. Add supersession pointers from the two older plans to this proposed plan;
   `docs/memory-model.md` remains the implemented semantic authority until the
   later atomic reference switch.
2. Perform one mechanical, behavior-preserving vocabulary migration from
   `User*`/`user-type` to `Struct*`/`struct` across syntax, checker, IR, noder,
   codegen, runtime, docs, examples, diagnostics, and tests.
3. Temporarily rename the current inline runtime representation
   `UserTypeValue` to `StructValue`, `user-value.ts` to `struct-value.ts`, and
   `newUser`/`userField`/`rebuildUserPath` to their `Struct` equivalents. The
   later reference switch deletes the inline `StructValue` and rebuild path.
4. Rename manifest/effect/schema tags from `'user-type'` to `'struct'` and bump
   the runtime ABI in this stage because that tag change is externally
   observable even though source value behavior is unchanged.
5. Update authored documentation terminology while preserving its current
   implemented value-semantic statements, then regenerate public references
   and editor vocabulary.

Primary files:

- `src/syntax/{nodes,parser,dumper}.ts`
- `src/checker/{object,info,scope,package,check,binding,type-catalog}.ts`
- `src/ir/{type,node,program,visit,dumper,frames}.ts`
- `src/noder/{noder,depth,depth-walk}.ts`
- `src/codegen/**`
- `src/runtime/{value,value-layout,module-abi,abi}.ts`
- `website/scripts/generate-reference.ts`
- tests, fixtures, docs, examples, and `AGENTS.md` files that own those names

Acceptance:

- behavior remains value-semantic until the later semantic switch;
- every test passes after the rename;
- a scoped repository search finds no live semantic identifier, lower-camel
  helper/local, filename, diagnostic, or ABI/schema tag built from
  `UserType`, `GenericUserType`, `NewUserValue`, `UserTypeLayout`,
  `userType`, `newUser`, `userField`, `rebuildUserPath`, `user-value`, or
  `'user-type'`. The audit includes WGSL/compiler locals such as
  `userNames`/`userTypes`/`userName` and filenames such as
  `collections-user-types.test.ts`; unrelated phrases such as "user code" and
  "user error" are deliberate exclusions;
- historical superseded plan prose may retain old names only inside clearly
  marked historical sections.

### Stage B: Close adjacent surface contracts

1. Add `array.new<T>(size)` in `src/checker/catalog.ts` and implement its
   element-layout typed-empty construction in
   `src/runtime/collections/array.ts`; update generated reference docs and
   checker/runtime tests.
2. Restrict history to direct readable bindings and remove synthetic `$hist`
   lowering, tests, fixtures, and IR documentation.

Acceptance fixtures lock each rule independently before Heap representation
changes.

### Stage C: Generalize Heap storage transactionally

1. Preserve the current `HeapTransaction` state machine and `version` guard.
2. Generalize Heap cells/descriptors so the framework does not require every
   payload to be recursively frozen.
3. Add generic descriptor-driven mutable storage allocation/edit primitives
   and Heap-aware descriptor/layout validation; Heap itself must not recognize
   a struct field.
4. Add transaction-only mutation with descriptor-provided journal keys and
   opaque undo values.
5. Extend prepare/abort/commit to tentative mutable storage allocation and
   committed-cell mutation.
6. Make tracing and logical accounting cover one arbitrary StorageRef graph.
7. Add deterministic struct storage and transaction-journal limits where the
   existing global/transient Heap limits are insufficient.

This stage is runtime-internal and receives direct Heap unit/property tests
before generated code can use it.

### Stage D: Atomically switch checker, IR, JS runtime, docs, and WGSL gate

This stage is one atomic green vertical switch; none of its semantic pieces may
land while another backend still executes the old inline value model.

1. Rewrite `docs/memory-model.md`, `docs/ir.md`, `docs/runtime.md`, conformance
   docs, and owning `AGENTS.md` invariants to make reference semantics the
   implemented authority.
2. Split checked struct field stores from collection replacement locations;
   permit field mutation through locals, parameters, fields, collection
   accessors returning structs, request/history refs, and mutable receivers.
3. Stop marking a root Name reassigned for body mutation; make constructors,
   field reads, and instance calls obey the qualifier rules in section 2.2.
4. Change receiver checking to shallow `const` now that nested structs are
   references.
5. Remove direct/mutual inline struct-cycle rejection and
   `ValueLayoutRegistry.rejectInlineLayoutCycles` for struct-reference edges,
   while retaining function recursion rejection and cycle-safe effect-schema
   rejection.
6. Replace `UpdateValuePath`/`IrValuePath` with `StoreField` and
   `CollectionLocation`; remove mutable-method copy-out from checker facts,
   Program functions, depth analysis, visitors, dumper, and generated ABI.
7. Preserve receiver/argument/RHS evaluation order exactly.
8. Make runtime StructType values direct StorageRefs, add
   `newStruct`/`structField`/`storeStructField`, and write collection
   replacements through Name or struct-field locations.
9. Update Heap-aware runtime validation and root projection for Rings,
   requests, globals, effects, commit candidates, and transaction-safety
   values. Undo-old values are safety roots, never commit candidates.
10. Remove inline `StructValue` records and recursive rebuild helpers; bump the
    runtime ABI again and update portability/invariant tests.
11. In the same change, make WGSL eligibility reject every reachable StructType
    operation with one stable staged-unsupported issue. Old inline WGSL struct
    lowering must become unreachable before the CPU switch is mergeable.
12. Extend Ring initialization state with the same-row ordinary-`var`
    initialization candidate specified in section 2.8. Preserve only the first
    successful initializer value/initialized bit; abort before success retains
    nothing, and later ordinary-`var` reassignments still roll back. Include the
    candidate in provisional Heap commit roots, then clear/promote it correctly
    on abort, final commit, frame deactivation, and disposal.
13. Retarget every existing unit, golden, example-compilation, and hash-pinned
    execution-conformance case required to keep the repository green under the
    new semantics, including the aggregate-values oracle, manifest hash, WGSL
    eligibility expectations, and struct-heavy GPU integration expectations.

### Stage E: Post-switch hardening and additional coverage

Stage D leaves no failing pre-existing test, fixture, example compilation, or
GPU expectation. Stage E adds audits and coverage that are useful for closure
but are not deferred repairs required to make the semantic switch green.

1. Replace `examples/language/value-semantics.tea` with a focused
   struct-reference teaching example.
2. Audit `broker.tea`, `portfolio.tea`, and `trade.tea` for newly shared aliases,
   event snapshot timing, and shallow-const expectations.
3. Audit package globals and request fixtures for shared StorageRef ownership.
4. Add explicit coverage beyond the minimal atomic-switch rewrites for cases
   that formerly required get-modify-set for structs in collections,
   immutable nested-record rebuilding, historical record bodies, or mutable
   receiver copy-out.
5. Add CPU realtime/suspension and memory-pressure tests before claiming
   completion.

### Stage F: Stop at the CPU boundary

After CPU conformance is green and WGSL fails closed, stop. Remove no additional
GPU capability. Handle packing, allocation budgets, recursive structs, effect
readback, and GPU collection storage belong to a later GPU plan after CPU
behavior and measurements are stable.

## 7. Verification matrix

### 7.1 Syntax and naming

- `struct Foo` parses to `StructDecl`.
- compatible block-form `type Foo` also parses to `StructDecl`.
- `type Foo = Bar` remains a separate alias node/error path.
- AST/IR dumps and diagnostics use `Struct`, never `UserType`.
- generated docs list structs and the new `array.new(size)` signature.

### 7.2 Reference behavior

- assignment shares field mutation;
- rebinding does not change earlier aliases;
- arguments and returns share field mutation but parameter rebinding is local;
- tuple and struct-field transport copy StorageRef;
- every successful constructor evaluation creates a distinct ref;
- `na` field reads return typed empty; writes/mutable calls fail before RHS or
  explicit argument effects.

### 7.3 History

- `foo[k]` reads the exact historical Ring reference;
- unchanged bindings produce the same ref across cells;
- rebinding produces different historical/current refs;
- mutations through historical refs affect every alias to that storage;
- `foo[k].x` is valid and `foo.x[k]` is rejected;
- computed-expression history and hidden `$hist` Names are absent;
- historical refs keep storage reachable until the final owning cell leaves
  the root graph.

### 7.4 Collections

- collection assignment remains header-value semantics;
- a struct collection field captures a header independently of another Name;
- collection-of-struct copies/histories preserve reference membership;
- `points.get(0).x :=` and `points.get(0).samples.push` are legal;
- collection rvalue mutation remains illegal;
- `array.new<T>(size)` fills with exact typed empty for every storable layout;
- failed collection replacement plus struct-field store aborts atomically.

### 7.5 Heap transactions and GC

- tentative collection and struct cells commit or become stale together;
- first write to a field journals once;
- repeated writes abort to the transaction-entry value;
- abort from active and prepared states restores committed struct fields;
- successful commit retains field changes and drops undo entries;
- wrong descriptor/layout, cross-arena, forged, stale-version, and
  tentative-from-other-transaction refs fail deterministically;
- a prepare-limit failure followed by abort leaves no lasting committed
  mutation;
- struct/collection cycles collect when unreachable and survive when rooted;
- undo-old referenced values are transaction-safety roots, never commit
  candidates.

### 7.6 Realtime and suspension

- an already committed Counter ref produces `1, 2, 3` over successful ticks;
- first successful ordinary-`var` initialization on an unconfirmed row retains
  its same-row initialization candidate and also produces `1, 2, 3`;
- failure/suspension before first successful initialization retains no
  candidate;
- a failed/suspended tick after `2` restores `2`, and retry resumes from `2`;
- `var` and `varip` aliases observe the same committed body;
- rebinding follows existing `var`/`varip` Ring rules after the new
  initialization-only candidate is established;
- no aborted allocation or mutation appears in output/effects/history;
- final sink failure remains terminal after internal commit.

### 7.7 Requests, globals, and effects

- request result builders/views root struct StorageRefs;
- parent mutation of a returned ref is visible through aliases to the same
  child-created storage;
- request suspension aborts struct and collection mutations together;
- package-global struct state is isolated per binding/context/job;
- effects snapshot struct fields at emit time and cannot observe later mutation;
- recursive struct effect payload types fail closed.

### 7.8 Commands

At each green stage run the focused owner tests, then finish with:

```sh
bun run typecheck
bun test
bun run test:gpu
bun run docs:check
git diff --check
```

After manifest or dependency changes, also run the repository's standalone
install/typecheck validation. No execution-conformance reference is generated
automatically; every changed oracle remains independently derived and
hash-pinned.

## 8. Completion criteria

The migration is complete only when:

1. `StructType` is the sole compiler vocabulary for nominal structs.
2. A struct runtime value is only `StorageRef | null`; no inline struct record
   or second reference class remains.
3. Every Name, including StructType Names, uses the ordinary Ring/history path.
4. Struct bodies mutate through the one HeapTransaction and survive successful
   provisional ticks.
5. Failed/suspended transactions restore struct fields and discard tentative
   storage.
6. Collections retain header value/history semantics while struct elements
   retain reference semantics.
7. One StorageRef graph owns tracing, cycles, limits, and reclamation.
8. Mutable methods have no copy-in/copy-out path.
9. CPU requests, package globals, effects, batches, and conformance exercise
   the new semantics.
10. WGSL fails closed rather than executing the old value model.
11. All validation commands pass in the standalone checkout.

## 9. Explicitly out of scope

- GPU struct/object-table lowering
- GPU collections or GPU garbage collection
- freeze/snapshot syntax or historical struct-body versions
- source pointers, address-of/dereference, or pointer arithmetic
- struct identity equality
- deep/transitive `const`
- a first-class readonly reference type
- making collection headers reference-semantic
- removing compatible block-form `type Foo`
- collection structural-sharing optimizations unrelated to this semantic switch
- exposing Heap slots, StorageRef versions, or physical placement to Tea source
