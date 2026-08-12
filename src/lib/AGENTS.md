# lib

Compiler-shipped Tea-authored libraries — real Tea libraries
(`library("...")` + `export`) compiled by the ordinary loader/checker/noder
pipeline. `ta` is the implicit prelude; strategy components are explicit
imports.

## Invariants

- Nothing here is native: every function is ordinary Tea, and per-call-site
  state falls out of function semantics (var locals, param history). Adding
  a library = adding a file here and listing it in the loader's
  `BUILTIN_FILES`; the namespace comes from the file's own `library()`
  declaration. Inclusion in `DEFAULT_IMPLICIT` is a separate, deliberate
  prelude decision.
- Exported functions, interfaces, types, and enums form the public surface;
  unexported declarations resolve only inside the owning library. Interfaces
  constrain concrete generic storage and never become runtime values.
- `broker`, `portfolio`, and `strategy` are explicit imports. Strategy state
  is the concrete value returned by `strategy.configure`; lifecycle methods
  are ordinary calls and no package global hides the configured strategy.
- Functions that read ambient context (volume, high, low, close) directly
  are rejected inside request expressions by design — prefer passing
  sources as parameters wherever Pine's signature allows.
- `testdata/checker/ta-suite.tea` must call every export of ta; extend it in
  the same change that adds a function.
- Known gaps tracked in ta.tea's header: median/mode/percentile\__/valuewhen
  need collections; the ta._ namespace VARIABLES (obv, vwap, accdist, …)
  need exported library variables.
