# gpu

Neutral, versioned physical artifact contracts shared by GPU codegen and the
GPU runtime. `contract.ts` owns fixed bindings, descriptor offsets, physical
stride constants, and `CompiledWgslProgram`; codegen produces this contract and
runtime consumes it.

## Invariants

- This directory owns contracts only. It never lowers a Program, resolves an
  application data source, accepts a GPUDevice, allocates buffers, or decodes
  results.
- `GPU_ARTIFACT_ABI_VERSION` is the sole physical ABI version source. Fixed
  bindings, offsets, and strides must not be duplicated in codegen or runtime.
- Arrow output structure exists only in the embedded TypeScript Module.
  `resultChannels` and `events` carry only physical codecs and unified output
  IDs. Parameters retain the artifact's checked parameter contract for GPU
  binding validation; the artifact owns no second output schema.
- Reference structs have no GPU lowering yet. The WGSL producer must return a
  stable staged-unsupported issue before emitting an artifact containing a
  struct value or physical event codec.
- ABI 7 embeds the ordinary TypeScript module and retains the common output
  ID space. Arrow fields remain canonical; physical scalar strides stay
  unchanged. Older artifact ABIs are rejected.
- The ABI carries the ordinary generated Runtime-ABI-11 Module. GPU
  preparation calls `module.clone().bind(values)` for each binding, reads
  concrete `state.frames`, and derives capacities from depths and the binding's extent.
  Codegen never accepts input datasets, devices, or runtime memory payloads.
