---
title: GPU Lowering
hide_title: true
---

# GPU Lowering

Tea executes a deliberately narrow, generic `Program` subset on WebGPU. The
boundary is fail closed: unsupported Program constructs produce diagnostics
and no WGSL artifact. `tea sweep` selects this target by default, while
`tea run --gpu` selects it for one binding.

## One compiler, reusable target artifacts

```text
source
  │
  ▼
load → check → node
  │
  ▼
Program
  ├─ JS codegen   ─▶ JS module   ─▶ CPU bindings
  └─ WGSL codegen ─▶ WGSL artifact
                              │
                              ▼
             createGpuExecution(device, artifact, BindInputs[])
                              │
                              ▼
              resumable dispatch → readback → OutputSink
```

Both backends consume the same canonical Tea `Program`. WGSL codegen never
receives datasets, binding identities, capacities, or a device, and it never
special-cases `broker`, `portfolio`, `trade`, a coordinator type, or the
`strategy()` header.
An indicator inside the same generic subset follows the identical path.

`analyzeWgslEligibility(program)` reports support.
`compileProgramToWgsl(program)` returns either those diagnostics or a complete,
bind-independent artifact containing the shader, the ordinary generated JS
binding module, numeric contract, required inputs, output/effect schemas, and
physical layouts. The artifact remains reusable when only datasets or the
binding grid change. The JS sidecar is generated from the same Program and
contains only the existing `init`/`bind` protocol; it is not a second compiler
or a second history-expression evaluator.

## Executable deterministic subset

Each binding instantiates one independent Program execution and advances its
bars sequentially. One WebGPU compute invocation processes one such execution;
the invocation index is a physical mapping, not Tea-visible identity. A
workgroup only groups invocations for scheduling and has no semantic role. The
current subset supports the constructs used by the deterministic strategy
example, including:

- required numeric series represented as f32 values or Tea `na`;
- `bar_index` and `barstate.islast`, derived from absolute row and binding
  extent;
- statically projected root and call-site frames, including persistent `var`
  locals initialized when their declarations are first reached;
- constant, bind-resolved, or explicitly capped history on frame values, plus
  direct provider-series history, advancing once per committed bar rather than
  once per function call;
- nullable floats and ints, bools, enums, and interned literal strings/colors;
- closed acyclic free functions whose reachable value closure contains no
  struct references;
- arithmetic, comparisons, boolean operations, conditionals, numeric range
  loops, and the supported native surface including `math.abs`, `math.max`,
  `math.min`, and `math.floor`;
- one unconditional top-level scalar channel per emitted output, of type
  float, int, bool, or enum;
- typed sparse effects with primitive, enum, or literal string/color payloads.

At least one numeric provider series is currently needed to define each
binding's extent. Persistent roots, dense output channels, and sparse effects
are otherwise independent: a Program need not have all three.

Struct references are deliberately staged out of the current WGSL subset.
Construction, field access/store, or a reachable struct-typed Name/method
produces one fail-closed diagnostic; the backend never falls back to the old
inline value representation. A later GPU-storage design may restore support
after CPU reference semantics are stable. Eligibility remains a property of
the complete reachable Program closure, and a checked-in execution config may
select JavaScript regardless of WGSL eligibility.

The trade families remain ordinary Tea code rather than host or IR wrappers.
While their reachable state uses structs, they fail the generic StructType gate
like any other program; codegen contains no package- or strategy-name special
case.

## Numeric contract

The GPU backend is explicit rather than pretending to be bit-identical to the
JavaScript f64 runtime:

- Tea floats use `f32`;
- Tea ints use wrapping `i32`;
- bool uses `u32` zero or one;
- nullable values carry a separate validity tag;
- divide-by-zero and non-finite float results become Tea `na`.

CPU comparison uses the artifact's declared tolerance, currently:

```text
max(0.0001, abs(expected) * 0.00002)
```

That tolerance is local. It cannot guarantee identical threshold branches: a
small f32 difference at a comparison can change a signal and then compound into
a materially different backtest. Sweep reports therefore identify their
numeric profile, and GPU-selected candidates should be rerun on CPU `js-f64`
for the authoritative report. Exact decimal or f64-equivalent GPU accounting is
a separate target capability.

## Provider-backed execution sessions

The public runtime accepts the same complete logical bindings as CPU batching:

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

await execution.runChunk(); // one bounded dispatch and publication
await execution.runAll(); // finish every Program execution
execution.dispose();
```

Each `BindInputs` supplies its provider, optional symbol/timeframe, parameters,
deterministic clock, limits, and `OutputSink`. The runtime resolves every
provider context, materializes only the artifact's required numeric series,
and packs executions in caller order. Fixed-width int, float, bool, and enum
parameters use the same resolver as CPU and are packed per execution. Source,
string, and color parameters and request contexts remain fail-closed target
exclusions.

Before allocating device state, the runtime loads the artifact's generated JS
binding module and runs the same provisional-frame bind phase used by
`JSRuntime`. That phase evaluates bound history expressions against each
binding's concrete parameters and provider extent. It reports capacities by
the artifact's published frame ids and slots; the runtime validates that
static topology and uses the reports only for physical allocation. It never
reads the Program or reconstructs Tea expressions.

The host injects the `GPUDevice` and therefore owns adapter and deployment
policy. The runtime owns shader diagnostics, physical validation and packing,
buffer creation, dispatch, readback, decoding, and sink delivery. Rebinding a
new dataset does not regenerate WGSL.

`maxRowsPerChunk` is a ceiling, defaulting to 65,536 rows. Dense capacity is
derived from each sink: complete streams reserve the chosen chunk rows, while
`denseRows: 'final'` reserves exactly one row per execution. `maxGpuBytes` and
device buffer limits can force a smaller chunk. An execution whose sink requests
`effects: 'none'` allocates no logical sparse records. Otherwise,
`effectRecordsPerExecution` is an optional fixed sparse-record region; when
omitted, the runtime derives it from the codegen-proved maximum effects per row
and the chosen chunk size.

## Persistent state and chunked readback

Each Program execution has a disjoint read-write state range. A compile-time
fixed prefix contains `nextRow`, the root and statically embedded call-site
frames, activation and initialization state, scratch values, and history
descriptors. Binding-specific committed-history payloads follow that prefix.
Each job descriptor carries the concrete state offset and word count, so two
parameter bindings may retain different history capacities while sharing one
shader. The state remains on the GPU across `runChunk()` calls. Each dispatch
executes:

```text
[nextRow, min(nextRow + chunkRows, totalRows))
```

Consequently `bar_index`, `barstate.islast`, result row ids, and effect row ids
remain absolute; a chunk boundary is not visible to Tea code. Completed or
shorter executions become inert while other executions continue.

Only values that must survive or define temporal behavior occupy that state.
History-free per-bar function receivers and parameters are ordinary mutable
WGSL function locals; history-bearing formals remain frame slots. This keeps
Tea call semantics while avoiding storage traffic for values that cannot be
observed after the call.

## Workgroup cache placement

The storage buffer is authoritative across dispatches. Codegen partitions the
fixed state prefix into statically sized segments and ranks them by expected
access density; binding-sized history payloads remain in storage. When a
session is created, the runtime chooses a device-valid workgroup size and the
largest whole-segment ranked prefix that fits
`maxCacheBytesPerWorkgroup` and the device's workgroup-storage limit. A zero
budget selects the storage-only entry point.

The cached entry point loads only that prefix into a disjoint per-invocation
slice of workgroup memory, runs the same emitted state transitions, and
flushes the slice before returning. This is a physical placement decision only:
it neither changes frame/history semantics nor makes one execution visible to
another. The run summary exposes the selected mode, workgroup size, cached byte
counts, and segment ids so hosts can report and benchmark the actual placement.

Complete dense storage is reusable and exact:

```text
[executionIndex][chunk-local row][dense scalar cell]
```

A final-only execution instead owns one dense row and writes it only on the
absolute final bar. Mixed complete and final-only executions have disjoint
result ranges.

Requested sparse storage is fixed per execution:

```text
status: {count, overflow, firstOverflowRow, firstOverflowEffect}
records[effectRecordsPerExecution]: {absoluteRow, effectId, typed payload}
```

An effect-declining execution has zero logical record capacity; when every
execution declines effects, the runtime skips effect clear and readback.

Codegen proves a conservative maximum effect count per row from the closed
call graph. Sequential calls add, exclusive branches take their maximum, and
compile-time-counted loops multiply. Numeric range loops do not otherwise need
a trip-count ceiling: a loop is rejected only when its body can emit effects
and the fixed transport cannot prove a bound. Effect-reachable recursion fails
eligibility. Overflow status remains a defensive check: an overflow
publishes none of the current chunk and terminal-fails the session rather than
truncating records.

After each dispatch the runtime copies only requested dense/effect regions into
reusable MAP_READ staging buffers. It validates and decodes those regions before
calling each binding's `OutputSink`. Dense outputs and sparse effects for one
absolute row share one publication. `runChunk()` returns only per-binding row
progress; sinks own the actual results.

If decoding or a sink throws, the execution becomes terminal-failed. Device
state that already advanced is never retried, preventing duplicate effects.
Earlier completed chunks remain published; callers needing whole-run atomicity
provide a transactional sink. `dispose()` releases all session buffers and is
idempotent.

## Real Dawn gate

Default Bun tests cover eligibility, artifact schemas/layouts, provider
preparation, resource sizing, and decoding contracts without loading a native
GPU device. The separate Node/Dawn gate exercises multiple independent
executions over multiple chunks and compares dense outputs plus typed sparse
effects with CPU execution:

```sh
bun run test:gpu
```

The canonical temporal-state examples use ordinary Tea library calls and the
ordinary CLI path:

```sh
tea execute examples/strategy/ema-cross/sweep.yaml
tea execute examples/strategy/turtle-system/sweep.yaml
```

The EMA source calls `ta.ema`, `ta.crossover`, and `ta.crossunder` directly.
Turtle additionally exercises parameter-bound `ta.sma`, `ta.highest`, and
`ta.lowest` ranges, core math natives, the direct scalar trade coordinator, and
typed fill effects. Their function-local state and parameter history use the
generic call-site frame machine and bind phase; no `ta`, trade family, broker,
or portfolio name is recognized by the backend.

## Fail-closed exclusions

The current backend emits no artifact for Programs requiring any of these:

- source/string/color parameters or request child contexts (fixed-width
  int/float/bool/enum parameters are packed per execution);
- unresolved dynamic frame-history requirements without an explicit cap, or
  `varip` execution;
- collections, tuples, collection iteration, or while loops;
- unsupported bind-time initialization or typed builtins;
- dynamic string construction (effect string literals are interned and
  supported);
- bound, multi-channel, conditional, nested, or non-scalar dense emissions;
- effect-reachable recursion, effect multiplicity without a provable transport
  bound, or payload shapes without a fixed physical representation.

Other unsupported native calls, receiver paths, or function-frame shapes also
fail closed with a specific diagnostic. This is a target-subset boundary, not
a separate strategy compiler or runtime model.

Historical epoch-millisecond `time` is one remaining builtin
exclusion. It does not fit this artifact's declared i32 integer carrier. That
is not an inherent inability to compare time on WebGPU: a future artifact can
publish an exact wide-integer representation such as two u32 words and lower
comparison/arithmetic against it. Turtle is not a reason to add that carrier,
because its former date inputs were generic TradingView backtest UI rather
than trading-system semantics and have been removed from the example.
