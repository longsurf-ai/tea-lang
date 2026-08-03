# lib

Builtin Tea-authored libraries — real Tea libraries (`library("...")` +
`export`), implicitly imported into every script and compiled by the
ordinary pipeline via `checker/library.ts`.

## Invariants

- Nothing here is native: every function is ordinary Tea, and per-call-site
  state falls out of function semantics (var locals, param history). Adding
  a library = adding a file here and listing it in `library.ts` FILES; the
  namespace comes from the file's own `library()` declaration.
- Exported functions are the public surface; unexported ones resolve only
  inside the owning library.
- Functions that read ambient context (volume, high, low, close) directly
  are rejected inside request expressions by design — prefer passing
  sources as parameters wherever Pine's signature allows.
- `testdata/checker/ta-suite.tea` must call every export of ta; extend it in
  the same change that adds a function.
- Known gaps tracked in ta.tea's header: median/mode/percentile_*/valuewhen
  need collections; the ta.* namespace VARIABLES (obv, vwap, accdist, …)
  need exported library variables.
