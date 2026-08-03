# tea-lang

Clean-room Tea language toolchain — syntax (incremental scanner + parser) → noder (`loadPackage` → unified IR) → codegen. `src/main.ts` is the CLI shell; `src/compile.ts` is the pipeline driver. The `tea` CLI has three verbs: `run`, `build`, `parse`.

## Invariants

- tea-lang must remain extractable as an independent open-source repository: no `@openchart/*` imports or dependencies anywhere in this package, ever. When a definition from the OpenChart codebase is needed (e.g. a DataSeries shape), duplicate it here instead of importing it — this package is a deliberate, documented exception to the repo-wide single-source-of-truth preference.
- Import style is also an exception to the repo standard: cross-folder imports inside this package use relative paths (`../base/pos`), never a workspace package name, so the tree works unchanged outside the monorepo.
- External dependencies must be open-source-friendly npm packages only (currently just `commander`), and `package.json` must not use workspace-only version protocols (`catalog:`, `workspace:`) — concrete versions only, so `npm install` works on a standalone checkout.
- The Tea Script frontend inside `packages/tsgraph` is a separate legacy surface; this package is its clean-room successor prototype and must not import from it.
- `src/main.ts` is Commander wiring and process I/O only. Pipeline stage order is owned solely by `src/compile.ts`; no other module may chain stages.
- User-facing errors flow through a single per-compilation `Errors` instance (`src/base/print.ts`), owned by the driver (`compile.ts`) or the CLI. The syntax layer receives only a narrow injected `ErrorHandler` and continues with recovery; the noder is where reports enter the compilation's `Errors`. Reports queue with one-per-line suppression, are sorted and deduped at `flushErrors()`, and are printed only by `main.ts`. Phase barriers in `compile()` stop later phases after a failed one. User errors are never thrown; internal invariant violations use `fatal()`/`unimplemented()` (`InternalError`, never queued).
- Every position is a `Pos` carrying its `PosBase`, so file identity travels with positions and errors need no separate filename threading (`src/base/pos.ts`); lines and columns are 1-based. Every AST node carries the `Pos` of its leftmost defining token.
- `runtime.ts` at the package root is design notes (Program/bind/lower sketch), not wired into the pipeline.
- `src/typecheck/` is reserved for the qualifier × value-type checker; it is not wired into `compile()` yet.
