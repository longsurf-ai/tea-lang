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
- Logical input/output/effect types use Arrow. Output and effect schemas are
  standard Arrow IPC byte arrays; parameters retain `runtime/schema.ts` binding
  semantics. Physical WGSL layouts and result codecs remain explicit artifact
  fields, never another structural I/O schema.
- Reference structs have no GPU lowering yet. The WGSL producer must return a
  stable staged-unsupported issue before emitting an artifact containing a
  struct value or physical effect codec.
- ABI 5 replaces channel transport tags and effect payload type trees with
  Arrow IPC schemas. `rowCells` maps fields to physical result cells;
  `WgslCodec` describes only scalar offsets/encodings. Existing buffer offsets
  and supported scalar operations remain unchanged, and older ABIs are rejected.
- The ABI also carries the ordinary generated Runtime-ABI-8 `JSModule`, fixed
  state prefix, per-local history descriptors, and per-job state offset/word
  count. GPU preparation installs each binding into a deep-copied manifest,
  calls the module's direct `concretize()` method, and consumes its concrete
  depths; capacities remain runtime binding data, never codegen inputs.
