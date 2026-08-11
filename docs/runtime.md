# The Tea runtime ABI (`rt`)

How a compiled Program executes. This document is the source of truth for
the runtime ABI, the two external seams, and the execution protocol;
`src/runtime/` implements it (`JSRuntime`) and `src/codegen/` targets the ABI. The
Program contract stays owned by [ir.md](ir.md); the root `runtime.ts` sketch
is superseded by this document.

## Architecture

```
generated JS module ──rt──▶ Tea runtime (JSRuntime) ──data──▶ DataProvider (injected)
                            (owns the main loop) ──sink──▶ OutputSink  (injected)
```

One runtime. The runtime owns everything between the two seams: exact value
layouts, frames, rings, the immutable storage arena, the main loop,
provisional/commit, and request-child scheduling. Hosts differ only in what
they inject: the `tea` CLI injects a
csv provider and a printing sink; OpenChart injects a TSGraph-backed
provider and the chart/alert sink. A second runtime implementation is not a
goal; the ABI merely permits one.

## Pipeline order

```
Compilation ─▶ Lowering ─▶ Binding ─▶ Execution
   Program      module      instance    rows
```

Lowering is **bind-independent**: one JS module per Program, reusable across
bindings (a settings change rebinds without re-lowering). This revises the
earlier Binding → Lowering sketch, because bind-time expressions (bound
depths, input metadata, and output bindArgs) are themselves lowered code:
binding runs frame-free `init`, creates a scratch-only provisional program
frame, runs frame-aware `bind`, then allocates the final frame tree from its
depth reports. Baking bound constants into specialized modules is a permitted
later optimization, not the model.

## The generated module

Lowering emits one self-describing module — code plus the manifest the
runtime needs to allocate and bind. The module, not the Program, is the
runtime artifact (`tea build` output, cacheable, serializable):

```js
export default {
  abi: 3,
  aggregateLayouts: {layouts: [...]},     // root-wide LayoutId registry
  manifest: {
    series:  ['close', ...],              // sid -> host id (ambient + input.source params)
    params:  [{name, type, control, defaultValue, constraints, // control = UI flavor
               enumType, group, inline, tooltip, confirm,
               display, seriesSid?}, ...],
    outputs: [{effect, staticArgs, channels: [{name, type}]}, ...],
    frames:  [                            // fid 0 = the program frame
      {locals: [{storage, depth, layout}, ...], // slot-indexed; exact ValueLayout
       subs:   [{fid}, ...]},             // call-site-slot-indexed
    ],
    requests: [{merge, depth, resultSlot, layout}, ...], // rid-indexed metadata
  },
  requests: [M1, ...],           // rid-indexed child modules (same shape,
                                 // sibling consts — code cannot live in the
                                 // JSON manifest)
  init(rt) {...},                // reserved frame-free preparation
  bind(rt, fr) {...},            // input aliases/UDFs, depth reports, active,
                                 // output args, and static request pairs
  inits: {(fid, slot): (rt, fr) => v},   // var/varip first-execution thunks
  funcs: {fid: (rt, fr, ...args) => v},
  main(rt, fr) {...},            // the per-row body (fr = program frame)
};
```

`aggregateLayouts` appears once on the root `TeaModule`. Every request child
is a `ModuleCode` that inherits the same registry, Heap, and request-context
budget from `SharedExecutionState`; a child cannot define a second layout-id
namespace or move storage references across arenas.

Dense ids (`sid`, `pid`, `oid`, `fid`, local slots) are assigned by the
lowering walk; the manifest is their single source of truth — the runtime
never re-derives ids from the Program.

**Portability contract.** The emitted source is a strict-mode ECMAScript
**2015 (ES6)** FunctionBody: no module syntax (import/export/require), no
host I/O, no nondeterminism, and only whitelisted standard globals —
`Math.{abs, sign, floor, ceil, round, trunc, sqrt, pow, log, log10, exp,
max, min}`, `Number.{isFinite,isNaN}`, `String`, `NaN` — everything else
crosses the `rt` parameter. Any ES2015 engine loads it with
`new Function(src)()` (Node, Bun, browsers, V8 isolates alike); an ES2015
parse gate plus a deny-list test enforce the ceiling so it cannot drift.

## The rt surface

Only Time-Machine-relevant operations cross the ABI. Everything else —
arithmetic, comparisons, `math.*`, `na()`/`nz()`/`fixnan` — expands inline
in generated code via the backend's emitter rules table (a codegen-internal
seam: JS renders these natively; another backend supplies another table).

```ts
// reads and writes (offset 0 = current row)
rt.series(sid, offset); // ambient series and input.source params
rt.param(pid); // bind-time scalar
rt.read(fr, slot, offset); // a name's history
rt.write(fr, slot, v);
rt.request(rid, offset); // the edge's merged result: static view or
// dynamic result ring (docs/requests.md)
rt.requestFor(rid, sym, tf); // dynamic offset-0 read; unresolved pairs
// throw ContextSuspension (host awaits
// resolvePending, re-executes the row)
// frames
rt.frame(fr, slot); // open the sub-frame at this call site
rt.root(); // the program frame (globals read from funcs)
// emissions
rt.emit(oid, channel, v);
// frame-aware bind section (against a provisional scratch-only frame)
rt.historyDepth(offset); // invalid history offsets normalize to zero
rt.bindDepth(fid, slot, bars); // a name's bound history depth
rt.bindSeriesDepth(sid, bars); // a series/input.source bound depth
rt.bindParamActive(pid, active); // resolved input enablement
rt.bindOutput(oid, argName, v); // an output's bind-time argument
rt.bindRequest(rid, sym, tf); // a static request edge's context pair
// user values and collections
rt.newUser(layout, fields);
rt.userField(value, ownerLayout, fieldIndex);
rt.rebuildUserPath(root, rootLayout, fieldIndices, leaf);
rt.callCollection(operation, resultLayout, args);
rt.mutateCollection(operation, collectionLayout, receiver, args);
rt.collectionEntries(value);
```

`mutateCollection` returns a private `{replacement, result}` ABI envelope.
Generated code captures the receiver before evaluating arguments, calls the
operation once, and writes `replacement` through the checked root path once.
The envelope is not a Tea tuple and can never enter a Ring or collection.
Likewise a mutable user method returns a private replacement-receiver
envelope; const methods and free functions return ordinary Tea values. The
implicit source receiver `this` is never a runtime pointer or Heap reference.

`rt.frame(fr, slot)` is the seam where per-call-site state materializes:
fetch the sub-frame at compartment `slot` of `fr`, creating it on first use
from the callee's manifest layout and running its var-init thunks once. A
call site lowers to:

```js
const v = f_3(rt, rt.frame(fr, 0), rt.series(0, 0), 9);
```

## Values

- In-flight (what generated code holds): numerics are finite JS numbers or
  **na = NaN**. Every arithmetic and numeric-native result crosses the
  finite-or-na normalizer, so overflow and other non-finite results become
  NaN on both folded and dynamic paths; `Infinity` is never a Tea value.
  Every comparison with typed numeric or nullable na returns false,
  including `!=`. Strings, colors, enums, resource handles, user values, and
  collections use **null** as typed empty; string concatenation propagates
  null. bool is never na and
  its empty value is false — a checker guarantee the runtime may rely on.
  A direct bare `na` operand in a comparison is instead a compile error; use
  `na(x)` to test whether a value is missing.
- Host-bound numeric input values must be finite (NaN and both infinities are
  bind errors), and int inputs must be safe integers so their value is exact in
  the JS runtime. Provider series may return finite numbers or NaN; an infinity
  is a provider-contract invariant violation and fails loudly at the read.
- int semantics are codegen's job (truncating division, `math.*` int
  overloads); the runtime never re-checks types.
- A non-null user-defined value is a nominal, immutable logical record. It has
  one by-value representation in variables, fields, tuples, calls, returns,
  collection elements, and history. Host object identity is unobservable.
- Array, matrix, and map values are immutable headers over a source-hidden
  `StorageRef`. Mutators allocate sealed replacement backing and return a new
  header; they never edit a published payload. Capacity is implementation
  state and is not exposed to Tea.
- Storage is runtime-owned and invisible to source code: rings may use compact
  typed arrays plus validity, plain JS arrays, or anything else. Layout IDs
  validate exact values and locate nested collection storage; they are not a
  second source-language type identity.
- V1 output/effect channels accept only scalar or resource values. Aggregate
  host ownership is rejected until the ABI defines deep serialization or an
  explicit root lease; a sink cannot silently retain an unregistered
  `StorageRef`.

## Series access: one interface

```ts
interface SeriesView {
  at(offset: number): Value; // offset 0 = current row; out of range = typed empty
}
```

An offset names history only when it is a non-negative safe integer. Negative,
fractional, non-finite, and na offsets are out of range and return that place's
typed empty value (NaN, null, or false); they never turn into future-row indices
or array properties. The same rule normalizes a bind-reported depth to zero,
and fixed-context ring retention never exceeds the context's row extent.

Every time-addressed read goes through this interface — externally provided
columnar structures (TSGraph's low-copy pages), the runtime's own rings, and
later request results. Neither the runtime's read path nor generated code
ever assumes a native array; providers try to be efficient, the contract
doesn't require it.

The alignment contract: **all series a provider serves for one binding
share one row space** — one context is one axis, so the runtime keeps a
single cursor and every read is `cursor - offset` arithmetic. There is no
per-input index mapping inside a Program; cross-axis mapping exists only at
request edges, where the MergePolicy names it explicitly. The runtime
rejects misaligned series at bind.

Two asymmetries between the runtime's rings and provider series:

- Providers hand over **absolute-indexed committed rows** (`SeriesData`);
  the runtime wraps them, owning the cursor anchoring (offset → absolute)
  and, under live ticks, the provisional head — so external series and
  rings behave identically under the provisional protocol.
- Depth means **allocation** for rings (the runtime sizes them) but
  **contract** for providers: the demanded depth is the promise `at()` must
  honor that far back (a paged provider keeps pages accordingly; a csv
  provider ignores it).

## Frames and rings

A frame is a call site's persistent box: one Ring per local slot, one
sub-frame box per call-site slot, materialized lazily by `rt.frame` (frame
trees can also appear at runtime — dynamic requests instantiate whole trees
per context). One Ring class serves all layouts; ring capacity comes
from the manifest depth (`none` = current cell only, `const
n` / `capped n` = n + 1 cells, `bound` = the value `bind` reported via
`rt.bindDepth`). Each local and request manifest entry carries an exact
`LayoutId`. The shared `ValueLayoutRegistry` validates writes, derives the
typed empty value, and walks aggregate values for Heap roots. A Ring implements
SeriesView.

Fixed-width value storage has its own shared deterministic budget,
`BindInputs.maxFixedValueLogicalBytes` (default 64 MiB), separate from
variable-sized Heap backing. Before allocation, each Ring reserves
`(scratch + committed capacity) * shallowBytes(layout)`. Materialized request
result columns reserve the same exact per-layout size: the registered builder
owns that lease while capturing child rows, transfers it to the merged view,
and the owning runtime releases it at disposal. Scratch-only bind Rings release
before final frame allocation, and completed request children release their
frame/request-Ring leases after result ownership transfers.

Module `init` and `bind` run inside a dedicated abort-only Heap attempt. The
provisional bind frame and every collection backing allocated while computing
bind-time values are discarded before row execution; no bind temporary can
become published Heap storage.

## Main loop and the provisional protocol

```
bind(module, params, provider, sink):        # async — awaits live here only
  await provider.resolveContext('', '')      # the primary context
  validate params; run module.init           # frame-free preparation
  resolve manifest.series from the context   # a missing id is a bind error
  build scratch-only provisional frame
  run module.bind                            # aliases/UDFs, depths, active,
                                             # output args, request pairs
  discard it; allocate final rings/frame tree from reported depths
  per request edge: await resolveContext(pair); bind + run the child
  (recursively, same machinery, null sink); build the merged view
  sink.declare(outputs + bound args)

per row r (historical):        execute(r); commit(r)
per live tick on row r:        execute(r) — provisional
on row close:                  execute(r); commit(r)
```

`execute(r)` always runs the full body **from its storage-class baseline** —
there are no incremental update paths, by construction:

- Every ring has committed cells plus a **scratch head** for the row being
  executed. Reads at offset 0 see this execution's writes (or the storage
  class's start value); offsets ≥ 1 see committed history.
- At execution start the scratch head resets: `var` starts from its last
  committed value, perBar starts unwritten (na until written). **varip**
  scratch survives across provisional executions of the same row — the one
  storage class whose writes ticks accumulate.
- Each execution owns one Heap allocation attempt. Collection mutations may
  allocate tentative sealed cells, readable only by that attempt. A successful
  execution first prepares one row commit: Ring candidates, buffered emission
  state, and the exact reachable tentative Heap closure are all validated
  and frozen before any internal owner changes.
- Publishing the prepared internal commit is non-throwing: it pushes the Ring
  heads, promotes reachable tentative storage, discards unreachable tentative
  storage, publishes buffered internal state, and advances the cursor.
  Final sink delivery happens afterward; a sink failure cannot roll back
  already-published Tea state.
- A provisional success retains only the candidate roots selected by Ring
  storage policy (`varip` versus ordinary rollback). Immutable backing makes
  mixed aliases harmless: Heap carries no `var`/`varip` policy and replays no
  object edits.
- A throw or suspension invalidates scratch and buffered emissions, then
  aborts all tentative allocations. Committed state was never touched.

Emissions carry a `provisional` flag to the sink; alert-class outputs fire
on commit only.

```ts
interface DataProvider {
  series(id: string): SeriesData | null;
}
interface SeriesData {
  readonly length: number;
  at(index: number): number;
}
interface OutputSink {
  declare(outputs): void; // before the first row
  emit(row, oid, channels, provisional): void;
}
```

Historical csv execution uses exactly this. The request slice
(`docs/requests.md`) supersedes `series()` with async
`resolveContext(symbol, timeframe, range)` — one resolution path for the
primary and every request context — without changing the rt surface.

## Immutable Heap arena

The Heap is a type-neutral arena for variable-sized immutable backing. Its
only handle is the source-hidden `StorageRef`; it is not a user-object store
and does not give user-defined values identity. Collection descriptors own
builder-byte estimation, payload sealing, tracing, and per-cell logical byte
accounting. The Heap owns
allocation, stale/cross-arena/descriptor validation, reachability,
publication, deterministic limits, and collection.

Before a descriptor may seal, copy, or freeze a builder, the Heap checks the
transient cell limit and the descriptor's exact `builderLogicalBytes(builder)`
against the transient byte limit. The sealed payload's `logicalBytes` must
equal that estimate; disagreement is an internal descriptor-contract failure.
This makes the transient budget a pre-allocation guard instead of a check on
an oversized copy that was already built.

An attempt has exactly one path through
`active -> prepared -> published` or `active/prepared -> aborted`. At most one
nonterminal attempt exists in an arena. Preparing publication changes only the
attempt state and freezes a checked promotion plan; it does not publish or
discard cells. A published cell may reference only published storage, while a
tentative cell may reference published storage or storage from the same
attempt. Abort/discard makes its refs stale.

Publication roots are the exact post-publication owner graph: surviving Ring
cells and candidates, request result Rings/views/builders, and other registered
runtime owners. Temporary pre-attempt snapshots are safety roots only and are
not retained or charged after success. Physical collection runs only at a safe
point after the attempt is terminal and generated/scratch temporaries cannot
be sole owners. Root and all request-child runtimes share the same arena and
layout registry.

Limits count unique reachable cells and the logical bytes owned directly by
each cell; child cells reached through `StorageRef` are counted separately and
only once. Transient attempt limits are distinct from retained publication
limits, so behavior never depends on host-GC timing.

## Determinism

A module is a pure function of its Program; execution is a pure function of
(module, params, provider data). Generated code contains no `Date`, no
`Math.random`, no host I/O — enforced by an emitter-level guard and a test
grep. Replay of the same rows and ticks is byte-identical, which is what
makes golden traces and the tick/rollback property tests
(provisional-then-rollback ≡ never-executed; varip persistence) valid.

## Staged beyond this slice

Drawing/handle natives, persistent-trie/page optimizations behind the existing
collection contract, further network drivers (the quantmod roster —
alphavantage/tiingo with the same key treatment — as needed), live push
feeds, and V8-isolate embedding. None of them change the surface above;
they fill reserved entries.

A dynamic-request suspension is part of the execution protocol: `executeRow`
closes and aborts the parent attempt before child execution can begin. The host
awaits `resolvePending()` and re-executes the SAME row. Tentative writes,
buffered emissions, and tentative storage from the failed attempt vanish; the
retry restores the exact pre-attempt varip candidate, which may come from an
earlier successful provisional tick. If a first-row varip Ring had no prior
candidate, retry reruns its initializer. `runAll` runs this loop itself.
