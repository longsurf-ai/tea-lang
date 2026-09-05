---
title: GPU lowering and execution
sidebarTitle: GPU lowering
---

Tea's WGSL backend consumes the same checked Program as the TypeScript backend. It either
emits one complete `CompiledWgslProgram` or returns a precise eligibility
ledger. It never emits a partial shader and never falls back silently.

## One reusable artifact

The artifact contains:

- WGSL source and entry points;
- the generated TypeScript Module used for parameter binding;
- required numeric-series ids;
- parameter contracts and physical output layouts;
- fixed job-descriptor offsets and scalar strides;
- persistent frame/history state layout;
- result channels and append-output codecs;
- the compiler-proved maximum effects per row.

Arrow schemas live once in the embedded Module. Result channels and append
codecs describe only GPU buffer locations; they do not repeat logical schemas.

The artifact contains no device, dataset, parameter scenario, buffer, or
application source object. One artifact can execute many concrete bindings.

## Concrete GPU bindings

Applications materialize numeric arrays before calling the runtime:

```ts
const execution = await createGpuExecution(device, artifact, [
  {
    params: {length: 20},
    indices: close.length,
    series: {close},
    time,
    declare(outputs) {
      console.log(outputs.schema.fields.map(field => field.name));
    },
    next(datum) {
      console.log(datum.index, datum.output0);
    },
  },
]);

await execution.runAll();
execution.dispose();
```

The declaration callback runs before any rows, including for an empty binding.
The returned Promise owns completion and failure. The runtime clones and binds
the embedded Module independently for each parameter set.

Preparation validates:

- exact required-series names;
- one common finite extent per binding;
- parameter values and active-state projection;
- optional time-array length and safe epoch-ms values;
- frame-history capacities from the concrete extent;
- u32 descriptor and i32 `bar_index` bounds.

## Numeric contract

The current executable profile is WGSL `f32` plus `i32`. Application numbers
are converted during packing, and decoded results are compared with CPU using
explicit tolerances. Threshold-sensitive strategies may legitimately take a
different branch when f32 and f64 straddle a comparison boundary; the reported
numeric profile must remain visible to callers performing parity analysis.

NaN is Tea's numeric missing value and crosses the GPU boundary through a
canonical quiet-NaN bit pattern. Infinity is rejected.

## Physical allocation

Callers do not configure chunk size, effect capacity, or GPU memory budgets.
Those policies cannot know actual free device memory.

The runtime derives its physical plan from the artifact, concrete extents, and
hard device limits:

- `GPUDevice.limits.maxBufferSize`;
- `maxStorageBufferBindingSize`;
- workgroup size and invocation limits;
- workgroup-count limits;
- fixed ABI offsets and u32 capacities.

The complete input series are currently packed once. If those arrays exceed a
hard storage-buffer limit, execution fails; supporting larger inputs requires
chunked input transport, not an application memory-budget knob.

Dense result capacity is `chunkRows × resultChannels` for every binding. Effect
capacity is `chunkRows × artifact.maxEffectsPerRow`. The runtime binary-searches
for the largest chunk whose buffers fit the concrete device. Any workgroup-state
staging is selected automatically from the artifact and hard device limit.

## Persistent execution and readback

Each binding owns a disjoint persistent-state range. `runChunk()` advances from
its device-resident cursor, while reusable result/effect buffers cover only the
current chunk. Absolute `bar_index` and history therefore remain independent of
chunk boundaries.

After dispatch, the runtime:

1. waits for completion and maps readback buffers;
2. validates all result cells, effect counts, ids, rows, and payloads;
3. constructs complete lossless Datums;
4. publishes only after the whole chunk passes validation.

An overflow, decode error, or callback exception makes the session terminal. Prior
successful chunks are never retried. `dispose()` destroys only buffers and
pipelines created by the session; the application retains its GPUDevice.

## Current executable subset

The GPU supports deterministic numeric programs with:

- fixed numeric series;
- fixed-width int, float, bool, and enum parameters;
- numeric loops and retained history;
- scalar dense outputs;
- supported scalar and enum effect payloads;
- `bar_index` and final-index state derived by the backend.

It fails closed for unsupported references, collections, resources, strings,
dynamic requests, request-child execution, drawings, and other builtin mappings
that the backend cannot derive exactly.

## Verification

Unit tests validate parameters, history layout, result/effect capacity, and
resource planning without a device. The Dawn gate executes real WebGPU work
and checks output transport, source-time preservation, binding isolation,
and fail-closed strategy struct boundaries.
