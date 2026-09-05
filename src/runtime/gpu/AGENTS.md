# GPU runtime

WebGPU execution of one bind-independent artifact across caller-ordered
concrete bindings. `session.ts` owns parameter binding, buffer planning,
device resources, dispatch, readback, decoding, and publication.
`src/gpu/contract.ts` is the producer/consumer artifact boundary.

## Invariants

- `createGpuExecution()` is the only public GPU execution entry. It accepts an
  injected `GPUDevice`, one compiled artifact, and ordered `GpuBinding[]`.
- GPU preparation loads the artifact's ordinary JS module and copies it for each
  binding before calling its synchronous mutable `bind()` method. The module is flat: inputs,
  parameters, state, outputs, and request records containing child modules.
  State capacities are derived here from prepared frame depths and finite
  extents. No shared binding-layout wrapper or parallel binder exists.
- The embedded module owns the only Arrow output schema and declaration list.
  Set and append outputs use one index space; physical event records carry the
  unified output ID. The runtime decodes scalar bytes into cells aligned with
  that declaration list and calls shared `createDatum()` for publication.
- Fixed buffer groups, descriptor offsets, strides, and artifact ABI constants
  come only from `src/gpu/contract.ts`; runtime code must not duplicate them.
- Each binding has private state, concrete series arrays, output sink, buffer slices, and
  progress. Caller order is execution identity; no GPU-specific job wrapper or
  physical-plan layer exists.
- `runChunk()` keeps resumable state on-device and publishes decoded absolute
  rows. `runAll()` only repeats that lifecycle. Neither method owns Tea broker,
  portfolio, strategy, or matching semantics.
- Chunk length and effect capacity derive from actual binding extents, the
  artifact, and hard `GPUDevice.limits`. There are no caller memory, chunk,
  effect, staging, or memory knobs. Workgroup staging derives only from the
  artifact and device limit; disposing a session releases only session-created
  GPU resources.

- The embedded TypeScript constructs ordinary Arrow schemas. Each declaration
  callback receives its own schema copy; publication uses named `outputN` records and `effectN` lists
  with global ordinals through shared `createDatum()`. GPU supports its existing
  scalar subset only; Arrow lists and structs do not imply GPU execution support.
