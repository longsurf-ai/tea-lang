---
title: The Tea IR
sidebarTitle: Tea IR
---

How Tea represents semantics between the syntax tree and generated code. This
document is the source of truth for the middle end; `src/ir/` implements it.
Execution — JS/GPU binding, runtime state, batching, physical buffers, and
publication — is owned by [runtime.md](runtime.md).

## Pipeline vocabulary

```text
Compilation                                  Bind-independent lowering
source ─ parse ─ check ─ buildProgram ─▶ Program ─┬─▶ TypeScript module
         syntax  typecheck   noder                └─▶ WGSL module + layouts
                                                       codegen

TypeScript  + DataStreams  ─▶ Node / Context ─▶ Batch Recipe
WGSL module + GpuBinding[] ─▶ GPU buffers       ─▶ dispatch / readback
```

- **Noding** (`noder.buildProgram`) turns checked syntax into the Program.
- **Lowering** is Program → target artifact in `src/codegen/`. Both JS and WGSL
  lowering are bind-independent: they receive no dataset, binding grid, result
  capacity, or device. The target runtime supplies those facts later.
- The checker is a separate semantic pass over syntax (the types2 shape); the
  noder consumes the checked package and its exact per-context facts and never
  re-checks.

### Semantic package and occurrence facts (`src/checker/`)

`Package → Scope → Object → Type` is the checker source of truth. A package
owns its files, package scope, and imports; persistent scopes map source names
to canonical semantic objects; those objects represent variables, function
templates, structs and fields, enums and members, package names, and
builtins. The shared type domain describes their value types. This graph
answers _what a declaration is_ without embedding Program objects or runtime
layout.

`Info` answers _what each syntax occurrence means_. It records expression
types, definitions, uses, selections, scopes, calls, and reassignment for one
semantic checking context. The package root, each function instance, and each
request capture retain the exact `Info` in which they were checked. A request
capture's facts are semantic context, not physical Program identity; the noder
may project the same semantic objects into multiple Programs.

Every call occurrence has one discriminated `CallResolution`: native,
function, constructor, or request. A `StructObject` owns its nominal
`StructType` and ordered `FieldObject`s; each field owns its checked default
expression together with the `Info`, `TypeAndValue`, and semantic dependency
set that interpret it.
Constructor resolution aligns every supplied or defaulted argument to a field,
joins their qualifiers, and applies capture policy only to defaults actually
used by that call. Request resolution owns its capture facts and result type.
There are no parallel call maps or root-global struct-default/capture tables.
A struct-field update records the checked receiver expression plus its
canonical owning StructObject and FieldObject. A collection mutator records a
replacement location: a Name or one collection field reached through a struct
reference. Rebinding and storage mutation are different facts.

The boundary is strict: checker results contain no `IrName`, `SeriesInput`,
`BuiltinInput`, `ParamInput`, `RequestEdge`, `HistoryDepth`, slot, or frame.
The noder creates those backend representations at the Program boundary.
Only the closed identifier vocabulary in `ir/builtin.ts` and the shared type
domain in `ir/type.ts` cross into the checker; backend nodes and Programs do
not.

## The one invariant above all others

**The compiler describes; the runtime implements.** The Program is a complete
static description — slots, storage classes, qualifiers, bind-resolvable
history depths, request edges, output declarations. All Time Machine
mechanics — ring buffers, copy-on-write epochs, commit/rollback, provisional
overlays — are runtime-owned. The IR never encodes buffer layouts or COW
strategy, so runtime implementations can evolve freely against a stable
Program format.

## Type domain (`src/ir/type.ts`)

One type system shared by checker, IR, and Program (deliberately unlike Go's
historical types2/types split). A Tea type is a point on two axes:

- **Value types**: primitives (int, float, bool, string, color), drawing
  handles (line, label, box, table, polyline, linefill), collections
  (`array<T>`, `matrix<T>`, `map<K, V>`), nominal struct-reference types and
  enums (identity by declaration), tuples, concrete function signatures, plus
  `void` (effect calls) and `na` (the polymorphic empty value; assignable to
  every nullable type).
- **Qualifiers**: `const < input < simple < series` — an ordering answering
  _when the value becomes known_: compile time, bind time, before the first
  bar, per bar. Combining expressions takes the later-known qualifier of the
  operands; a native call's result qualifier is whatever the catalog
  declares (`close` is series, `input.int(...)` is input). History is a
  property of this axis: only series-qualified values have a time
  dimension.

`TypeAndValue {type, qualifier, value?}` is the checker's currency (types2's
`TypeAndValue` with Tea's extra axis). `TypeKind.Invalid` is the checker's
poison (types2's `Typ[Invalid]`): assignable both ways and absorbed by
unification so one error never cascades, and barred from Programs by the
check phase barrier. The sole implicit conversions:
int → float, and `na` → any nullable type — where, per Pine v6, **bool is
never nullable** (na does not assign to or unify with bool), and neither are
void and function types. `na` itself is a first-class constant (`NA_VALUE`, a
branded singleton — not null, so "no constant" stays distinguishable in
`TypeAndValue`). Numeric `NaN` is a runtime encoding only; the checker
canonicalizes every folded non-finite result to `NA_VALUE`. Noding then gives
each `NA_VALUE` the concrete nullable type supplied by its declaration, branch
join, or call parameter. `TypeKind.Na` is therefore checker-only and never
appears in a Program.
Visual descriptions are ordinary library-defined struct values. Their output column
identity is a compile-time string, and the compiler has no Plot/Hline reference type.

## Program (`src/ir/program.ts`)

A Program is _a bar loop over one context_ — one symbol × timeframe axis —
owning the following backend resources. The noder is their sole creator: its
per-Program context projects `VariableObject → IrName` and each
`BuiltinObject` through its checker-owned binding to either `SeriesInput` or
`BuiltinInput`, creates `ParamInput` and `RequestEdge` objects, mints slots
and synthetic names, establishes static frame layouts, and hands the resulting
places to its depth pass for annotation.

- **params**: `input.*` declarations. Noding extracts the declaration
  (name, type, default, const-required constraints, and host-facing UI
  metadata including `display`); the **value arrives at bind time from the
  runtime**. Each syntax call extracts once globally even from a local block,
  non-exported UDF, or scalar request capture. A program-scope declaration
  supplies the parameter identity; local declarations use a collision-free
  `input@line:col` identity while retaining their spelling as the inferred UI
  label. Source inputs inside request captures are rejected because their
  series binding is context-owned. That is what the `input` qualifier means.
  For supported input forms, extracted numeric
  constraints and concrete UI metadata survive into the compiled module.
  Range constraints and options are a discriminated union, so a parameter
  cannot carry both. Options are direct, non-empty, homogeneously typed tuples
  whose default is a member; numeric defaults and ranges are concrete and
  internally consistent. `display` is always one of the four input display
  values (including its catalog-owned default), while `active` remains an
  input-qualified IR expression evaluated from the bound parameter values.
  The checker rejects `active` dependencies on a function/capture execution
  frame because the global parameter is bound without that frame. No input
  default or metadata value may be `na`.
- **numeric series inputs** (a projection, not a field): `open`, `high`,
  `low`, `close`, `volume`, and the derived price sources are numeric columns
  supplied by application DataStreams. The checker catalog binds them
  explicitly as series; the noder interns one `SeriesInput` for each used
  builtin in each Program. `input.source` is restricted to this closed
  vocabulary. Neither noder nor runtime classifies a builtin by parsing its
  spelling.
- **typed builtins** (also a projection): `time`, `time_close`,
  `timenow`, `bar_index`, `last_bar_index`, `barstate.*`, `syminfo.*`, and
  `timeframe.*` are typed values supplied by the runtime context rather than
  numeric series columns. They project to `BuiltinInput`, which carries
  source, type, qualifier, and depth. Its source is a closed `{domain, field}`
  key. The domain is only the builtin namespace (`time`, `bar`, `barstate`,
  `syminfo`, or `timeframe`); it never implies a corresponding compiler or
  runtime context object. Parent and request-child Programs project their own
  carriers even when they use the same semantic `BuiltinObject`.
- **names**: variables in a Program are `Name` objects — the `ir.Name` model.
  The noder projects a semantic `VariableObject` to one Name per Program
  context, referenced directly from every IR use. A checker object and an IR
  Name are deliberately different abstractions, and parent/request-child
  Programs never share mutable Names. There is no id and no top-level variable
  table (enumerations for allocation or serialization are projections derived
  by walking, produced at the boundary that needs them — exactly how Go keeps
  a pointer graph in memory and lets the unified-IR writer assign indices at
  the boundary). A Name carries storage (`perBar` | `var` | `varip` — the
  persistence axis, orthogonal to qualifiers), type and qualifier copied from
  the semantic object, and a **history depth resolvable no later than bind
  time** (non-negotiable):
  `none` (no buffer materializes), `const`, `bound` (an immutable root-safe
  expression no later than `simple`, evaluated at bind), or `capped` (dynamic
  offsets under the generic history cap). A persistent
  declaration is represented separately by `InitName` at its lexical position
  in a body. This keeps evaluation order and control flow explicit: the value
  is evaluated only after execution reaches the statement and the runtime
  reports that the slot is still semantically uninitialized. Depth is owned by
  the noder's depth pass. Series inputs, builtins, params, and request
  results carry the same depth field, so every history demand is resolved
  before execution.
- **outputs**: one source-ordered table of named columns, each with a name,
  mode (`set` or `append`), Tea value type, and source position. `emit "price" close`
  declares a set column; `emit.append "fills" execution` declares a list of the
  expression's type. All sites with the same name must agree on type and mode,
  even when different modes would have the same Arrow shape. Duplicate plain
  writers and potentially repeated set execution within one step are compiler
  errors. Append sites may share a column. Column names must be constant-foldable
  strings; const string arguments permit ordinary library helpers to name outputs.
  Concrete call occurrences contribute emission counts independently even when
  they share a checked function body. Unused templates and method-validation-only
  instances do not declare columns. One `Emit {output, value}` serves both modes.
  The runtime schema projects set values as nullable T and appended values as
  non-null `List<T>`. Missing set and emitted null both yield null; append lists
  preserve their own execution order and contain no global event ordinals.
- **requests**: the recursive edge. The checker records capture semantics in
  the request call's resolution; the noder projects that resolution to a
  `RequestEdge` and compiles its captured expression into a **child Program**
  with its own context, axis, names, series inputs, slots, and rollback. The
  capture facts are not the child Program itself. A request must directly
  initialize one plain top-level variable; that target becomes
  `RequestEdge.name` and the public Node stream-binding identity. Inline,
  tuple, persistent, local, function-owned, and nested request calls fail in
  checking. Constants and direct scalar inputs may cross from the root;
  automatic closure over computed root names is staged and rejected in the
  meantime. The child designates a **result name**
  (`RequestEdge.resultName`, written each child bar) whose type is the scalar
  `captureType`. `request.security` exposes the same `T` as `resultType` with
  Sample mode; `request.security_lower_tf` exposes `array<T>` as `resultType`
  with Collect mode. The edge retains four concrete bind-time option
  expressions (`availability`, `fill`, `ignore_invalid_symbol`, and
  `calc_bars_count`) plus their source evaluation order; omitted options
  normalize to `"end"`, `"carry"`, `false`, and `0`. Currency remains a
  positional but staged source parameter and does not enter the Program until
  its FX/unit model exists. One Program ↔ one context; composition is by
  recursion, never by multi-context Programs. Context arguments must be known
  during binding: constants, inputs, and root-safe `simple` expressions are
  supported. The noder still classifies a series-qualified context as a
  `RequestEdge.dynamic` fact, but fails compilation before that Program reaches
  codegen or runtime. Non-security request
  kinds (financial/dividends/economic) map to edges whose child is a plain
  series-input projection; their extra context args ride the same static shape.
  [Requests](requests.md) owns the detailed Node synchronization and separate
  Pine Batch sample contracts.
- **funcs** (a projection, not a field): semantic function stencils are keyed
  by `(FunctionObject, type + qualifier + folded constant argument values)`, not by a Program or
  request owner. They remain **real functions with runtime call dispatch**;
  inlining is at most a codegen optimization. The same semantic
  `FunctionInstance` may therefore be used while noding multiple Programs,
  but each Program context projects it to a distinct `IrFunc`, Name graph, and
  depth state. Parent and request-child Programs never share those mutable IR
  objects.
  Free functions, const methods, and mutable methods form an exhaustive
  Program union. A method owns one hidden receiver `Name` separate from its
  source-visible `params`; named arguments, defaults, and their canonical
  indices therefore never expose the receiver. State is a **frame tree**: an
  IrFunc's frame layout is its hidden receiver (for methods), explicit params,
  and local Names plus one sub-frame per stateful call site (selected by that
  site's numeric slot); frames nest along the static call graph (acyclic —
  recursion is rejected). `src/ir/frames.ts` is the single target-neutral
  projection of that Name ownership and `(parent frame, call-site slot)`
  topology. JS and WGSL consume it and add only target-specific physical
  layout; the JS runtime may still materialize subframes lazily. Physical
  presence is distinct from transactional activation. Two `ma(close, 10)` call sites share one compiled body
  but own two frames — and two `ema` sub-frames within. Generated TypeScript
  expresses these as separate named entries under `frame.calls`; the slot remains
  a physical address in setup metadata. `ta.*` rides this exact
  path as prelude code; nothing is specialized for technical-analysis
  builtins.
- **init** vs **body**: const/input/simple work hoisted out of the loop vs
  the per-bar step.

## IR nodes (`src/ir/node.ts`)

Typed and resolved: every expression carries `(type, qualifier)`; every use
is a `Place` referencing its projected IR declaration object directly (Name |
ParamInput | SeriesInput | BuiltinInput | RequestEdge — no ids), with
`Read {place}` for current values and `HistRead {place, offset}` for explicit
historical access, and
each use keeping its own position (unlike shared-node designs, diagnostics
never lose the use site). `TupleGet` has no surface syntax: Pine tuples are
destructured immediately, so it appears only in noder-generated lowerings of
tuple patterns. Operations
are a semantic vocabulary (`IrOp.Sub` vs `IrOp.Neg` are different operations
even though both spell `-`; unary `+` is folded away) — the noder maps
surface tokens to operations, and split `IrBinaryOp`/`IrUnaryOp` unions make
an ill-arity op unrepresentable. Control
structures remain expressions (as in the language); flattening is a possible
later pass, not a representation constraint. There are no Bad nodes — the IR
exists only for error-free compilations, enforced by `compile()`'s phase
barriers.

Assignments compose one `Assign {target, value, op}` with writable binding reads
or field selections. The optional compound operator applies to the destination's
captured old value. `NewStruct` describes construction in canonical field order;
`FieldGet` carries a logical field index and works as a read or destination.
Lowering captures and validates a field destination before evaluating its RHS,
so later rebindings cannot redirect the store. Persistent declarations remain
lexical, lazy `InitName` statements.

A collection mutator is a `CallNative` with a writable receiver using the same
destination forms. Lowering captures its old header before explicit arguments,
then stores the returned replacement before yielding the call result. A collection
accessor result alone is not writable. Intrinsic descriptors carry concrete
argument/result types and effects; read/write/allocate calls are not classified
as pure merely because their operands are constant. Native calls have no state
slot; ordinary Tea calls retain per-written-call state.

There are no Program nodes for Heap slots, transaction overlays, commit, abort,
or garbage collection. `Return` exits the enclosing function, including through
loops and persistent-initializer blocks; it never commits independently. Implicit
tail-expression returns remain supported. Main completes without a source return.
Ternary syntax is retained, typechecks both arms, and nodes as a lazy `IfExpr`.
The condition executes once and only the selected arm executes. Its checked
qualifier is preserved, including in bind-time history-depth expressions.

Canonical argument slots and evaluation order are distinct Program facts.
Constructors and calls retain an `argumentEvaluationOrder`: lowering captures
supplied expressions in source order, evaluates omitted user defaults afterward
in canonical parameter/field order, and only then assembles the canonical ABI
argument vector. A method receiver is absent from this schedule and from
`args`; its dedicated call field is always captured once before the scheduled
explicit arguments. Named arguments therefore never reorder observable effects
or failures. A `RequestEdge` retains two independent
schedules: `optionArgumentEvaluationOrder` for its four bind-time options and
`contextArgumentEvaluationOrder` for its parent-owned symbol and timeframe.
There is deliberately no cross-phase schedule. The captured expression is
absent from both because it executes in the child Program rather than the
parent context.

All ordinary function and method invocations use `CallFunc`. The callee owns its
call mode and hidden receiver declaration, separate from source parameters.
A mutable receiver is validated before explicit argument effects; shallow const
permits mutation through child references and is not a purity annotation.

## Primitives vs prelude

A builtin is native only when its operation is inexpressible in Tea: data sources,
context capture, collection operations and scalar intrinsics. `ta`, visual
functions, and trade policy are ordinary Tea libraries. `plot("price", close)`
constructs a library Plot value, executes plain `emit id p`, and returns `p`.
Its constant ID participates in ordinary function specialization; there is no
output-wrapper expansion, special output return type, or compiler interpretation
of visual kinds. Other side-effect libraries use named `emit.append` columns.

The catalog owns primitive signatures, qualifier requirements, expression capture,
and effect classification. Noding preserves the concrete intrinsic contract in
IR-owned facts; it never imports checker objects into the Program. `input.*`
remains parameter declaration syntax through native calls, `request.*` captures
child Programs, and `library()` identifies library modules. Entry programs have
no indicator/strategy headers or program-kind distinction.

## Program fields vs projections

A Program declares its external needs — `params` (bind-time values; an
unused input still renders in the settings UI) and `requests`
(child-Program contexts the runtime must resolve) — and its emissions
(`outputs`, including both write modes), explicitly even where
derivable: the noder populates this interface, and codegen/runtime read what
the program needs from the world here without reinterpreting checker facts.
Context builtins are NOT declared as Program fields: they are available only
when used, and a child context's carriers are a product of its own request
capture. Composition internals — names, funcs, call-site slots — are
projections: `visit.ts` owns the exhaustive traversal and exposes `namesOf`,
`funcsOf`, `slotCountOf`, `seriesInputsOf`, `builtinInputsOf`, and
`requestsOf`. The two input projections become separate id namespaces at the
module boundary; a typed builtin can never become an input-source
series merely because its Tea type is numeric. Request edges the noder finds
unreachable never enter `requests` — dead-request elimination by construction.

## Noding policies

- History requires a direct readable source binding. Noder projects that
  binding to its ordinary Place and emits `HistRead`; calls, field selections,
  arithmetic, and other computed expressions never gain synthetic history
  Names. Offset zero obeys the same admission rule.
- A value-position loop yields the last completed iteration's block value,
  `na` if no iteration completed; `break` skips the current iteration's
  value. A numeric range captures its start, end, and step once, uses inclusive
  endpoints in either direction, and has no language-level trip-count ceiling.
  A compile-time zero step is an error; a dynamic zero, non-finite, wrapping,
  or numerically non-progressing update terminates without wedging execution.
- Struct construction consumes the constructor call's single resolution. Its
  field-ordered arguments include both supplied expressions and field-owned
  defaults; the noder temporarily reads each checked expression's `Info` while
  lowering it into the caller's current Program and frame. Defaults are
  semantic expressions, never prebuilt IR shared across Programs.
- Request captures: the expression re-checks and nodes in a child context.
  Only constants and direct scalar input bindings cross contexts; computed
  root aliases fail closed because the child has no projected root-frame place
  for them. Function instances record exact transitive semantic dependencies:
  context builtins reproject safely in the child, while outer variables must
  be constants or direct scalar input bindings. Bind-time params are
  compilation-global: the child references the parent's ParamInputs and
  declares none of its own. Materializing computed root values in the child is
  a possible later extension. The checker has already proved that the request
  call directly initializes its named top-level declaration and that the child
  transport type is scalar; the noder preserves that name plus distinct child
  `captureType` and parent `resultType` rather than re-deriving placement or
  collection policy.
- Libraries link at check time through the import seam (Go's
  types2.Importer split): the loader's registry decides what a path means
  and loads libraries recursively (cycle detection included); the checker
  consumes the injected `Importer` and is provenance-blind. Compiler-shipped
  libraries and the implicit prelude are separate sets: `ta` is implicit,
  while trade components such as `broker`, `portfolio`, and `trade` are
  explicit imports. External `owner/name/version` paths error until a distribution
  story exists. The Program is always a closed script; a
  distributable compiled-library artifact, if ever needed, is a separate
  contract — never a bent Program.
- A never-reassigned declaration initialized by an input call aliases its
  `ParamInput`, so reads do not require a per-bar name write. Eligibility is
  keyed by canonical declaration identity. Tea `const` declarations disappear
  after folding. Visual function results remain ordinary runtime values.
- A native call's omitted trailing optionals are dropped (the runtime
  applies defaults); omitted middles node as `na` constants.
- `Program.init` stays empty for now — hoisting const/input/simple work out
  of the bar loop is a later optimization, not a correctness requirement.
- `Program.packageGlobals` is the explicit dependency-ordered list of reachable
  imported package-state Names. Their dependency-ordered `InitName` statements
  are prepended to that Program context's body and use the ordinary
  rollback-aware declaration protocol; the state is per Program
  context/binding, not process state. Import-only, type-only, and unreachable
  package globals are absent.
- Depth resolution walks UDF bodies in call-site context. Constant and
  immutable root-safe offsets no later than `simple` are substituted through
  parameters and single-write root locals, including aliases of `ParamInput`
  and `BuiltinInput`, then combined into one exact `bound` maximum
  (invalid/na components contribute zero). A demand that still depends on
  per-bar or unresolved frame state is `capped` by
  the generic engine default (500). For a history read
  indexed directly by a numeric range's induction variable, the noder uses the
  range's bind-safe maximum as the exact demand. More complex index arithmetic
  remains capped until a general interval pass can prove it safely.

## One Program, multiple targets

There is no strategy-specific IR or compiler path. `compileToProgram()` owns
the one load → import resolution/check → noding sequence, and both target
backends consume its `Program` directly. Every entry is a program. The explicitly
imported `trade` library owns trading policy without a special declaration header.

The selected direct trade coordinator, its concrete broker and portfolio
fields, and their reachable methods are ordinary Tea code in the closed Program
graph. Checker-only broker and portfolio interfaces have already been resolved
by generic specialization; they do not become Program values, witness tables,
or dynamic calls. WGSL codegen neither inspects package or family names nor
gives these values privileged nodes or ABI slots. Its fail-closed audit
describes only which generic Program constructs its current target profile can
represent.

Concrete bindings are not Program properties. After codegen, Node binds
application DataStreams and parameters to the runtime Module. The CPU backend
emits ordinary TypeScript with named frame state and lexical functions; its
program-specific Context and Arrow schemas come from this same Program. The
bind-independent GPU artifact carries both WGSL and the generated binding
module; each ordered `GpuBinding` supplies concrete parameter values, extent,
and numeric arrays. The GPU runtime sizes history from the frozen concrete
depths before packing and dispatching the shared shader. Neither target revisits
the Program or evaluates a second form of the bound expression. See
[GPU Lowering](advanced/gpu-lowering.md).

## Open items

- Function _templates_ (untyped params) are a checker representation, not a
  `FuncType`; the type domain holds concrete signatures only.
- General interval analysis can refine history demands for compound expressions
  over loop induction variables; exact direct-induction reads are already
  resolved.
- Batch collect merge for `request.security_lower_tf`; public Node
  collect synchronization is already defined in [Requests](requests.md).
