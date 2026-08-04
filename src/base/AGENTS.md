# base

Leaf utilities every layer may import (positions, errors, config, logging,
tabwriter); `base` imports nothing outside itself.

## Invariants

- `log.ts` is the package's single diagnostics surface: structured events
  (message + fields) through scoped child loggers over one pluggable sink.
  Logging REPORTS, it never replaces a typed path — user-facing compile
  errors stay in `print.ts` (`Errors`), typed results (`ContextError`,
  `BindError`) stay typed, and program output flows through OutputSinks.
  No `console.*` outside `main.ts` and sink constructors.
- Configuration is host-boundary-only (`configureLog` from `main.ts`,
  embedding hosts, or tests): level, per-scope overrides (longest dot
  prefix wins), and the sink. Default: warn-and-above as single lines on
  stderr — stdout belongs to program output, so goldens and pipes never
  see log noise.
- Scope names are dot paths owned by the emitting module
  (`runtime.request`, `compile`, `provider.yahoo`); tests assert through
  `captureSink`, never by scraping stderr.
