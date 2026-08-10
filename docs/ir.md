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
templates, UDTs and fields, enums and members, package names, and builtins. The
shared type domain describes their value types. This graph answers _what a
declaration is_ without embedding Program objects or runtime layout.

`Info` answers _what each syntax occurrence means_. It records expression
types, definitions, uses, selections, scopes, calls, and reassignment for one
semantic checking context. The package root, each function instance, and each
request capture retain the exact `Info` in which they were checked. A request
capture's facts are semantic context, not physical Program identity; the noder
may project the same semantic objects into multiple Programs.

Every call occurrence has one discriminated `CallResolution`: native,
function, constructor, or request. A `UdtObject` owns its nominal type and
ordered `FieldObject`s; each field owns its checked default expression together
with the `Info`, `TypeAndValue`, and semantic dependency set that interpret it.
Constructor resolution aligns every supplied or defaulted argument to a field,
joins their qualifiers, and applies capture policy only to defaults actually
used by that call. Request resolution owns its capture facts and result type.
There are no parallel call maps or root-global UDT-default/capture tables.

The boundary is strict: checker results contain no `IrName`, `SeriesInput`,
`ParamInput`, `RequestEdge`, `HistoryDepth`, slot, or frame. The noder creates
those backend representations at the Program boundary.

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
  (`array<T>`, `matrix<T>`, `map<K, V>`), UDTs and enums (identity by
  declaration), tuples, concrete function signatures, plus `void` (effect
  calls) and `na` (the polymorphic empty value; assignable to every nullable
  type).
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
per-Program context projects `VariableObject → IrName` and
`BuiltinObject → SeriesInput`, creates `ParamInput` and `RequestEdge` objects,
mints slots and synthetic names, establishes static frame layouts, and hands
the resulting places to its depth pass for annotation.

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
- **ambient series** (not a field): `close`, `time`, `bar_index`,
  `syminfo.*` are built-ins of whatever context the Program runs in —
  provided by the runtime unconditionally, context-scoped, never declared,
  never mandatory. The checker resolves each occurrence to a semantic
  `BuiltinObject`; the noder interns its own `SeriesInput` in each Program
  projection. `seriesInputsOf` projects the depth-annotated usage set for
  buffer sizing.
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
  `none` (no buffer materializes), `const`, `bound` (a root-safe
  input-qualified expression evaluated at bind), or `capped` (dynamic offsets
  under an explicit bind-resolvable `max_bars_back` cap). Init is owned by
  noding and depth by the noder's depth pass. Series inputs, params, and request
  results carry the same depth field, so the runtime sizes every buffer from
  the description alone.
- **outputs**: statically-declared effect channels (plot/hline/
  alertcondition), hoisted so the host knows every channel before the first
  bar. Three argument buckets: `staticArgs` (compile-time constants),
  `bindArgs` (input-qualified exprs — hline price, plot linewidth,
  plotshape offset — plus `fill`'s plot/hline references, evaluated once in
  module.bind and delivered before the first bar), and per-bar `channels` written
  via `Emit`. `x = plot(...)` lowers to the OutputDecl plus a const
  plot-typed binding holding the OutputId.
- **requests**: the recursive edge. The checker records capture semantics in
  the request call's resolution; the noder projects that resolution to a
  `RequestEdge` and compiles its captured expression into a **child Program**
  with its own context, axis, names, series inputs, slots, and rollback. The
  capture facts are not the child Program itself. Constants and direct scalar
  inputs may cross from the root; automatic closure over computed root names
  is staged and rejected in the meantime. The child designates a
  **result name** (`RequestEdge.resultName`, written each child bar; its type
  is the edge's `resultType`) whose committed values the runtime merges onto
  the parent axis (sample or collect, gaps/lookahead, ignore-invalid-symbol,
  currency, calc-bars-count). One Program ↔ one context; composition is by
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
  State is a **frame tree**: an IrFunc's frame layout is its local Names
  plus one sub-frame per stateful call site (selected by that site's
  `SlotId`); frames nest along the static call graph (acyclic — recursion
  is rejected), so the runtime enumerates and pre-allocates every frame at
  bind time. Two `ma(close, 10)` call sites share one compiled body but own
  two frames — and two `ema` sub-frames within. `ta.*` rides this exact
  path as prelude code; nothing is specialized for technical-analysis
  builtins.
- **init** vs **body**: const/input/simple work hoisted out of the loop vs
  the per-bar step.

## IR nodes (`src/ir/node.ts`)

Typed and resolved: every expression carries `(type, qualifier)`; every use
is a `Place` referencing its projected IR declaration object directly (Name |
ParamInput | SeriesInput | RequestEdge — no ids), with
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

## Primitives vs prelude

A builtin is native **only if it is inexpressible in Tea**: data sources
(`close`, `bar_index`), host effects (`plot`, `line.new`), context capture
(`request.*`), heap primitives (`array.*`), math intrinsics. Everything
else — all of `ta.*` — is library code: a builtin Tea library
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
Ambient context builtins (close,
volume, syminfo.\*) are NOT declared: they are simply available, usage
optional, and the series list of a child context is a product of request
resolution. Composition internals — names, funcs, call-site slots — are
projections: `visit.ts` owns the exhaustive traversal and exposes
`namesOf`, `funcsOf`, `slotCountOf`, plus `seriesInputsOf` (the
depth-annotated ambient usage set, for buffer sizing) and `requestsOf`
(how the noder fills the interface field). Request edges the noder finds
unreachable never enter `requests` — dead-request elimination by
construction.

## Noding policies

- History on a non-place expression (`f(x)[k]`) desugars to a synthetic
  perBar slot written **unconditionally every bar** before the read — the
  unconditional write is what keeps its history well-defined. That is why
  the desugaring exists only at top level; inside a block it is a clean
  error for now.
- A value-position loop yields the last completed iteration's block value,
  `na` if no iteration completed; `break` skips the current iteration's
  value.
- UDT construction consumes the constructor call's single resolution. Its
  field-ordered arguments include both supplied expressions and field-owned
  defaults; the noder temporarily reads each checked expression's `Info` while
  lowering it into the caller's current Program and frame. Defaults are
  semantic expressions, never prebuilt IR shared across Programs.
- Request captures: the expression re-checks and nodes in a child context.
  Only constants and direct scalar input bindings cross contexts; computed
  root aliases fail closed because the child has no projected root-frame place
  for them. Function instances record exact transitive semantic dependencies:
  ambient builtins reproject safely in the child, while outer variables must
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
  root-safe input-qualified offsets are substituted through parameters and
  single-write input locals, then combined into one exact `bound` maximum
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
