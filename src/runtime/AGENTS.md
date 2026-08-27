# runtime

Shared execution contracts plus two concrete runtimes. `js/` owns JavaScript
execution mechanics; `gpu/` owns WebGPU execution. Public `Node` owns the CPU
reactive graph. Files at this directory root are limited to the generated-module
ABI, immutable module binding, output/value/layout representation, parameter
validation, loading, and history validation.
`docs/runtime.md` is authoritative; `docs/requests.md` owns request semantics.

## Invariants

- `RUNTIME_ABI_VERSION` is the only generated JavaScript ABI version source and
  is currently `7`. Do not add compatibility paths for older ABIs.
- A `JSModule` is code plus one recursive concrete manifest. Parameter values,
  series-supplied markers, depths, output arguments, and request contexts live
  only there; do not copy them into another binding object.
- `bindModule()` and module-binding helpers deep-copy and freeze the recursive
  manifest. Old module snapshots remain unchanged. Generated
  `concretize(manifest, contextConstants?)` writes only to the caller-owned copy
  and receives no execution state.
- `module-abi.ts`, `module-binding.ts`, and `load.ts` are shared because GPU
  preparation uses the generated JavaScript module to concretize bindings. It
  never creates a `JSRuntime`.
- `binding.ts`, `output.ts`, `schema.ts`, `value.ts`, and `value-layout.ts` are
  target-neutral contracts. Runtime implementations
  import these narrow files, never the public `abi.ts` facade.
- Numeric input series contain finite numbers or NaN. Host parameter inputs
  reject infinities; integer inputs additionally require safe integers.
  `undefined` means a demanded builtin is unavailable, while `null`, `NaN`, and
  `false` remain valid typed values.
- History offsets are non-negative safe integers. Any other value retains and
  addresses zero history cells.
- Public request synchronization belongs entirely to `Node`; there is no
  second axis-merge implementation at the runtime root.
- Bind failures are host-actionable `BindError`s. Generated/runtime invariant
  violations use `fatal()` and never enter compiler diagnostics.
