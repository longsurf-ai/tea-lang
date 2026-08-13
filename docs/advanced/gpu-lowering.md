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
special-cases `broker`, `portfolio`, `strategy`, or the `strategy()` header.
An indicator inside the same generic subset follows the identical path.

`analyzeWgslEligibility(program)` reports support.
`compileProgramToWgsl(program)` returns either those diagnostics or a complete,
bind-independent artifact containing the shader, numeric contract, required
inputs, output/effect schemas, and physical layouts. The artifact remains
reusable when only datasets or the binding grid change.

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
- constant-depth history on frame values and direct provider-series history,
  advancing once per committed bar rather than once per function call;
- nullable floats and ints, bools, enums, interned literal strings/colors, and
  acyclic fixed user values with explicit physical layouts;
- closed acyclic free functions, const methods, and mutable methods, including
  copy-out to a directly rooted receiver;
- arithmetic, comparisons, boolean operations, conditionals, and the native
  surface used by the deterministic component graph;
- one unconditional top-level scalar channel per emitted output, of type
  float, int, bool, or enum;
- typed sparse effects with primitive, enum, literal string/color, or
  recursively fixed user-value payloads.

At least one numeric provider series is currently needed to define each
binding's extent. Persistent roots, dense output channels, and sparse effects
are otherwise independent: a Program need not have all three.

## Numeric contract

The GPU target is explicit rather than pretending to be bit-identical to the
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

That tolerance is local, not a promise that millions of recursively compounded
f32 accounting operations remain close to a JavaScript f64 total. Long-horizon
backtests must report this target precision explicitly; exact decimal or
f64-equivalent accounting is a separate target capability.

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

Each Program execution has a disjoint read-write state block. It contains the
root frame, statically embedded call-site frames, activation and initialization
state, committed history, scratch values, and `nextRow`. That state stays on
the GPU across `runChunk()` calls. Each dispatch executes:

```text
[nextRow, min(nextRow + chunkRows, totalRows))
```

Consequently `bar_index`, `barstate.islast`, result row ids, and effect row ids
remain absolute; a chunk boundary is not visible to Tea code. Completed or
shorter executions become inert while other executions continue.

Only values that must survive or define temporal behavior occupy that arena.
History-free per-bar function receivers and parameters are ordinary mutable
WGSL function locals; history-bearing formals remain frame slots. This keeps
Tea call semantics while avoiding storage traffic for values that cannot be
observed after the call.

## Workgroup cache placement

The storage buffer is authoritative across dispatches. Codegen also partitions
each execution's state into statically sized segments and ranks them by expected
access density. When a session is created, the runtime chooses a device-valid
workgroup size and the largest whole-segment ranked prefix that fits
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
statically bounded loops multiply. Effect-reachable recursion or an unbounded
loop fails eligibility. Overflow status remains a defensive check: an overflow
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
GPU device. The separate Node 22 Dawn gate exercises multiple independent
executions over multiple chunks and compares dense outputs plus typed sparse
effects with CPU execution:

```sh
bun run test:gpu
```

The canonical temporal-state example uses ordinary Tea library calls and the
ordinary CLI path:

```sh
tea sweep examples/ema-cross-strategy.tea \
  -i examples/ema-cross-bars.csv \
  --fast_length 3:7:2 --slow_length 10:14:2
```

The source calls `ta.ema`, `ta.crossover`, and `ta.crossunder` directly. Their
function-local persistent state and parameter history use the generic static
call-site frame machine; no `ta` name is recognized by the backend.

## Fail-closed exclusions

The current backend emits no artifact for Programs requiring any of these:

- source/string/color parameters or request child contexts (fixed-width
  int/float/bool/enum parameters are packed per execution);
- non-constant frame-history requirements or `varip` execution;
- collections, tuples, collection iteration, while loops, or emitted loops the
  WGSL statement emitter cannot lower;
- unsupported bind-time initialization or typed execution inputs;
- dynamic string construction (effect string literals are interned and
  supported);
- bound, multi-channel, conditional, nested, or non-scalar dense emissions;
- effect-reachable recursion, data-dependent effect multiplicity, or payload
  shapes without a fixed physical representation.

Other unsupported native calls, receiver paths, or function-frame shapes also
fail closed with a specific diagnostic. This is a target-subset boundary, not
a separate strategy compiler or runtime model.
