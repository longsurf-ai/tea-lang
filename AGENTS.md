# tea-lang

Clean-room Tea language toolchain — scanner → parser → noder → codegen — structured after Go's `cmd/compile` (`main.go` = CLI shell, `gc.Main` = pipeline driver). The `tea` CLI has three verbs: `run`, `build`, `parse`.

## Invariants

- tea-lang must remain extractable as an independent open-source repository: no `@openchart/*` imports or dependencies anywhere in this package, ever. When a definition from the OpenChart codebase is needed (e.g. a DataSeries shape), duplicate it here instead of importing it — this package is a deliberate, documented exception to the repo-wide single-source-of-truth preference.
- Import style is also an exception to the repo standard: cross-folder imports inside this package use relative paths (`../base/pos`), never a workspace package name, so the tree works unchanged outside the monorepo.
- External dependencies must be open-source-friendly npm packages only (currently just `commander`), and `package.json` must not use workspace-only version protocols (`catalog:`, `workspace:`) — concrete versions only, so `npm install` works on a standalone checkout.
- The Tea Script frontend inside `packages/tsgraph` is a separate legacy surface; this package is its clean-room successor prototype and must not import from it.
- `src/main.ts` is Commander wiring and process I/O only. Pipeline stage order is owned solely by `src/compile.ts`; no other module may chain stages.
- Stages surface malformed-source failures by accumulating `Diagnostic`s (`src/base/diagnostics.ts`) and continuing where recovery is possible; they throw only `TeaUnimplementedError` or internal invariant violations.
- Every AST node carries a `Span`; positions are 1-based (`src/base/pos.ts`).
- `runtime.ts` at the package root is design notes (Program/bind/lower sketch), not wired into the pipeline.
- `src/typecheck/` is reserved for the qualifier × value-type checker; it is not wired into `compile()` yet.
