# GPU runtime

WebGPU execution of one bind-independent artifact across caller-ordered
concrete bindings. `session.ts` owns manifest concretization, buffer planning,
device resources, dispatch, readback, decoding, and publication.
`src/gpu/contract.ts` is the producer/consumer artifact boundary.

## Invariants

- `createGpuExecution()` is the only public GPU execution entry. It accepts an
  injected `GPUDevice`, one compiled artifact, and ordered `GpuBinding[]`.
- GPU preparation loads the artifact's generated JavaScript binding module and
  concretizes a fresh manifest through shared `runtime/module-binding.ts`. It
  never creates a CPU runtime or re-reads Program IR.
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
