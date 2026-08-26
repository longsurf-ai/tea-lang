# runtime

Shared execution contracts plus two concrete runtimes. `js/` owns JavaScript
execution and fixed-history hosting; `gpu/` owns WebGPU execution. Files at this
directory root are used by both sides: generated-module ABI and loading,
immutable module binding, provider/output contracts, parameter validation,
value/layout representation, history validation, and request-axis merge.
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
- `binding.ts`, `provider.ts`, `output.ts`, `schema.ts`, `value.ts`, and
  `value-layout.ts` are target-neutral host contracts. Runtime implementations
  import these narrow files, never the public `abi.ts` facade.
- Provider numeric series contain finite numbers or NaN. Host parameter inputs
  reject infinities; integer inputs additionally require safe integers.
  `undefined` means a demanded builtin is unavailable, while `null`, `NaN`, and
  `false` remain valid typed values.
- History offsets are non-negative safe integers. Any other value retains and
  addresses zero history cells.
- Request merge is alignment, not data movement. `merge.ts` returns
  parent-to-child row mappings over validated increasing time axes.
- Bind failures are host-actionable `BindError`s. Generated/runtime invariant
  violations use `fatal()` and never enter compiler diagnostics.
