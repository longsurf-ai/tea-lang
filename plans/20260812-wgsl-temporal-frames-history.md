# WGSL temporal frames and history

Status: complete; Stages A–F implemented, reviewed, and measured.

## 1. Objective

Compile Tea's existing temporal semantics directly to WGSL so ordinary
Tea-authored functions may own persistent locals and historical parameters.
The first user-visible proof is that this source runs unchanged on JavaScript
and WebGPU:

```tea
fast = ta.ema(close, fast_length)
slow = ta.ema(close, slow_length)
long_signal = ta.crossover(fast, slow)
close_signal = ta.crossunder(fast, slow)
```

There is no `ta` recognition, EMA intrinsic, strategy-only compiler, bytecode,
instruction pointer, operand stack, or shader interpreter. Both backends lower
the same `Program`; each implements the same temporal machine.

## 2. Semantic contract

One Program execution owns one context, parameter set, row cursor, root frame,
and static call-site frame tree. Parallel GPU invocations own independent
executions. A workgroup is only a physical scheduling/cache group and has no
Tea meaning.

The shared contract is:

1. A written user-function or method call site owns one stable `SlotId`.
2. A child frame's identity is `(parent frame instance, SlotId)`, not its
   `IrFunc` alone. Two written calls to `ta.ema` therefore own distinct state.
3. Physical frame storage is distinct from semantic activation. A frame is
   semantically inactive until its call site first executes. Activation is
   tentative within the current row transaction and becomes durable only through
   the same commit protocol as values. Abort/suspension restores the previous
   activation state. Once durably active, the frame participates in every
   subsequent fixed-cadence row reset and commit, even when that call site is
   skipped on a later row.
4. History advances once per successfully committed row, never once per
   function call. A skipped active call commits typed-empty per-bar
   parameters/locals and carries persistent values forward.
5. Repeated execution of one written call site within a row shares its scratch;
   the final scratch value commits once.
6. `var` and `varip` initialization occurs when the declaration is first
   reached, after call arguments have been bound. It is tentative until row
   commit; abort/suspension discards it. `varip` preserves a successful
   same-row provisional candidate under the existing CPU contract.
7. Offset zero reads scratch. Positive offset `k` reads the `k`th prior
   committed row. Invalid, negative, fractional, non-safe, or unavailable
   offsets return the place's typed empty value.
8. Provider-series history indexes the shared input series directly. It is
   never copied into each execution's frame history.

The current JavaScript runtime is the oracle for items 1-2, 4-5, and 7-8.
Items 3 and 6 are intentional corrections: activation is made transactional,
and persistent-local initializers move from eager frame reset to their lexical
declaration. Both accidents must be fixed before CPU/GPU parity is asserted.

## 3. Shared Program correction: declaration-reached initialization

### 3.1 IR

`InitName` contains the target `Name` and initializer expression. Unlike
`WriteName`, it executes its expression only while the persistent slot remains
semantically uninitialized.

Initializer ownership has been removed from `Name.init`; the initializer is
executable code at its declaration site, not frame-layout metadata.

- A root or function-local persistent declaration nodes to `InitName` in its
  lexical position.
- Reached package-global initializers node to dependency-ordered `InitName`
  statements prepended to the root body.
- `Program.init` retains its existing bind-time meaning and is not reused.
- IR visitors, depth analysis, effect analysis, dumper, and invariant tests
  traverse the initializer expression like any other statement expression.

### 3.2 JavaScript ABI/runtime

Replace generated frame initializer thunks with two generic frame operations:

```text
needsInit(frame, slot) -> bool
initialize(frame, slot, value) -> void
```

Generated `InitName` code checks `needsInit` before evaluating the expression,
then publishes the value with `initialize`. The runtime tracks tentative
scratch initialization separately from committed initialization.

Frame activation follows the same model. A physically allocated subframe has
committed-active and transaction-active state. Opening the frame marks only the
transaction. Abort restores the pre-transaction state recursively. A successful
provisional execution may retain an explicit same-row activation candidate;
the next execution of that row starts from that candidate, and the final row
commit promotes it. Merely allocating a subframe never activates it.

Row reset and commit rules become:

- uninitialized `var`/`varip`: empty scratch, initializer remains eligible;
- initialized `var`/`varip`: seed from last committed value;
- an unreached persistent declaration does not become initialized merely
  because its frame commits;
- successful final commit makes a reached initialization durable;
- abort restores the pre-transaction initialization state;
- successful provisional `varip` initialization remains the same-row
  candidate, consistent with existing `varip` scratch behavior.

This also fixes `f(x) => var float first = x; first`: `x` is written into the
callee frame before the body reaches `InitName`.

### 3.3 Acceptance

- initializer reads the current call argument;
- an initializer under a false branch does not run;
- first later branch entry initializes once;
- two written call sites initialize independently;
- repeated same-site calls initialize once;
- suspension/error reruns an uncommitted initializer;
- a first call followed by suspension/error does not durably activate a frame;
- a successful provisional first call has explicit same-row candidate
  behavior, including a later final execution that skips the call;
- skipped active frames keep bar-based history;
- existing root/package-global/`varip` behavior remains covered.

## 4. Static frame projection

Build one deterministic frame template per root/`IrFunc` from the existing
Program facts:

```text
FrameTemplate
  owner: Program | IrFunc
  locals: receiver, parameters, lexical locals, owned root names
  children[SlotId]: FrameTemplate
```

The call graph must remain closed and acyclic. Each template has a canonical
relative physical layout. Embedding a child at each call-site slot yields a
static tree of frame instances without duplicating WGSL function bodies.

Every emitted WGSL function receives `frame_base: u32`. A call lowers as:

```text
child_base = frame_base + child_offset[call.slot]
```

The same `IrFunc` may therefore execute against many independent frame bases.
Frame layout is derived from Program identity and slots; runtime never
reconstructs it.

## 5. GPU execution state

Each execution receives one aligned range in the existing read-write state
buffer. The buffer is word-addressed and its layout is published by the WGSL
artifact.

```text
Execution state range
  execution header: initialized, next row
  committed/tentative frame activation epochs
  persistent-slot initialization bits
  current scratch cells needed across calls
  history descriptors
  binding-sized committed history payloads
```

Each slot owns one scratch cell. A history-bearing slot also owns a two-word
descriptor in the fixed frame prefix; its concrete `keep` cells are allocated
after bind:

```text
perBar / receiver / parameter: keep = resolved history depth
var:                           keep = max(resolved history depth, 1)
```

The fixed frame topology and descriptor positions are bind-independent. The
artifact also embeds the ordinary generated JS binding module; the GPU runtime
runs its provisional bind phase exactly as CPU does, then allocates each
execution's history payload from the reported depths, clamped to that
execution's row count. The runtime never rereads Program or evaluates a second
history expression.
The root frame is durably active from execution initialization with epoch row
zero. Each child frame retains committed/tentative activation state and its
activation epoch. Under fixed cadence, the absolute `next_row` plus activation
epoch is the single source of truth for availability and the ring index, so no
independent per-ring cursor/count is stored. A read before activation or beyond
available committed rows is typed empty even when physical capacity exists. A
provider-series read checks `absolute_row >= offset` before subtracting the
unsigned row index.

The fixed-prefix plus bind-sized payload model supports:

- free functions and const/mutable methods;
- scalar, enum, color, string-literal, and fixed user-value layouts already
  supported by WGSL;
- persistent `var` locals;
- constant, bound, and capped history on Names and function parameters;
- direct provider-series history;
- fixed cadence, multi-chunk resume, and multiple independent executions.

`varip`, requests, collections, recursion, and effectful initialization remain
fail-closed under their existing target restrictions.

### Row protocol

For every row in a chunk, generated WGSL performs:

1. reset every active frame's scratch baseline;
2. execute the directly lowered Program body;
3. activate a child frame on its first reached call;
4. bind receiver/arguments before entering the callee body;
5. execute declaration-site `InitName` operations;
6. read/write scratch and committed history through typed helpers;
7. publish dense outputs/effects through the existing bounded transports;
8. commit all active frames once;
9. advance the absolute execution cursor.

No atomics or barriers are required for semantic state: one invocation owns
one execution's state and effect slice.

## 6. Tiered physical placement

Storage is authoritative across dispatches. Workgroup memory is a transparent
per-dispatch cache; private/function memory holds ephemeral expression values.

The WGSL artifact publishes deterministic state segments with:

- static relative storage offset and word count;
- alignment and logical owner;
- estimated reads/writes per row;
- mandatory grouping boundaries, so a ring's metadata and cells move
  together;
- a compiler-ranked cache order and stable override identifiers/defaults.

The bind-independent lowerer knows sizes and static access frequency, but not
the target device's limits. It emits a storage fallback plus pipeline-overridable
workgroup size/cache budget. `createGpuExecution` owns the device-selected
cache prefix, absolute per-execution `state_offset/state_words`, and pipeline
override values. It jointly chooses workgroup size and a valid cache prefix
using the device limits, execution count, and the published segment boundaries.
The exact resource equation is:

```text
workgroup bytes = cache words per execution × invocations per workgroup × 4
```

The implemented planner chooses a power-of-two workgroup size within the
artifact, device, and execution-count limits, then takes the largest complete
compiler-ranked segment prefix within both the device limit and the default
16 KiB caller cache cap. It does not split a segment merely to consume more
workgroup memory.

At dispatch start, each invocation copies its execution's selected state
segments from storage into its own workgroup-memory slice, addressed from
`local_invocation_index * cache_words_per_execution`. It processes the
whole chunk there, then flushes dirty segments to storage before returning.
Uncached segments use address-space-specific typed helpers against storage;
WGSL pointers from the storage and workgroup address spaces are never treated
as interchangeable. A zero-byte cache is always valid and semantically
identical, implemented by a storage-only entry point or a one-word dummy array
rather than an invalid zero-length WGSL array.

No workgroup barrier appears in the semantic row loop. Each invocation owns a
disjoint cache slice, and divergent early returns would make a later workgroup
barrier invalid. Dispatch uses the runtime-selected workgroup size rather than
assuming the artifact's default.

Requested outputs and effects remain storage-buffer transports; they are not
cached in workgroup memory. A final-dense sink may reserve only one result row,
and an effect-declining sink may elide logical effect transport entirely.

Acceptance includes forced zero-cache, partial-cache, and full-cache variants
producing byte-for-byte equivalent decoded results. Resource planning must
account for workgroup bytes and storage bytes separately and must never exceed
device limits.

Workgroup caching is an optional optimization after storage-only temporal
execution is correct. It cannot gate the canonical `ta.*` proof.

## 7. Bind-resolved depth forms

Constant depth first enabled `ta.ema`, `ta.crossover`, and `ta.crossunder`.
Artifact ABI v2 extends the same frame topology to:

- `Bound`: runtime evaluates the bind-known expression per execution and
  allocates the resolved ring capacity;
- `Capped`: runtime allocates the bound and generated reads validate the
  current dynamic offset against it;
- heterogeneous execution sizes: descriptors carry `state_offset` and
  `state_words`, runtime shrinks capacities to an execution's row count, and
  session sizing sums checked state ranges.

The artifact owns the resolver executable: the same generated JS `init`/`bind`
module used by CPU. The GPU runtime may execute only that published binding
module; it may not inspect Tea source, walk Program, infer history from WGSL
text, or maintain a parallel evaluator.

## 8. Implementation sequence

### Stage A — semantic correction ✅

- Add `InitName` to Program and migrate noder/visitors/dumper/depth/effects.
- Migrate JS lowering/runtime away from eager frame initializer thunks.
- Lock declaration-reached, rollback, skipped-call, and argument-dependent
  initialization tests.
- Update IR/runtime/memory-model documentation.

Gate complete: JavaScript tests cover lexical initialization, transactional
activation across error/suspension/provisional execution, independent and
repeated call sites, and skipped active-frame history.

### Stage B — frame inventory and constant history ✅

- Add a deterministic frame-template/layout projection shared by WGSL
  validation and emission.
- Replace WGSL function-local emulation with `frame_base`-addressed state.
- Lower activation, scratch, persistent init, constant rings, and history
  reads for all three user call modes.
- Retain direct series history and existing output/effect transports.

Gate complete: WGSL compilation tests cover two EMA sites, cross parameter history,
conditional activation, skipped calls, repeated calls, and no `ta` names in
the backend.

### Stage C — session state and chunk resume ✅

- Publish state layout/stride in the artifact.
- Allocate/validate the flat execution-state ranges in `createGpuExecution`.
- Carry state over multiple `runChunk` calls and preserve absolute row
  semantics.
- Decode no state on the host during normal execution.
- Use checked arithmetic for every state sum/product and validate
  `maxBufferSize`, `maxStorageBufferBindingSize`, and related device limits
  before allocation. If one session cannot fit, fail with an actionable
  resource error in this slice; automatic partitioning is a later scheduler
  optimization.

Gate complete: Node 22 Dawn differential tests cover multiple executions with different
parameters and row counts across forced one-row chunks.

### Stage D — canonical example and storage-only proof ✅

- Rewrite `examples/strategy/ema-cross/strategy.tea` to ordinary `ta.*` calls.
- Remove the hand-written EMA UDT and `previous_spread` workaround.
- Run CPU/GPU parity on the checked-in fixture.
- Force one-row chunks and multiple executions with different parameters and
  row counts.

Gate complete: `tea run`, GPU-default `tea sweep`, and `tea sweep --cpu` all accept the
same source and parameters; the CPU/GPU tolerances are explicit.

### Stage E — optional workgroup cache planner ✅

- Publish ranked cache segments and override constants.
- Select workgroup size/cache prefix from device limits.
- Generate load/flush and storage-spill paths.
- Include cache decisions and bytes in execution statistics for benchmarking.

Gate complete: zero/partial/full cache modes are numerically equivalent under
Dawn; malformed artifact/device-limit combinations fail before dispatch. The
public execution summary reports the selected placement and honest host timing
categories.

### Stage F — large-data proof ✅

- Run the large Binance minute-data sweep, reporting parse/preparation,
  dispatch/readback, total throughput, cache placement, and result summaries
  separately.

Corpus and benchmark results:

- normalized CSV: 400,623,460 bytes;
- 4,717,208 ordered minute rows from 2017-08-17 04:00 UTC through
  2026-08-11 23:59 UTC;
- six retained numeric columns: 226,425,984 bytes;
- standalone bounded-memory CSV parse: approximately 3.10 seconds;
- 35 source-data gaps totaling 8,632 missing minutes, reported rather than
  silently filled.

On the local Apple GPU through Node 22 Dawn, with final-dense reporting and
effect transport disabled for the sweep:

| mode             |       executions | logical bar-executions | execution time | throughput |
| ---------------- | ---------------: | ---------------------: | -------------: | ---------: |
| GPU storage-only |                1 |              4,717,208 |       189.81 s |   24,852/s |
| GPU storage-only |               25 |            117,930,200 |       264.07 s |  446,593/s |
| CPU sample       | 1 × 100,000 rows |                100,000 |        13.73 s |    7,284/s |

The 25-execution sweep performs 25× the logical work in 1.39× the
single-execution GPU time, a 17.97× throughput gain. The matched 100,000-row
sample is 3.31× faster on GPU. The full CPU run was stopped after 477 seconds;
the measured CPU sample projects approximately 648 seconds for one full
execution, so that projection is reported as an estimate rather than a
completed measurement.

The matched 100,000-row control-flow results were identical (11,529 fills and
5,764 completed round trips), and terminal EMA values stayed within the
declared f32 target tolerance. Recursive all-in portfolio accounting exposed a
separate numerical boundary: total fees were 4,512.46 on the JavaScript f64
runtime and 4,502.84 on WGSL f32. The benchmark therefore proves temporal
execution, trade-path parity, and throughput; it does not claim long-horizon
f64-equivalent portfolio totals. A precision policy for recursively compounded
accounting remains separate from the frame/history architecture.

An attempted large-prefix cache run was slower than storage-only and was
stopped after 400.9 seconds. The planner now stays storage-only for a
single-execution workgroup or artifacts with more than 16 routed segments;
small artifacts retain tested zero/partial/full placement. This is a measured
cost guard, not a semantic distinction.

Gate complete: the public summary reports preparation, encode/submit,
GPU-completion-plus-readback, decode/publication, cache placement, and total
execution separately. Pure kernel time is not claimed without timestamp
queries.

### Stage G — bind-sized history and numeric ranges ✅

- Bump the physical artifact to ABI v2 and publish the ordinary generated JS
  binding module alongside WGSL.
- Reuse `JSRuntime`'s provisional bind phase to resolve history capacities for
  every concrete binding, then pack per-job state offsets, word counts, and
  relative history descriptors.
- Keep only the fixed frame prefix eligible for workgroup caching; history
  payloads remain authoritative storage.
- Lower finite numeric ranges with compile-, bind-, or row-time bounds without
  an arbitrary trip-count ceiling. Keep effect transport sizing as a separate
  proof obligation.
- Lower nullable `math.abs`, `math.max`, `math.min`, and `math.floor` under the
  declared WGSL numeric profile.
- Remove TradingView's generic date-window UI from the Turtle strategy and run
  its equivalent 36-binding WebGPU and JS/f64 grids.

Gate complete: focused bind/layout tests cover heterogeneous capacities and
malformed sidecars; real Dawn runs two Turtle bindings with different ATR and
channel depths across multiple chunks, and the checked-in 36-binding Turtle
config completes on WebGPU.

## 9. Required regression matrix

- frame identity: same function at two written call sites;
- nested frame identity: two parents calling a shared nested call site;
- activation: never called, first called late, skipped after activation;
- function-call count: same call site executed repeatedly in one row;
- initialization: argument-dependent, conditional, abort/retry, `varip`
  (Stage A JavaScript gate; GPU `varip` remains staged);
- history: offsets 0/1/depth, unavailable and invalid offsets;
- call modes: free, const method, mutable method with success-only copy-out;
- execution isolation: different parameters and row counts;
- chunking: every possible boundary around a crossover;
- placement: storage only, partial workgroup cache, full eligible cache;
- outputs/effects: order and payload parity remain unchanged when requested;
  final-dense and effect-declining sink capabilities may elide unrequested
  transport. The first GPU slice admits only Programs that cannot suspend and
  retains terminal failure on effect overflow; full GPU transaction rollback is a
  later capability.

## 10. Non-goals of the first implementation

- A bytecode or SSA interpreter on the GPU.
- Dynamic recursion or a push/pop call stack.
- Sharing semantic state between executions in a workgroup.
- Caching outputs/effects in workgroup memory.
- Making workgroup memory authoritative across dispatches.
- Special handling for `ta`, EMA, crossover, strategy, broker, or portfolio.
- Shipping `Bound`/`Capped` depths before the constant-depth architecture and
  differential suite are green.
