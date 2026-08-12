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

One invocation lane owns one binding and advances its bars sequentially.
Different lanes are independent. The current subset supports the constructs
used by the deterministic strategy example, including:

- required numeric series represented as f32 values or Tea `na`;
- `bar_index` and `barstate.islast`, derived from absolute row and binding
  extent;
- `var` roots and package globals whose initialization is independent of the
  current row;
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

## Provider-backed execution sessions

The public runtime accepts the same complete logical bindings as CPU batching:

```ts
const execution = await createGpuExecution(
  device,
  artifact,
  bindings, // readonly BindInputs[]
  {maxRowsPerChunk, effectRecordsPerLane, maxGpuBytes},
);

await execution.runChunk(); // one bounded dispatch and publication
await execution.runAll(); // finish every lane
execution.dispose();
```

Each `BindInputs` supplies its provider, optional symbol/timeframe, parameters,
deterministic clock, limits, and `OutputSink`. The runtime resolves every
provider context, materializes only the artifact's required numeric series,
and packs lanes in caller order. Fixed-width int, float, bool, and enum
parameters use the same resolver as CPU and are packed per lane. Source,
string, and color parameters and request contexts remain fail-closed target
exclusions.

The host injects the `GPUDevice` and therefore owns adapter and deployment
policy. The runtime owns shader diagnostics, physical validation and packing,
buffer creation, dispatch, readback, decoding, and sink delivery. Rebinding a
new dataset does not regenerate WGSL.

`maxRowsPerChunk` is a ceiling, not a result allocation. Dense capacity is
derived exactly from lane count, selected chunk rows, and artifact result
schema. `maxGpuBytes` can force a smaller chunk. `effectRecordsPerLane` is an
optional fixed sparse-record region; when omitted, the runtime derives it from
the codegen-proved maximum effects per row and the chosen chunk size.

## Persistent state and chunked readback

Each lane has a disjoint read-write state block. It contains supported
persistent roots, package globals, initialization bits, and `nextRow`. That
state stays on the GPU across `runChunk()` calls. Each dispatch executes:

```text
[nextRow, min(nextRow + chunkRows, totalRows))
```

Consequently `bar_index`, `barstate.islast`, result row ids, and effect row ids
remain absolute; a chunk boundary is not visible to Tea code. Completed or
shorter lanes become inert while other lanes continue.

Dense storage is reusable and exact:

```text
[lane][chunk-local row][dense scalar cell]
```

Sparse storage is fixed per lane:

```text
status: {count, overflow, firstOverflowRow, firstOverflowEffect}
records[effectRecordsPerLane]: {absoluteRow, effectId, typed payload}
```

Codegen proves a conservative maximum effect count per row from the closed
call graph. Sequential calls add, exclusive branches take their maximum, and
statically bounded loops multiply. Effect-reachable recursion or an unbounded
loop fails eligibility. Overflow status remains a defensive check: an overflow
publishes none of the current chunk and terminal-fails the session rather than
truncating records.

After each dispatch the runtime copies dense results, effect status, and sparse
records into reusable MAP_READ staging buffers. It validates and decodes the
whole current chunk before calling each binding's `OutputSink`. Dense outputs
and sparse effects for one absolute row share one publication. `runChunk()`
returns only per-binding row progress; sinks own the actual results.

If decoding or a sink throws, the execution becomes terminal-failed. Device
state that already advanced is never retried, preventing duplicate effects.
Earlier completed chunks remain published; callers needing whole-run atomicity
provide a transactional sink. `dispose()` releases all session buffers and is
idempotent.

## Real Dawn gate

Default Bun tests cover eligibility, artifact schemas/layouts, provider
preparation, resource sizing, and decoding contracts without loading a native
GPU device. The separate Node 22 Dawn gate exercises real multi-lane,
multi-chunk dispatch and compares dense outputs plus typed sparse effects with
CPU execution:

```sh
bun run test:gpu
```

The human-facing deterministic strategy uses the ordinary CLI path:

```sh
tea sweep examples/strategy-cpu-gpu.tea \
  -i examples/strategy-bars.csv --slippage 0:0.2:0.1
```

Its literal command ids and broker-owned typed lifecycle effects are supported;
they are emitted and decoded as ordinary Tea values, not replayed by the host.

## Fail-closed exclusions

The current backend emits no artifact for Programs requiring any of these:

- source/string/color parameters or request child contexts (fixed-width
  int/float/bool/enum parameters are packed per lane);
- history reads/buffers or `varip` execution;
- collections, tuples, collection iteration, while loops, or emitted loops the
  WGSL statement emitter cannot lower;
- `Program.init` or unsupported typed execution inputs;
- persistent initializers that depend on the current row;
- dynamic string construction (effect string literals are interned and
  supported);
- bound, multi-channel, conditional, nested, or non-scalar dense emissions;
- effect-reachable recursion, data-dependent effect multiplicity, or payload
  shapes without a fixed physical representation.

Other unsupported native calls, receiver paths, or function-frame shapes also
fail closed with a specific diagnostic. This is a target-subset boundary, not
a separate strategy compiler or runtime model.
