# tea-lib

Compiler-shipped Tea-authored libraries — real Tea libraries
(`library("...")` + `export`) compiled by the ordinary loader/checker/noder
pipeline. `ta` is the implicit prelude; trade components are explicit
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
  are checker-only structural constraints: receiver mode, positional arity and
  types, and result type participate; parameter names and defaults do not.
  Interfaces constrain concrete generic storage and never become runtime
  values or dynamic dispatch tables. Named/default-call ergonomics belong to
  concrete functions and methods.
- `broker`, `portfolio`, and `trade` are explicit imports. Policy-specific
  trade coordinators own concrete broker and portfolio values; lifecycle
  methods are ordinary calls and no package global hides execution state. The
  native `strategy()` declaration is not a library and does not construct one
  of these values.
- `trade.nextOpen`, `trade.ohlc`, `trade.path`, and `trade.lots` are direct
  families, not modes of a universal wrapper. Broker interfaces own matching
  and order lifecycle; portfolio interfaces own fill application and
  accounting. Keep lot collections, immediate execution, and unused matcher
  families outside scalar Program closures so adding an abstraction cannot
  regress an existing GPU-lowerable source.
- Tea has no member-level visibility yet. Do not describe concrete helper
  members as technically private; keep the supported strategy boundary at the
  trade coordinator and enforce it with catalog ownership tests.
- Functions that read ambient context (volume, high, low, close) directly
  are rejected inside request expressions by design — prefer passing
  sources as parameters wherever Pine's signature allows.
- `tests/fixtures/checker/ta-suite.tea` must call every export of ta; extend it in
  the same change that adds a function.
- Known gaps tracked in ta.tea's header: median/mode/percentile\__/valuewhen
  need collections; the ta._ namespace VARIABLES (obv, vwap, accdist, …)
  need exported library variables.
