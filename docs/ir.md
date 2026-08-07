# The Tea IR

How Tea represents semantics between the syntax tree and generated code. This
document is the source of truth for the middle end; `src/ir/` implements it.
Execution — the Runtime ABI, the JS runtime, and generated-module contract — is owned by
[runtime.md](runtime.md).

## Pipeline vocabulary

```
Compilation                                  Binding        Lowering    Execution
source ─ parse ─ check ─ buildProgram ─▶ Program ─▶ bound ─▶ JS ─▶ bar loop
         syntax  typecheck   noder                  runtime   codegen  runtime
```

- **Noding** (`noder.buildProgram`) turns checked syntax into the Program.
- **Lowering** is reserved for Program → JS (codegen), per `runtime.ts`'s
  Compilation → Binding → Lowering → Execution flow.
- The checker is a separate pass over syntax with side tables (the types2
  shape); the noder consumes checked syntax and never re-checks.

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
canonicalizes folded `NaN` results to `NA_VALUE` before constructing a Program.
Plot/hline references are their own value types
(`TypeKind.Plot`/`Hline`): compile-time output ids, const-qualified,
consumed by `fill` — not runtime heap handles.

## Program (`src/ir/program.ts`)

A Program is _a bar loop over one context_ — one symbol × timeframe axis —
owning:

- **params**: `input.*` declarations. Compile time extracts the declaration
  (name, type, default, const-required constraints, and host-facing UI
  metadata including `display`); the **value arrives at bind time from the
  runtime**. That is what the `input` qualifier means. For supported input
  forms, extracted numeric constraints and concrete UI metadata survive into
  the generated manifest. Input defaults and concrete UI metadata must fold to
  non-`na` values; nullable numeric constraints such as min/max/step are the
  explicit exceptions.
- **ambient series** (not a field): `close`, `time`, `bar_index`,
  `syminfo.*` are built-ins of whatever context the Program runs in —
  provided by the runtime unconditionally, context-scoped, never declared,
  never mandatory. `seriesInputsOf` projects the depth-annotated usage set
  for buffer sizing.
- **names**: variables are `Name` objects — the `ir.Name` model. One object
  per declaration, referenced directly from every use; there is no id and no
  top-level variable table (enumerations for allocation or serialization are
  projections derived by walking, produced at the boundary that needs them —
  exactly how Go keeps a pointer graph in memory and lets the unified-IR
  writer assign indices at the boundary). A Name carries storage (`perBar` |
  `var` | `varip` — the persistence axis, orthogonal to qualifiers), a
  first-bar `init` expression for var/varip storage (evaluated once by the
  runtime; no synthetic first-bar guards in the body), and mutable analysis
  fields — type, qualifier, and a **history depth resolvable no later than
  bind time** (non-negotiable): `none` (no buffer materializes), `const`,
  `bound` (an input/simple expression evaluated at bind), or `capped`
  (dynamic offsets under an explicit bind-resolvable `max_bars_back` cap) —
  annotated by the checker and depth pass rather than frozen at
  construction. The binder's objects ARE these Names: one object set from
  binding through codegen. Series inputs and request results carry the same
  depth field, so the runtime sizes every buffer from the description alone.
- **outputs**: statically-declared effect channels (plot/hline/
  alertcondition), hoisted so the host knows every channel before the first
  bar. Three argument buckets: `staticArgs` (compile-time constants),
  `bindArgs` (input/simple-qualified exprs — hline price, plot linewidth,
  plotshape offset — plus `fill`'s plot/hline references, evaluated once at
  init and delivered before the first bar), and per-bar `channels` written
  via `Emit`. `x = plot(...)` lowers to the OutputDecl plus a const
  plot-typed binding holding the OutputId.
- **requests**: the recursive edge. Each `request.*` call site compiles the
  dependency closure of its expression argument into a **child Program** with
  its own context, axis, slots, and rollback. The child designates a
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
- **funcs** (a projection, not a field): per-signature instantiations of
  user/prelude functions — Go-style stencils that remain **real functions
  with runtime call dispatch**; inlining is at most a codegen optimization.
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
is a `Place` referencing its declaration object directly (Name | ParamInput |
SeriesInput | RequestEdge — no ids), with `HistRead {place, offset?}` — a
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
`checker/library.ts` and implicitly imported into every script), compiled by
the ordinary pipeline, with per-call-site state falling out of ordinary
function semantics. Stencils are per-signature, not
per-value: a const-qualified param (`length`) is known per call site at bind
time but carries no fold value into the shared body. The native catalog (typecheck round) declares, per
primitive: value signature, per-param qualifier caps, const-required and
**expression-capture** markers (what makes `request`'s third argument a
subgraph), and an **effect class** — the tag that selects the compilation and
runtime protocol:

| Effect class         | Examples                           | Protocol                                                                        |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| none                 | `math.*`                           | pure call                                                                       |
| param                | `input.*`                          | extracts a `ParamInput`; value arrives at bind time; top-level placement        |
| declaration          | `indicator`, `strategy`            | script metadata; top-level placement                                            |
| output (declarative) | `plot*`, `hline`, `alertcondition` | hoisted to `Program.outputs`; per-bar `Emit`; top-level/unconditional placement |
| handle-object        | `line.*`, `label.*`, `box.*`       | per-bar host object ops; handle values; rollback participation                  |
| host-service         | `strategy.*` orders                | effects with host feedback readable next bar                                    |
| async-host-call      | `llm()` (Tea)                      | awaited/batched host call                                                       |
| request              | `request.*`                        | expression capture; compiles a child Program (`RequestEdge`)                    |

New builtin families are catalog entries plus at most a new noding policy —
never new checker or IR architecture. Future cross-sectional analysis
generalizes the request edge (a universe of contexts instead of one).

## Program fields vs projections

A Program declares its external needs — `params` (bind-time values; an
unused input still renders in the settings UI) and `requests`
(child-Program contexts the runtime must resolve) — and its emissions
(`outputs`; a static-only hline has no Emit), explicitly even where
derivable: binder, checker, and runtime read what the program needs from
the world here, never by walking trees. Ambient context builtins (close,
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
- Request captures: the expression re-checks and nodes in a child context.
  Only bind-time (input) script values cross contexts; series/simple script
  variables must be recomputed inside the expression, and functions that
  read the context directly (ambient series, outer-scope variables) are
  rejected — pass context through parameters. Bind-time params are
  compilation-global: the child references the parent's ParamInputs and
  declares none of its own. Extracting the dependency closure of script
  variables into the child automatically is a possible later extension.
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
  `fill(p1, p2)` resolves refs at init, never per bar. “Never reassigned” is
  a whole-context fact about the exact declaration object, not every binding
  with the same spelling. Tea `const` declarations vanish entirely (every
  read folded).
- `indicator()`/`strategy()` node as OutputDecls whose `effect` is the
  native's name: script metadata is an emission to the host, hoisted like
  every other declarative output.
- A native call's omitted trailing optionals are dropped (the runtime
  applies defaults); omitted middles node as `na` constants.
- `Program.init` stays empty for now — hoisting const/input/simple work out
  of the bar loop is a later optimization, not a correctness requirement.
- Depth resolution, first cut: all-const offsets take their maximum; a
  single bind-time offset stays `bound`; dynamic or mixed demands fall back
  to `capped` with the `indicator(max_bars_back=…)` value or the engine
  default (500). Interval analysis over loop bounds refines this later.

## Open items

- Function _templates_ (untyped params) are a checker representation, not a
  `FuncType`; the type domain holds concrete signatures only.
- Id branding (`SlotId` etc.) hardens when the noder becomes the only mint.
- `HistoryDepth.bound`'s expression form will be refined by the depth
  resolution pass (interval analysis over loop bounds).
- Merge policy details for `request.security_lower_tf` (collect) vs
  `security` (sample) to be finalized against real host semantics.
