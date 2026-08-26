# GPU runtime

WebGPU execution of one bind-independent artifact across caller-ordered
bindings. `session.ts` owns provider resolution, manifest concretization,
buffer planning, device resources, dispatch, readback, decoding, and sink
publication. `src/gpu/contract.ts` is the producer/consumer artifact boundary.

## Invariants

- `createGpuExecution()` is the only public GPU execution entry. It accepts an
  injected `GPUDevice`, one compiled artifact, and ordered `BindInputs[]`.
- GPU preparation loads the artifact's generated JavaScript binding module and
  concretizes a fresh manifest through shared `runtime/module-binding.ts`. It
  never creates a CPU runtime or re-reads Program IR.
- Fixed buffer groups, descriptor offsets, strides, and artifact ABI constants
  come only from `src/gpu/contract.ts`; runtime code must not duplicate them.
- Each binding has private state, provider data, output sink, buffer slices, and
  progress. Caller order is execution identity; no GPU-specific job wrapper or
  physical-plan layer exists.
- `runChunk()` keeps resumable state on-device and publishes decoded absolute
  rows. `runAll()` only repeats that lifecycle. Neither method owns Tea broker,
  portfolio, strategy, or matching semantics.
- Dense result capacity derives from concrete frame depths. Sparse effect
  storage is explicitly bounded. Device and caller sinks remain externally
  owned; disposing a session releases only session-created GPU resources.
