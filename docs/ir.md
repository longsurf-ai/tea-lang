# The Tea IR

How Tea represents semantics between the syntax tree and generated code. This
document is the source of truth for the middle end; `src/ir/` implements it.

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
- **Qualifiers**: `const < input < simple < series` — an ordered join
  semilattice answering _when the value becomes known_: compile time, bind
  time, before the first bar, per bar. Expression qualifiers combine by
  lattice join. History is a property of this axis: only series-qualified
  values have a time dimension.

`TypeAndValue {type, qualifier, value?}` is the checker's currency (types2's
`TypeAndValue` with Tea's extra axis). The sole implicit conversions:
int → float, and `na` → any nullable type — where, per Pine v6, **bool is
never nullable** (na does not assign to or unify with bool), and neither are
void and function types. `na` itself is a first-class constant (`NA_VALUE`, a
branded singleton — not null, so "no constant" stays distinguishable in
`TypeAndValue`). Plot/hline references are their own value types
(`TypeKind.Plot`/`Hline`): compile-time output ids, const-qualified,
consumed by `fill` — not runtime heap handles.

## Program (`src/ir/program.ts`)

A Program is _a bar loop over one context_ — one symbol × timeframe axis —
owning:

- **params**: `input.*` declarations. Compile time extracts the declaration
  (name, type, default, const-required constraints); the **value arrives at
  bind time from the runtime**. That is what the `input` qualifier means.
- **seriesInputs**: per-bar data the runtime provides for this Program's
  context (`close`, `time`, `bar_index`, `syminfo.*` bindings — context-scoped,
  not global).
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
  **result slot** (`RequestEdge.resultSlot`, written each child bar; its type
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
- **funcs**: per-signature instantiations of user/prelude functions. Call
  sites carry a `CallStateId`, and runtime state identity is the **dynamic
  chain of CallStateIds** (the call path): two outer `f()` sites calling one
  inner `ta.sma` site yield two sma states keyed `[outerId, innerId]`. Two
  `ma(close, 10)` calls own two independent states; the same mechanism
  serves stateful natives.
- **init** vs **body**: const/input/simple work hoisted out of the loop vs
  the per-bar step.

## IR nodes (`src/ir/node.ts`)

Typed and resolved: every expression carries `(type, qualifier)`; every use
is a `Place` referencing its declaration object directly (Name | ParamInput |
SeriesInput | RequestEdge — no ids), with `Read {place, offset?}` covering
both current and history access, and each use keeping its own position
(unlike shared-node designs, diagnostics never lose the use site). Operations
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
else — all of `ta.*` — is library code: a prelude written in Tea, compiled by
the ordinary pipeline, with per-call-site state falling out of ordinary
function semantics. The native catalog (typecheck round) declares, per
primitive: value signature, per-param qualifier caps, const-required and
**expression-capture** markers (what makes `request`'s third argument a
subgraph), and an **effect class** — the tag that selects the compilation and
runtime protocol:

| Effect class       | Examples                           | Protocol                                                                        |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------- |
| none               | `math.*`                           | pure call                                                                       |
| declarative-output | `plot*`, `hline`, `alertcondition` | hoisted to `Program.outputs`; per-bar `Emit`; top-level/unconditional placement |
| handle-object      | `line.*`, `label.*`, `box.*`       | per-bar host object ops; handle values; rollback participation                  |
| host-service       | `strategy.*`                       | effects with host feedback readable next bar                                    |
| async-host-call    | `llm()` (Tea)                      | awaited/batched host call                                                       |

New builtin families are catalog entries plus at most a new noding policy —
never new checker or IR architecture. Future cross-sectional analysis
generalizes the request edge (a universe of contexts instead of one).

## Noding policies (locked, implemented when the noder lands)

- History on a non-place expression (`f(x)[k]`) desugars to a synthetic
  perBar slot written **unconditionally every bar** before the read — the
  unconditional write is what keeps its history well-defined.
- A value-position loop yields the last completed iteration's block value,
  `na` if no iteration completed; `break` skips the current iteration's
  value.
- Libraries link at check time: imports resolve against checked library
  sources and instantiate into the importer's Program. The Program is always
  a closed script; a distributable compiled-library artifact, if ever
  needed, is a separate contract — never a bent Program.

## Open items

- Function _templates_ (untyped params) are a checker representation, not a
  `FuncType`; the type domain holds concrete signatures only.
- Id branding (`SlotId` etc.) hardens when the noder becomes the only mint.
- `HistoryDepth.bound`'s expression form will be refined by the depth
  resolution pass (interval analysis over loop bounds).
- Merge policy details for `request.security_lower_tf` (collect) vs
  `security` (sample) to be finalized against real host semantics.
