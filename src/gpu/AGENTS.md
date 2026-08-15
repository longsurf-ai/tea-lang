# gpu

Neutral, versioned physical artifact contracts shared by GPU codegen and the
GPU runtime. `contract.ts` owns fixed bindings, descriptor offsets, physical
stride constants, and `CompiledWgslProgram`; codegen produces this contract and
runtime consumes it.

## Invariants

- This directory owns contracts only. It never lowers a Program, resolves a
  provider, accepts a GPUDevice, allocates buffers, or decodes results.
- `GPU_ARTIFACT_ABI_VERSION` is the sole physical ABI version source. Fixed
  bindings, offsets, and strides must not be duplicated in codegen or runtime.
- Logical parameter/effect schemas come from `runtime/schema.ts`; physical
  WGSL layouts remain explicit fields of the artifact.
- The ABI also carries the ordinary generated JS binding module, fixed state
  prefix, per-local history descriptors, and per-job state offset/word count.
  Concrete capacities remain runtime binding facts, never codegen inputs.
