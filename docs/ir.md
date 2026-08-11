# The Tea IR

How Tea represents semantics between the syntax tree and generated code. This
document is the source of truth for the middle end; `src/ir/` implements it.
Execution — the Runtime ABI, the JS runtime, and generated-module contract — is owned by
[runtime.md](runtime.md).

## Pipeline vocabulary

```
Compilation                                  Lowering       Binding        Execution
source ─ parse ─ check ─ buildProgram ─▶ Program ─▶ JS module ─▶ bound instance ─▶ bar loop
         syntax  typecheck   noder                  codegen       runtime          runtime
```

- **Noding** (`noder.buildProgram`) turns checked syntax into the Program.
- **Lowering** is reserved for Program → JS (codegen), per [runtime.md](runtime.md)'s
  Compilation → Lowering → Binding → Execution flow. Lowering is bind-independent;
  the generated module evaluates bind-time expressions when the runtime binds it.
- The checker is a separate semantic pass over syntax (the types2 shape); the
  noder consumes the checked package and its exact per-context facts and never
  re-checks.

### Semantic package and occurrence facts (`src/checker/`)

`Package → Scope → Object → Type` is the checker source of truth. A package
owns its files, package scope, and imports; persistent scopes map source names
to canonical semantic objects; those objects represent variables, function
templates, user types and fields, enums and members, package names, and
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
function, constructor, or request. A `UserTypeObject` owns its nominal
`UserType` and ordered `FieldObject`s; each field owns its checked default
expression together with the `Info`, `TypeAndValue`, and semantic dependency
set that interpret it.
Constructor resolution aligns every supplied or defaulted argument to a field,
joins their qualifiers, and applies capture policy only to defaults actually
used by that call. Request resolution owns its capture facts and result type.
There are no parallel call maps or root-global user-type-default/capture
tables. Direct updates have one checked writeback target: a current root
`VariableObject` plus canonical `FieldObject`s. Mutating call receivers carry
that target inside their existing `CallResolution`.

The boundary is strict: checker results contain no `IrName`, `SeriesInput`,
`ExecutionInput`, `ParamInput`, `RequestEdge`, `HistoryDepth`, slot, or frame.
The noder creates those backend representations at the Program boundary.
Only the closed identifier vocabulary in `ir/builtin.ts` and the shared type
domain in `ir/type.ts` cross into the checker; backend nodes and Programs do
not.

## The one invariant above all others

**The compiler describes; the runtime implements.** The Program is a complete
static description — slots, storage classes, qualifiers, bind-resolvable
history depths, request edges, effect declarations. All Time Machine
mechanics — ring buffers, copy-on-write epochs, commit/rollback, provisional
overlays — are runtime-owned. The IR never encodes buffer layouts or COW
strategy, so runtime implementations can evolve freely against a stable
Program format.

## Type domain (`src/ir/type.ts`)

One type system shared by checker, IR, and Program (deliberately unlike Go's
historical types2/types split). A Tea type is a point on two axes:

- **Value types**: primitives (int, float, bool, string, color), drawing
  handles (line, label, box, table, polyline, linefill), collections
  (`array<T>`, `matrix<T>`, `map<K, V>`), user-defined value types and enums
  (identity by declaration), tuples, concrete function signatures, plus
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
Plot/hline references are their own value types
(`TypeKind.Plot`/`Hline`): compile-time output ids, const-qualified,
consumed by `fill` — not runtime heap handles.

## Program (`src/ir/program.ts`)

A Program is _a bar loop over one context_ — one symbol × timeframe axis —
owning the following backend resources. The noder is their sole creator: its
per-Program context projects `VariableObject → IrName` and each
`BuiltinObject` through its checker-owned binding to either `SeriesInput` or
`ExecutionInput`, creates `ParamInput` and `RequestEdge` objects, mints slots
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
  constraints and concrete UI metadata survive into the generated manifest.
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
  supplied by the context's provider. The checker catalog binds them
  explicitly as series; the noder interns one `SeriesInput` for each used
  builtin in each Program. `input.source` is restricted to this closed
  vocabulary. Neither noder nor runtime classifies a builtin by parsing its
  spelling.
- **typed execution inputs** (also a projection): `time`, `time_close`,
  `timenow`, `bar_index`, `last_bar_index`, `barstate.*`, `syminfo.*`, and
  `timeframe.*` are typed values supplied by the execution context rather than
  numeric provider columns. They project to `ExecutionInput`, which carries
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
  persistence axis, orthogonal to qualifiers), a first-bar `init` expression
  for var/varip storage (evaluated once by the runtime; no synthetic first-bar
  guards in the body), type and qualifier copied from the semantic object, and
  a **history depth resolvable no later than bind time** (non-negotiable):
  `none` (no buffer materializes), `const`, `bound` (an immutable root-safe
  expression no later than `simple`, evaluated at bind), or `capped` (dynamic
  offsets under an explicit bind-resolvable `max_bars_back` cap). Init is owned
  by noding and depth by the noder's depth pass. Series inputs, execution
  inputs, params, and request results carry the same depth field, so every
  history demand is resolved before execution.
- **outputs**: statically-declared effect channels (plot/hline/
  alertcondition), hoisted so the host knows every channel before the first
  bar. Three argument buckets: `staticArgs` (compile-time constants),
  `bindArgs` (input-qualified exprs — hline price, plot linewidth,
  plotshape offset — plus `fill`'s plot/hline references, evaluated once in
  module.bind and delivered before the first bar), and per-bar `channels` written
  via `Emit`. `bindArgumentEvaluationOrder` keeps bind-time named arguments in
  source order while `bindArgs` remains in canonical parameter order. A plot
  assignment lowers to the OutputDecl plus a const plot-typed binding holding
  the OutputId.
- **requests**: the recursive edge. The checker records capture semantics in
  the request call's resolution; the noder projects that resolution to a
  `RequestEdge` and compiles its captured expression into a **child Program**
  with its own context, axis, names, series inputs, slots, and rollback. The
  capture facts are not the child Program itself. Constants and direct scalar
  inputs may cross from the root; automatic closure over computed root names
  is staged and rejected in the meantime. The child designates a
  **result name** (`RequestEdge.resultName`, written each child bar; its type
  is the edge's `resultType`) whose committed values the runtime merges onto
  the parent axis. The edge retains four concrete bind-time option
  expressions (`gaps`, `lookahead`, `ignore_invalid_symbol`, and
  `calc_bars_count`) plus their source evaluation order; omitted options
  normalize to `false`, `false`, `false`, and `0`. Currency remains a
  positional but staged source parameter and does not enter the Program until
  its FX/unit model exists. One Program ↔ one context; composition is by
  recursion, never by multi-context Programs. With input/simple context
  arguments the context set is static; **dynamic requests** (Pine v6
  `dynamic_requests`) are the same edge with series-qualified context exprs —
  the child stays one static template and the runtime instantiates it per
  distinct (symbol, timeframe) pair it encounters. Non-security request kinds
  (financial/dividends/economic) map to edges whose child is a plain
  series-input projection; their extra context args ride the same shape.
- **funcs** (a projection, not a field): semantic function stencils are keyed
  only by `(FunctionObject, type + qualifier signature)`, not by a Program or
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
  site's `SlotId`); frames nest along the static call graph (acyclic —
  recursion is rejected), so the runtime enumerates and pre-allocates every
  frame at bind time. Two `ma(close, 10)` call sites share one compiled body
  but own two frames — and two `ema` sub-frames within. `ta.*` rides this exact
  path as prelude code; nothing is specialized for technical-analysis
  builtins.
- **init** vs **body**: const/input/simple work hoisted out of the loop vs
  the per-bar step.

## IR nodes (`src/ir/node.ts`)

Typed and resolved: every expression carries `(type, qualifier)`; every use
is a `Place` referencing its projected IR declaration object directly (Name |
ParamInput | SeriesInput | ExecutionInput | RequestEdge — no ids), with
`HistRead {place, offset?}` — a
read through the time machine, offset null meaning the current bar — and
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

Aggregate operations keep value semantics explicit without exposing physical
storage. `NewUserValue` constructs the canonical field vector. `FieldGet`
names a canonical field index. `UpdateValuePath` owns one projected root Name
plus field indices and performs one atomic writeback. A mutating collection
call and a `CallMutableMethod` carry that same path; codegen evaluates their
receiver once and copies the replacement back only after success. A
`CallConstMethod` carries a receiver value but no path or writeback authority.
There are no Program nodes for heap allocation, COW, prepare, publish, or
rollback.

Canonical argument slots and evaluation order are distinct Program facts.
Constructors and calls retain an `argumentEvaluationOrder`: lowering captures
supplied expressions in source order, evaluates omitted user defaults afterward
in canonical parameter/field order, and only then assembles the canonical ABI
argument vector. A method receiver is absent from this schedule and from
`args`; its dedicated call field is always captured once before the scheduled
explicit arguments. Named arguments therefore never reorder observable effects
or failures. Output declarations retain the
analogous `bindArgumentEvaluationOrder` for bind-time arguments, while an
`Emit` retains it for per-bar channels. A `RequestEdge` retains two independent
schedules: `optionArgumentEvaluationOrder` for its four bind-time options and
`contextArgumentEvaluationOrder` for its parent-owned symbol and timeframe.
There is deliberately no cross-phase schedule. The captured expression is
absent from both because it executes in the child Program rather than the
parent context.

User functions are discriminated by call mode. `CallFunc` targets only a
`FreeIrFunc`; `CallConstMethod` targets only a `ConstMethodIrFunc`; and
`CallMutableMethod` targets only a `MutableMethodIrFunc`. Both method function
types own a hidden receiver `Name` distinct from every explicit param. The
generated mutable-method `{receiver, result}` return envelope is an internal
codegen protocol, not a Tea tuple or Program value; const methods return their
result directly and never write back the receiver.

## Primitives vs prelude

A builtin is native **only if it is inexpressible in Tea**: data sources
(`close`, `bar_index`), host effects (`plot`, `line.new`), context capture
(`request.*`), collection primitives (`array.*`, `matrix.*`, `map.*`), math
intrinsics. Everything else — all of `ta.*` — is library code: a builtin Tea
library
(`src/lib/ta.tea`, a real `library("ta")` with `export` functions, loaded by
the loader/importer seam and implicitly imported into every script), compiled
by the ordinary pipeline, with per-call-site state falling out of ordinary
function semantics. Semantic stencils are per type + qualifier signature, not
per value or Program: a const-qualified param (`length`) is known per call site
at bind time but carries no fold value into the shared body. The native catalog
(typecheck round) declares, per primitive: value signature, per-param qualifier
caps, const-required and
**expression-capture** markers (what makes `request`'s third argument a
subgraph), and an **effect class** — the tag that selects the compilation and
runtime protocol:

| Effect class         | Examples                           | Protocol                                                                                                         |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| none                 | `math.*`                           | pure call                                                                                                        |
| param                | `input.*`                          | extracts one global `ParamInput` per call site; local blocks, non-exported UDFs, scalar request captures allowed |
| declaration          | `indicator`, `strategy`            | script metadata; top-level placement                                                                             |
| output (declarative) | `plot*`, `hline`, `alertcondition` | hoisted to `Program.outputs`; per-bar `Emit`; top-level/unconditional placement                                  |
| handle-object        | `line.*`, `label.*`, `box.*`       | per-bar host object ops; handle values; rollback participation                                                   |
| host-service         | `strategy.*` orders                | effects with host feedback readable next bar                                                                     |
| async-host-call      | `llm()` (Tea)                      | awaited/batched host call                                                                                        |
| request              | `request.*`                        | expression capture; compiles a child Program (`RequestEdge`)                                                     |

New builtin families are catalog entries plus at most a new noding policy —
never new checker or IR architecture. Future cross-sectional analysis
generalizes the request edge (a universe of contexts instead of one).

## Program fields vs projections

A Program declares its external needs — `params` (bind-time values; an
unused input still renders in the settings UI) and `requests`
(child-Program contexts the runtime must resolve) — and its emissions
(`outputs`; a static-only hline has no Emit), explicitly even where
derivable: the noder populates this interface, and codegen/runtime read what
the program needs from the world here without reinterpreting checker facts.
Context builtins are NOT declared as Program fields: they are available only
when used, and a child context's carriers are a product of its own request
capture. Composition internals — names, funcs, call-site slots — are
projections: `visit.ts` owns the exhaustive traversal and exposes `namesOf`,
`funcsOf`, `slotCountOf`, `seriesInputsOf`, `executionInputsOf`, and
`requestsOf`. The two input projections become separate id namespaces at the
module boundary; a typed execution value can never become an input-source
series merely because its Tea type is numeric. Request edges the noder finds
unreachable never enter `requests` — dead-request elimination by construction.

## Noding policies

- History on a non-place expression (`f(x)[k]`) desugars to a synthetic
  perBar slot written **unconditionally every bar** before the read — the
  unconditional write is what keeps its history well-defined. That is why
  the desugaring exists only at top level; inside a block it is a clean
  error for now.
- A value-position loop yields the last completed iteration's block value,
  `na` if no iteration completed; `break` skips the current iteration's
  value.
- User-value construction consumes the constructor call's single resolution. Its
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
  a possible later extension.
- Libraries link at check time through the import seam (Go's
  types2.Importer split): the loader's registry decides what a path means
  and loads libraries recursively (cycle detection included); the checker
  consumes the injected `Importer` and is provenance-blind. Builtins are
  implicitly imported; external `owner/name/version` paths error until a
  distribution story exists. The Program is always a closed script; a
  distributable compiled-library artifact, if ever needed, is a separate
  contract — never a bent Program.
- Reference bindings are compile-time only: a never-reassigned declaration
  initialized by an input call binds the name to its `ParamInput` (reads
  become param reads; no per-bar write), and one initialized by an output
  call (or an alias of one) binds to its `OutputDecl` via `OutputRef` — so
  `fill(p1, p2)` resolves refs at bind, never per bar. “Never reassigned” is
  a whole-context fact about the exact declaration object, not every binding
  with the same spelling. That declaration object is the semantic
  `VariableObject`; the noder chooses the current Program's projected Name.
  Tea `const` declarations vanish entirely (every read folded).
- `indicator()`/`strategy()` node as OutputDecls whose `effect` is the
  native's name: script metadata is an emission to the host, hoisted like
  every other declarative output.
- A native call's omitted trailing optionals are dropped (the runtime
  applies defaults); omitted middles node as `na` constants.
- `Program.init` stays empty for now — hoisting const/input/simple work out
  of the bar loop is a later optimization, not a correctness requirement.
- Depth resolution walks UDF bodies in call-site context. Constant and
  immutable root-safe offsets no later than `simple` are substituted through
  parameters and single-write root locals, including aliases of `ParamInput`
  and `ExecutionInput`, then combined into one exact `bound` maximum
  (invalid/na components contribute zero). A demand that still depends on
  per-bar or unresolved frame state is `capped` by
  `indicator(max_bars_back=…)` or the engine default (500). Interval analysis
  over loop bounds refines dynamic demands later.

## Open items

- Function _templates_ (untyped params) are a checker representation, not a
  `FuncType`; the type domain holds concrete signatures only.
- Id branding (`SlotId` etc.) hardens when the noder becomes the only mint.
- `HistoryDepth.bound`'s expression form will be refined by the depth
  resolution pass (interval analysis over loop bounds).
- Merge policy details for `request.security_lower_tf` (collect) vs
  `security` (sample) to be finalized against real host semantics.
