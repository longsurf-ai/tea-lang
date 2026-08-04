# runtime

The Tea runtime: `JSRuntime` implements the Runtime ABI (`abi.ts` is the contract
surface, `docs/runtime.md` the authority) and owns the main loop — binding,
frame trees, rings, the provisional/commit protocol, emission flushing.

## Invariants

- Only Time-Machine-relevant operations cross the ABI; generated code never
  sees ring indices, scratch heads, or storage layout. Hosts differ only in
  the injected DataProvider and OutputSink.
- The manifest is the runtime's single input besides code: ids (sid/pid/oid/
  fid/slots) are never re-derived from the Program.
- execute always runs the full row from committed state — no incremental
  update paths exist. perBar scratch resets to na; var/varip seed from the
  last committed value, re-running their init thunks until something has
  committed; varip alone keeps scratch across same-row re-executions.
  Commit pushes scratch into history; rollback is discarding scratch.
- One Ring class serves value and reference slots (naValue NaN vs null);
  var/varip rings keep at least one committed cell regardless of depth.
- Bind-time entries (bindDepth/bindSeriesDepth/bindOutput/bindRequest) are
  legal only while the module's init section runs; series depth demands are
  a contract passed to providers, not an allocation.
- bind is async, and awaits otherwise happen only at suspension points:
  static contexts resolve before row 0; a dynamic pair's first encounter
  throws `ContextSuspension` out of `executeRow`, the host awaits
  `resolvePending()`, and the SAME row re-executes — the aborted attempt
  vanishes entirely (all scratch, varip included, re-seeds from committed
  state; byte-identical to having had the data upfront). The per-row hot
  path itself never awaits. Request children recurse through the same
  JSRuntime class with a null sink, the parent's resolved params
  (compilation-global), and the shared unique-context budget
  (maxRequestContexts, default 40).
- A dynamic edge's history lives in its result ring — "whatever the
  request returned per parent row", whichever pair served it; merged
  views are cached per (edge, pair) and never rebuilt.
- Merge is alignment, not data movement (`merge.ts` owns the mapping; the
  merged result is a parent-row-indexed view over child committed values).
  Merge reads committed child cells only — provisional child state is
  invisible by construction.
- Bind failures (bad param, missing series) throw `BindError` — user-facing
  and host-actionable; protocol misuse (out-of-order rows, unknown slots)
  is `fatal()`.
- `rt` imports only `base/` and `ir/`; runtime tests drive hand-lowered
  modules in exactly the shape codegen emits.
