# The Tea runtime ABI (`rt`)

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
frames, rings, immutable storage, the main loop, provisional/commit, and
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
  abi: 1,
  aggregateLayouts: {layouts: [...]},     // root-wide LayoutId registry
  manifest: {
    series:  [{id, depth}, ...],          // sid -> numeric provider column
    execution: [{source, layout, depth}, ...], // eid -> typed execution builtin
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

`RUNTIME_ABI_VERSION` is the single version source and is currently `1`.
Before launch, this contract evolves in place; the runtime does not carry
compatibility branches for older generated modules.

An output channel's `type` is the human Tea spelling. The current ABI publishes
an exhaustive `transport` discriminant projected directly from the checked IR
type
(`int`, `float`, `bool`, `string`, `color`, `enum`, resource, output reference,
user type, or aggregate shape). Runtime transports branch only on that field;
they never recover machine semantics by parsing the display string.

`aggregateLayouts` appears once on the root `TeaModule`. Every request child
is a `ModuleCode` that inherits the same registry, Heap, and request-context
budget from `SharedExecutionState`; a child cannot define a second layout-id
namespace or move storage references across arenas.

Dense ids (`sid`, `eid`, `pid`, `oid`, `fid`, local slots) are assigned by the
lowering walk; the manifest is their single source of truth — the runtime
never re-derives ids from the Program. Series and execution inputs use
separate id spaces; numeric Tea type alone never moves a builtin between them.

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
rt.series(sid, offset); // numeric provider series and input.source params
rt.execution(eid, offset); // typed time/bar/barstate/syminfo/timeframe value
rt.param(pid); // bind-time scalar
rt.read(fr, slot, offset); // a name's history
rt.write(fr, slot, v);
rt.needsInit(fr, slot); // persistent declaration has not initialized yet
rt.initialize(fr, slot, v); // tentatively initialize at this lexical site
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
rt.emitEffect(effectId, payload); // ordered sparse append for this row attempt
// frame-aware bind section (against a provisional scratch-only frame)
rt.historyDepth(offset); // invalid history offsets normalize to zero
rt.bindDepth(fid, slot, bars); // a name's bound history depth
rt.bindSeriesDepth(sid, bars); // a series/input.source bound depth
rt.bindExecutionDepth(eid, bars); // a typed execution input's bound depth
rt.bindParamActive(pid, active); // resolved input enablement
rt.bindOutput(oid, argName, v); // an output's bind-time argument
rt.bindRequestOptions(rid, gaps, lookahead, ignoreInvalid, calcBars);
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
fetch the sub-frame at compartment `slot` of `fr`, creating its physical
storage on first use and tentatively activating it for this row attempt.
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

## Typed execution inputs

`ExecutionSpec.source` is a closed `{domain, field}` key. Its domain is only
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
sub-frame box per call-site slot, materialized lazily by `rt.frame` (frame
trees can also appear at runtime — dynamic requests instantiate whole trees
per context). Physical allocation does not mean the call site has executed:
each frame carries separate committed and scratch activation state. Calling
`rt.frame` tentatively activates its child for the current row attempt; abort
or suspension restores the pre-attempt activation tree, while final commit
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
  (na until written). **varip** scratch value and initialization bit survive
  successful provisional executions of the same row — the one storage class
  whose writes ticks accumulate.
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
- A throw or suspension invalidates scratch values, initialization bits,
  tentative frame activation, and buffered emissions, then aborts all
  tentative allocations. Committed state was never touched.

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
    source: Extract<ExecutionSource, {domain: 'syminfo' | 'timeframe'}>,
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
successful row attempt and cross the sink boundary in one `publish` call.
Suspended or failed attempts publish nothing. A sink exception makes the
binding terminal, so committed effects are never retried or duplicated.
Effect payload layouts admit primitives, strings/colors, enums, and recursively
fixed user values; collections, tuples, and resource handles are rejected.

The same resolution path supplies the primary context and every request
child. Provider series remain numeric and aligned to `rows`; typed execution
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
`src/gpu/contract.ts`. Its `abi` is currently `2`; the same module owns every
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

A dynamic-request suspension is part of the execution protocol: `executeRow`
closes and aborts the parent attempt before child execution can begin. The host
awaits `resolvePending()` and re-executes the SAME row. Tentative writes,
buffered emissions, and tentative storage from the failed attempt vanish; the
retry restores the exact pre-attempt varip candidate, which may come from an
earlier successful provisional tick. If a first-row varip Ring had no prior
candidate, retry reaches and reruns its declaration-site initializer. `runAll`
runs this loop itself.
