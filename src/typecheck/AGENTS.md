# typecheck

Reserved for the Tea type checker — the qualifier × value-type grid described in the package-root `runtime.ts` design notes (`const < input < simple < series` crossed with `int | float | bool | color | string`).

## Invariants

- Not wired into `compile()` yet. When it lands, it runs between parse and lower, and `src/compile.ts` is the only place that ordering changes.
