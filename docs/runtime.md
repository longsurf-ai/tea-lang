---
title: 'The Tea runtime ABI (`rt`)'
sidebarTitle: Runtime
---

How target artifacts bind and execute. This document is the source of truth for
the JS Runtime ABI, its two external seams, generic CPU batching, and the GPU
binding/dispatch boundary. `src/runtime/` implements execution and
`src/codegen/` emits bind-independent artifacts. The one Program contract stays
owned by [ir.md](ir.md); the root `runtime.ts` sketch is superseded by this
document.

## Architecture

Configured execution has three owners and one stable handoff between each:

1. **Tea Core** compiles source once through `compileToProgram()` and owns the
   target-independent `Program`.
2. **The selected runtime** specializes execution for its platform: JavaScript
   on CPU or WGSL/WebGPU on GPU.
3. **The execution context** owns host-supplied providers, parameter
   selections, inputs, bindings, `timeNow`, and whether this is one run or a
   sweep. It resolves those choices into the existing ordered `BindInputs[]`.

The versioned execution config is the durable specification for parts 2 and 3;
it points at Core source but is not another Program, IR, or compilation path.
This keeps future scan and live hosts free to add context kinds without
changing the language-to-Program boundary.

```text
generated JS module ──▶ JSRuntime ──data──▶ DataProvider (injected)
                            │
                            └────sink────▶ OutputSink (injected)

generated WGSL artifact + BindInputs[] + injected GPUDevice
                                      │
                                      ▼
                         resumable GPU execution
                                      │
                                      └─▶ decoded rows ─▶ OutputSink
```

Both branches execute artifacts lowered from the same `Program`; neither owns
a second execution-mode model. `JSRuntime` owns exact value layouts,
frames, rings, context-local Heap storage, the main loop, provisional/commit, and
request-child scheduling. Hosts vary through the injected DataProvider and
OutputSink. The GPU runtime owns target data validation, physical packing,
device dispatch, and readback; Tea state transitions remain in the emitted
WGSL.

## Pipeline order

```text
Compilation ─▶ Target lowering ─▶ Runtime binding ─▶ Execution
   Program       JS / WGSL       instance/session      rows/chunks
```

Lowering is **bind-independent**: one artifact per Program and target, reusable
across bindings. A settings, dataset, or binding-grid change does not re-run
codegen. For JS, bind-time expressions (bound depths, input metadata, and
output bindArgs) remain lowered code: binding runs frame-free `init`, creates a
scratch-only provisional program frame, runs frame-aware `bind`, then allocates
the final frame tree from its depth reports. For WGSL, the runtime combines the
already-emitted module/layout contract with concrete provider-backed bindings
and physical resource policy to create a resumable execution session. Baking
bound constants into specialized artifacts is a permitted later optimization,
not the model.

## The generated JS module

Lowering emits one self-describing module — code plus the manifest the
runtime needs to allocate and bind. The module, not the Program, is the
runtime artifact (`tea build` output, cacheable, serializable):

```js
export default {
  abi: 2,
  aggregateLayouts: {layouts: [...]},     // root-wide LayoutId registry
  manifest: {
    series:  [{id, depth}, ...],          // sid -> numeric provider column
    builtin: [{source, layout, depth}, ...], // bid -> typed builtin
    params:  [{name, type, control, defaultValue, constraints, // control = UI flavor
               enumType, group, inline, tooltip, confirm,
               display, seriesSid?}, ...],
    outputs: [{effect, staticArgs, channels: [{name, type, transport}]}, ...],
    effects: [{layout}, ...],              // effect id -> fixed payload layout
    frames:  [                            // fid 0 = the program frame
      {locals: [{storage, depth, layout}, ...], // slot-indexed; exact ValueLayout
       subs:   [{fid}, ...]},             // call-site-slot-indexed
    ],
    requests: [{merge: {mode}, depth, resultSlot, layout}, ...], // rid-indexed metadata
  },
  requests: [M1, ...],           // rid-indexed child modules (same shape,
                                 // sibling consts — code cannot live in the
                                 // JSON manifest)
  init(rt) {...},                // reserved frame-free preparation
  bind(rt, fr) {...},            // input aliases/UDFs, depth reports, active,
                                 // output args, request options, and static pairs
  funcs: {fid: (rt, fr, ...args) => v},
  main(rt, fr) {...},            // the per-row body (fr = program frame)
};
```

`RUNTIME_ABI_VERSION` is the single version source and is currently `2`.
Before launch, this contract evolves in place; the runtime does not carry
compatibility branches for older generated modules.

An output channel's `type` is the human Tea spelling. The current ABI publishes
an exhaustive `transport` discriminant projected directly from the checked IR
type (`int`, `float`, `bool`, `string`, `color`, `enum`, resource, output
reference, struct, or aggregate shape). Runtime transports branch only on that field;
they never recover machine semantics by parsing the display string.

`aggregateLayouts` appears once on the root `TeaModule`. Every request child is
a `ModuleCode` that inherits the same immutable registry and execution-wide
request/fixed-value budgets from the shared execution state, but owns an
independent Heap. Children cannot define a second layout-id namespace, and
request results cross into the parent only as copied scalars or scalar-only
tuples; a `Ref` never crosses arenas.

Dense ids (`sid`, `bid`, `pid`, `oid`, `fid`, local slots) are assigned by the
lowering walk; the manifest is their single source of truth — the runtime
never re-derives ids from the Program. Series inputs and builtins use
separate id spaces; numeric Tea type alone never moves a builtin between them.

**Portability contract.** The emitted source is a strict-mode ECMAScript
**2015 (ES6)** FunctionBody: no module syntax (import/export/require), no
host I/O, no nondeterminism, and only whitelisted standard globals —
`Math.{abs, sign, floor, ceil, round, trunc, sqrt, pow, log, log10, exp,
max, min}`, `Number.{isFinite,isNaN}`, `String`, `NaN` — everything else
crosses the `rt` parameter. Any ES2015 engine loads it with
`new Function(src)()` (Node, browsers, and V8 isolates alike); an ES2015
parse gate plus a deny-list test enforce the ceiling so it cannot drift.

## The rt surface

Only Time-Machine-relevant operations cross the ABI. Everything else —
arithmetic, comparisons, `math.*`, `na()`/`nz()`/`fixnan` — expands inline
in generated code via the backend's emitter rules table (a codegen-internal
seam: JS renders these natively; another backend supplies another table).

```ts
// reads and writes (offset 0 = current row)
rt.series(sid, offset); // numeric provider series and input.source params
rt.builtin(bid, offset); // typed time/bar/barstate/syminfo/timeframe value
rt.param(pid); // bind-time scalar
rt.read(fr, slot, offset); // a name's history
rt.write(fr, slot, v);
rt.needsInit(fr, slot); // persistent declaration has not initialized yet
rt.initialize(fr, slot, v); // tentatively initialize at this lexical site
rt.request(rid, offset); // a static edge's merged parent-row view
// frames
rt.frame(fr, slot); // open the sub-frame at this call site
rt.root(); // the program frame (globals read from funcs)
// emissions
rt.emit(oid, channel, v);
rt.emitEffect(effectId, payload); // ordered sparse append for this row transaction
// frame-aware bind section (against a provisional scratch-only frame)
rt.historyDepth(offset); // invalid history offsets normalize to zero
rt.bindDepth(fid, slot, bars); // a name's bound history depth
rt.bindSeriesDepth(sid, bars); // a series/input.source bound depth
rt.bindBuiltinDepth(bid, bars); // a typed builtin's bound depth
rt.bindParamActive(pid, active); // resolved input enablement
rt.bindOutput(oid, argName, v); // an output's bind-time argument
rt.bindRequestOptions(rid, gaps, lookahead, ignoreInvalid, calcBars);
rt.bindRequest(rid, sym, tf); // a static request edge's context pair
// structs and collections
rt.newStruct(layout, fields);
rt.requireStruct(value, ownerLayout); // pre-RHS/argument receiver check
rt.structField(value, ownerLayout, fieldIndex);
rt.storeStructField(value, ownerLayout, fieldIndex, replacement);
rt.callCollection(operation, resultLayout, args);
rt.mutateCollection(operation, collectionLayout, receiver, args);
rt.collectionEntries(value);
```

`mutateCollection` returns a private `{replacement, result}` ABI envelope.
Generated code captures the receiver/location before evaluating arguments,
calls the operation once, and writes `replacement` to either the captured Name
or struct field. The envelope is not a Tea tuple and can never enter a Ring or
collection. Mutable and const methods both return only their declared Tea
result; a mutable method changes the receiver's Heap storage in place.

`rt.frame(fr, slot)` is the seam where per-call-site state materializes:
fetch the sub-frame at compartment `slot` of `fr`, creating its physical
storage on first use and tentatively activating it for this row transaction.
Persistent initialization remains inside the callee's lexical `InitName`
statements. A call site lowers to:

```js
const v = f_3(rt, rt.frame(fr, 0), rt.series(0, 0), 9);
```

## Values

- In-flight (what generated code holds): numerics are finite JS numbers or
  **na = NaN**. Every arithmetic and numeric-native result crosses the
  finite-or-na normalizer, so overflow and other non-finite results become
  NaN on both folded and dynamic paths; `Infinity` is never a Tea value.
  Every comparison with typed numeric or nullable na returns false,
  including `!=`. Strings, colors, enums, resource handles, struct references, and
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
- A non-null struct value is a source-hidden typed `Ref` to nominal Heap
  storage. Variables, fields, tuples, calls, returns, collection elements, and
  history copy the reference. The body is transactionally mutable and has no
  per-bar version chain.
- Array, matrix, and map values are immutable headers over a source-hidden
  `Ref`. Mutators allocate sealed replacement backing and return a new
  header; they never edit a committed payload. Capacity is implementation
  state and is not exposed to Tea.
- Storage is runtime-owned and invisible to source code: rings may use compact
  typed arrays plus validity, plain JS arrays, or anything else. Layout IDs
  validate exact values and locate nested collection storage; they are not a
  second source-language type identity.
- V1 output/effect channels accept only scalar or resource values. Aggregate
  host ownership is rejected until the ABI defines deep serialization or an
  explicit root lease; a sink cannot silently retain an unregistered
  `Ref`.

## Typed builtins

`BuiltinSpec.source` is a closed `{domain, field}` key. Its domain is only
the builtin namespace — `time`, `bar`, `barstate`, `syminfo`, or `timeframe` —
and never causes a corresponding runtime object to be constructed. One
exhaustive runtime switch resolves the exact source key:

- `time.time` and `time.time_close` read the context's existing `TimeAxis`;
  `time.timenow` reads the one host-injected clock value for this historical
  binding.
- `bar.bar_index`, `bar.last_bar_index`, and `barstate.*` derive from the
  runtime cursor and fixed context extent.
- `syminfo.*` and `timeframe.*` come from the resolved provider context's
  typed builtin accessor. A missing demanded value is a `BindError`; a value
  that is legitimately typed empty remains distinct from missing metadata.

Every read first computes `target = cursor - offset`. An invalid history
offset or a target outside the context extent returns the spec layout's typed
empty. Otherwise open/close time, bar index, and historical bar state are
row-indexed; `last_bar_index` is extent-constant; symbol/timeframe metadata and
historical `timenow` are context-constant. For fixed historical execution,
`ishistory`, `isnew`, and `isconfirmed` are true, `isrealtime` is false, and
`isfirst`/`islast` derive from the target row. This does not define a live-tick
update object; realtime state remains a separate host-protocol design.

Only simple symbol/timeframe metadata may be read at offset zero during module
bind, before a row cursor exists. Although the host-injected `timeNow` value is
fixed and context-constant across one historical run, source-level `timenow`
remains series-qualified and is not a bind expression; `time`, `timenow`,
`bar`, and `barstate` reads during bind are malformed generated-code protocol
and fail loudly. `BindInputs.timeNow` is a required finite safe
epoch-millisecond value shared by the root and every request child; only the
CLI obtains it from `Date.now()`. Generated modules and the runtime never read
the wall clock.

## History access: one interface

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
sub-frame box per call-site slot, materialized lazily by `rt.frame`. Static
request children own independent frame trees in their own runtime contexts.
Physical allocation does not mean the call site has executed:
each frame carries separate committed and scratch activation state. Calling
`rt.frame` tentatively activates its child for the current row transaction; abort
restores the pre-transaction activation tree, while final commit
promotes it. A successful provisional execution may retain a same-row
activation candidate so `varip` state survives even when the final execution
does not revisit that call site.

One Ring class serves all layouts; ring capacity comes
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
result columns reserve the same exact per-layout size. Child results are copied
as scalars or scalar-only tuples into that parent-owned column; the merged view
owns its lease until disposal. Scratch-only bind Rings release before final
frame allocation, and completed request children release their frame/request-
Ring leases and independent Heaps after the copy completes.

Module `init` and `bind` run inside a dedicated abort-only Heap transaction. The
provisional bind frame and every collection backing allocated while computing
bind-time values are discarded before row execution; no bind temporary can
become committed Heap storage.

## Main loop and the provisional protocol

```
bind(module, params, provider, sink, timeNow): # async — awaits live here only
  await provider.resolveContext('', '', full) # the primary context
  validate params
  resolve manifest.series from the context    # a missing id is a bind error
  validate demanded execution metadata/axis   # exact typed sources only
  run module.init                              # frame-free preparation after
                                               # context carriers are bound
  build scratch-only provisional frame
  run module.bind                            # aliases/UDFs, depths, active,
                                             # output args, request options/pairs
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
- A persistent declaration is an ordinary `InitName` statement at its lexical
  execution site. Generated code first asks `rt.needsInit(frame, slot)` and
  evaluates the initializer only when that answer is true, then publishes the
  tentative value through `rt.initialize`. The runtime tracks committed and
  scratch initialization bits separately; an untaken declaration therefore
  does not initialize, and an initializer may read current call arguments or
  perform any other ordinary Tea evaluation in source order.
- At execution start the scratch head resets: `var` starts from its last
  committed value only when its committed initialization bit is set; otherwise
  it stays typed-empty and eligible for `InitName`. PerBar starts unwritten
  (na until written). **varip** scratch value, initialized bit, and later
  rebindings survive successful same-row executions. An ordinary `var` retains
  only its first successful same-row initialization candidate; later writes
  still reset to the storage-class baseline.
- Each execution owns one Heap transaction. Allocation creates tentative cells;
  a write to an existing identity stages a complete replacement payload, and
  transactional reads observe that overlay before committed state. Commit
  installs all replacements and tentative allocations; abort discards them.
  Ring heads and buffered internal state follow the corresponding successful
  row transition.
- After the transaction is terminal, the runtime discovers the complete roots
  held by its own persistent values, replaces the Heap's stored root snapshot,
  and may run Mark-Sweep collection. Final sink delivery is post-commit; a sink
  failure cannot roll back already-committed Tea state.
- A provisional success commits struct-body replacements, so every alias observes
  them on the next tick. `var`/`varip` select binding candidates, not struct-
  body persistence. The first successful ordinary-`var` initialization retains
  an initialization-only same-row candidate; later ordinary reassignments still
  roll back.
- A throw invalidates scratch values, initialization bits,
  tentative frame activation, and buffered emissions, aborts tentative
  allocations, and discards staged struct replacements. No mutation from the
  failed transaction remains observable.

Emissions carry a `provisional` flag to the sink; alert-class outputs fire
on commit only.

```ts
interface DataProvider {
  resolveContext(
    symbol: string,
    timeframe: string,
    range: RangeDemand,
  ): Promise<ProviderContext | ContextError>;
}
interface ProviderContext {
  readonly rows: number;
  readonly axis: TimeAxis | null;
  series(id: string): SeriesData | null;
  builtinValue(
    source: Extract<BuiltinSource, {domain: 'syminfo' | 'timeframe'}>,
  ): Value | undefined;
}
interface OutputSink {
  readonly capabilities?: {
    readonly denseRows?: 'all' | 'final';
    readonly effects?: 'all' | 'none';
  };
  declare({outputs, effects}): void; // before the first row
  publish({row, outputs, effects, provisional}): void;
}
```

Omitted capabilities mean complete dense and effect transport. A sink may
request only the final committed dense row with `denseRows: 'final'`, or opt
out of sparse payload transport with `effects: 'none'`. These are generic
transport requirements, not strategy semantics; composed sinks request the
union needed by their children.

Dense output writes and sparse effects are snapshotted together after a
successful row transaction and cross the sink boundary in one `publish` call.
Suspended or failed transactions publish nothing. A sink exception makes the
binding terminal, so committed effects are never retried or duplicated.
Effect payload layouts admit primitives, strings/colors, enums, and finite
acyclic struct snapshots. `emitEffect` dereferences and materializes the
snapshot immediately; collections, tuples, resource handles, and recursive
struct payloads are rejected.

The same resolution path supplies the primary context and every request
child. Provider series remain numeric and aligned to `rows`; typed builtin
metadata uses `builtinValue`. `undefined` means that the provider cannot
supply a demanded builtin and is never coerced to a Tea empty value.

## Generic CPU batching

Batching is composition over the ordinary JS runtime, not a separate
compilation or strategy execution path:

```ts
runCpuBatch(module, bindings: readonly BindInputs[])
```

Each binding already carries its parameters, provider, deterministic clock,
limits, and `OutputSink`. Array order is execution and result order; an empty
array is valid. The runner creates a fresh `JSRuntime` and frame tree per
binding, calls the same `bind()` and `runAll()` used by `tea run`, always
disposes the execution, and returns only generic row/input summaries.

Output/effect capture is caller policy. `MemorySink` is the optional structured
in-memory sink for examples and tests; callers may instead inject table, trace,
streaming, bounded, or transactional sinks. The runner does not assign job ids,
own output capacity, or interpret sweep dimensions. There is no batch-plan or
journal layer between the caller's bindings, their sinks, and `runCpuBatch()`.

## Sweep reporting and visualization

Sweep presentation remains outside both runtimes. `SweepReportSink` requests
only each execution's final dense values and no effects. The reporting layer
combines those snapshots with execution summaries and declared numeric ranges
into a renderer-neutral `SweepResult`.

The visualization layer projects that result into a `SweepScene` from an
explicit X parameter, Y parameter, numeric output metric, and one selected
value for every remaining swept dimension. A complete rectangular coordinate
grid with at least two values per axis becomes a surface and retains null
metrics as holes. Auto geometry keeps incomplete or degenerate grids as points;
an explicitly requested surface retains missing coordinates as holes. It never
invents scenarios or interpolates results.

Visualization hosts consume a presentation model containing the available
axes, metrics, current view specification, and projected `SweepScene`. Tea's
CLI does not import a renderer or start a browser server. The VS Code/Cursor
host uses the same pure projection and packages its renderer assets locally.

`tea execute <config> --json` returns one versioned, renderer-neutral result.
For a sweep it contains both the compact `SweepResult` and every complete
`TrajectoryResult` captured during that same execution. A compact archive owns
scalar dense columns and logical typed effects under one 256 MiB retention and
projection budget while the sweep runs; human CLI sweeps retain final values
only. The CLI serializes the completed result once and exits. Consumers select
a trajectory locally—there is no persistent editor session or selected-binding
replay.

The result identifies the complete Tea source closure, primary-provider bytes,
effective clock, binding identity, and effective parameters. Request-backed
executions are safe because every trajectory comes from its original sweep
execution. Unsupported aggregate/resource output transports or an exceeded
archive budget fail before JSON is published.

The resulting `TrajectoryResult` is renderer-neutral: it contains a row-aligned
provider time axis, declared dense output columns, logical effect schemas, and
typed effect emissions. Presentation code may recognize a public logical
schema such as `broker.FillExecuted` to draw entry/exit markers; neither the
runtime nor the generic reporting layer recognizes strategy packages.

## GPU binding and execution

WGSL codegen returns a bind-independent artifact: the complete shader, the
ordinary generated JS binding module, target numeric/layout contract, required
inputs, output/effect schemas, persistent execution-state layout, and bounded
effect analysis. It contains no concrete rows, binding identities, resource
allocation, or device. The JS sidecar is generated from the same Program and
exists only to run the established `init`/`bind` protocol; it is not another
semantic representation.

That physical boundary is the versioned `CompiledWgslProgram` contract in
`src/gpu/contract.ts`. Its `abi` is currently `3`; the same module owns every
fixed bind-group index, descriptor offset, and scalar stride used by both
WGSL lowering and runtime validation. Codegen produces this contract and the
GPU runtime consumes it without importing codegen implementation modules or
reconstructing physical constants.

The public runtime is one asynchronous session API:

```ts
const execution = await createGpuExecution(
  device,
  artifact,
  bindings, // readonly BindInputs[]
  {
    maxRowsPerChunk,
    effectRecordsPerExecution,
    maxGpuBytes,
    maxCacheBytesPerWorkgroup,
  },
);

await execution.runChunk();
await execution.runAll();
execution.dispose();
```

`executeProgram(program, bindings, backend)` is the public backend-neutral host
harness. It lowers the already checked Program once, executes the ordered
bindings, and returns row/input/timing statistics plus the arithmetic profile
that produced the results (`js-f64` or artifact-derived `wgsl-f32-i32`). A GPU
summary additionally reports chunk and dispatch counts plus the selected
workgroup-cache placement. Result ownership remains with each binding's sink.

GPU and CPU therefore receive the same complete logical binding shape. Each
element owns its provider, symbol/timeframe, parameters, clock, limits, and
`OutputSink`; caller array order is execution identity. The GPU runtime
resolves provider contexts asynchronously, materializes only artifact-required
numeric series, converts them to the target profile, validates a common row
extent per context, and packs its private buffers. Fixed-width
int/float/bool/enum parameters share the ordinary resolver and are packed per
execution.
Source/string/color parameters and requests remain fail-closed exclusions.

For every concrete binding, the GPU runtime loads the artifact's JS sidecar and
uses `JSRuntime`'s provisional bind-only phase. The generated `bind` section
evaluates immutable aliases and bound history expressions against the concrete
parameters and provider extent, then reports capacities by published frame id
and slot. The provisional CPU frame is discarded before allocation. The GPU
runtime validates the sidecar manifest against the artifact, but never reads a
Program or interprets a Tea expression itself.

`maxRowsPerChunk` is a physical ceiling whose default is 65,536 rows. Dense
result capacity is exact from each execution's sink requirements: a complete
stream reserves the chosen chunk rows, while `denseRows: 'final'` reserves one
row regardless of chunk size. Callers never allocate it, and `maxGpuBytes` or
device buffer limits may reduce the chosen chunk. Sparse effects use one fixed
region per execution when requested; `effects: 'none'` allocates no logical
effect records for that execution. Otherwise, when
`effectRecordsPerExecution` is omitted, its size is derived from the
artifact's conservative maximum effects per row; an explicit value cannot be
smaller than one row's proven maximum.

Each Program execution owns a disjoint read-write GPU-buffer range and remains
device-resident across `runChunk()` calls. Its compile-time fixed prefix holds
`nextRow`, frame topology, activation/init flags, scratch values, and two-word
history descriptors; bind-sized committed-history payloads follow the prefix.
The job descriptor publishes that binding's state offset and word count. Thus
one shader can execute parameter bindings whose history capacities differ.
Reusable dense/effect buffers cover only the current chunk. Every dispatch
executes absolute rows from that execution's cursor, so `bar_index`, final-bar
behavior, row ids, and package-global state are independent of chunk
boundaries. Completed executions become inert while longer executions
continue.

The persistent state contains only temporally observable slots. A
history-free per-bar function receiver or parameter stays in a mutable WGSL
function local; a history-bearing formal is projected into its call-site frame.

Storage remains the authoritative state between dispatches. At session
creation, the runtime may select a compiler-ranked, whole-segment portion of
the fixed state prefix to stage in workgroup memory for one dispatch.
Binding-sized history payloads stay in storage. The selected workgroup size
and prefix respect both device limits and `maxCacheBytesPerWorkgroup`; zero
budget selects the storage-only entry point. The runtime also stays storage-only when
the workgroup contains one Program execution or the artifact owns more than 16
cache segments: at those boundaries, cache copying and generated address
routing cost more than the staged accesses they replace. `GpuRunSummary.cache`,
and therefore the public GPU `ExecutionSummary`, records the resulting mode,
workgroup size, cached bytes per execution and workgroup, and selected segment
ids.

After dispatch, the runtime copies and decodes only the transports requested
by each execution's sink. Complete dense streams use the current chunk;
final-only streams read one row on the absolute final bar. Effect-declining
executions have no logical sparse region, and an all-declining session skips
effect clear, copy, map, and decode entirely. Mixed capabilities are planned
independently per execution. The runtime validates all requested data before
publishing one atomic dense/effect unit per absolute row. `runChunk()` reports
only binding row ranges and `runAll()` only binding row totals; caller sinks
own all actual results. Rebinding a different provider grid does not regenerate
WGSL.

An overflow or decode error publishes none of the current chunk and makes the
session terminal-failed. A sink exception is also terminal: already advanced
device state is never retried, so effects cannot duplicate. Earlier successful
chunks remain published unless the caller supplied a transactional sink.
`dispose()` releases every device and staging buffer and is idempotent.

Adapter selection and deployment policy stay with the host that injects the
`GPUDevice`. Broker matching, portfolio accounting, lifecycle calls, and event
payload construction remain ordinary emitted Tea code inside the shader; the
GPU runtime recognizes none of them.

## Context-local Heap

The Heap is the type-neutral arena for every source-hidden storage identity in
one `JSRuntime` context. Its opaque handle is `Ref<V>`: the type parameter ties
the reference to its payload, collection headers use one for persistent
backing, and struct values use one directly for their mutable source identity.
Slot versions reject stale references, arena identity rejects cross-context
references, and the stored runtime type id rejects mismatched cells.

Each payload kind supplies one `TypeInfo<A, V>` policy:

- `bytesFor(args)` reports the exact direct bytes before construction;
- `create(args)` constructs one cell payload;
- `bytesOf(value)` reports the exact direct bytes of an existing payload; and
- `trace(value, visit)` visits only its direct outgoing `Ref`s.

Before `create`, the Heap checks the transient cell and byte limits against
`bytesFor(args)`. The created payload's `bytesOf(value)` must equal that
estimate; disagreement is an internal type-info contract failure. Referenced
children are separate cells and are counted separately.

At most one active transaction exists in an arena. Allocation creates tentative
cells readable only through that transaction. A write to a committed identity
stages a complete replacement payload in a transaction-owned overlay;
transactional reads consult the overlay first, while `Heap.read` exposes only
committed state. Commit installs all replacements and makes tentative cells
committed. Abort deallocates tentative cells and discards the overlay. No
prepared-commit token, descriptor edit type, undo value, or mutation journal is
part of the Heap contract.

The Heap owns a precise committed root snapshot, but the runtime discovers it:
at a collection safe point, it scans all Heap-external persistent values in that
context and calls `replaceRoots`. `collect` then performs stop-the-world,
non-generational, non-moving Mark-Sweep, with no compaction. Mark starts from
the stored roots and recursively follows `TypeInfo.trace`; sweep privately
deallocates every unmarked committed cell and returns its slot to the free list.
A successful transaction marks the prior root snapshot stale, so collection is
forbidden until the runtime refreshes it.

Struct fields and collection payloads participate in the same `Ref` graph. One
visited-slot worklist therefore handles struct-to-struct,
struct-to-collection, collection-to-struct, sharing, and cycles. The runtime
scans only external owners; `TypeInfo.trace` alone discovers the Heap-internal
transitive closure.

Transient limits bound active allocations and staged replacement payloads.
Live limits are checked from the unique marked cells and their direct bytes
before sweep, so already-committed garbage does not count as retained state.
Each request child owns an independent Heap and receives the same per-context
Heap-limit configuration; the request-context count and fixed-width value
storage budgets remain execution-wide. Request result copying ensures no `Ref`
crosses between those arenas.

## Determinism

A module is a pure function of its Program; execution is a pure function of
(module, params, provider data, injected historical `timeNow`). Generated code
contains no `Date`, no `Math.random`, no host I/O — enforced by an emitter-level
guard and a test grep. The runtime also never reads the clock. Replay of the
same rows and injected time is byte-identical, which is what
makes golden traces and the tick/rollback property tests
(provisional-then-rollback ≡ never-executed; varip persistence) valid.

## Staged beyond this slice

Drawing/handle natives, persistent-trie/page optimizations behind the existing
collection contract, further network drivers (the quantmod roster —
alphavantage/tiingo with the same key treatment — as needed), live push
feeds, and V8-isolate embedding. None of them change the surface above;
they fill reserved entries.

Dynamic request contexts and an execution `Pause`/resume protocol are staged.
The current noder rejects every request whose symbol or timeframe is not
bind-time-known, so supported row execution never suspends to discover a child
context. Static children resolve completely during binding before row 0.
