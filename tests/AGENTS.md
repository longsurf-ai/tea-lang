# Cross-cutting tests

`tests/` owns suites that deliberately cross compiler, runtime, provider, or
example boundaries. Keep pass-local unit tests beside their owner under
`src/**`; do not move them here merely to centralize tests.

## Suites

- `examples.test.ts` exercises the public compile and CPU execution path
  against the checked-in human example. It may read `examples/`; fixtures may
  not.
- `examples.gpu.integration.ts` is part of the explicit Dawn gate run by
  `npm run test:gpu`. It runs under the active Node runtime and requires a
  usable WebGPU adapter; it is not a network test.
- `strategy-catalog.test.ts` compiles the clean-room strategy conversions and
  validates their declared Cartesian grids without resolving live request
  contexts. It also enforces direct `trade.nextOpen`/`ohlc`/`path`/`lots`
  composition and rejects strategy-local accounts, fill construction,
  portfolio mutation, and lifecycle-effect emission.
- `strategy-gpu-eligibility.test.ts` owns the exact offline boundary for all
  fourteen strategy sources. Reference structs are currently a deliberate
  fail-closed GPU boundary, so no canonical strategy is eligible; each source
  pins its first staged-unsupported diagnostic until a separate reference-
  struct GPU plan restores eligibility.
- New cross-cutting suites must resolve paths inside this repository and must
  not fetch test inputs from the network.

## Fixtures

- `fixtures/` contains inert, repository-owned inputs and expected outputs. It
  must not become a second source tree or depend on `examples/`.
- `fixtures/corpus/` is parse-only. Its real-world Pine-derived files are
  clean-room derivations with material content removed; parser acceptance is
  not a checker or runtime support promise.
- `fixtures/execution/` owns compile-through and differential conformance. Its
  manifest is fail-closed and SHA-256-pinned. References must be independently
  hand- or specification-derived, tolerances explicit, and deviations recorded
  only after Tea intentionally adopts them.
- Never add an automatic golden or reference rewrite path. Review changed
  fixture content, expectations, and hashes together. See
  [`../docs/conformance.md`](../docs/conformance.md).
