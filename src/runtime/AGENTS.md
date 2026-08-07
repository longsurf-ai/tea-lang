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
- One Ring class serves all slots. The manifest's explicit `valueClass` owns
  the empty value: numeric is NaN, reference is null, and bool is false;
  var/varip rings keep at least one committed cell regardless of depth.
- A history offset names a cell only when it is a non-negative safe integer.
  Every other offset (including na, infinity, fractions, and negatives) returns
  the place's typed empty value and retains zero cells when reported at bind;
  it can never address a future row or become an array length.
- `historyDepth` applies that rule to each synthesized bound-demand component
  before they are maximized; an invalid component contributes zero and cannot
  poison a valid depth from the same carrier.
- Provider series values are finite numbers or NaN. Infinity is an impossible
  provider state and fails loudly at the read; host numeric inputs are stricter
  and reject NaN and both infinities at bind, while int inputs additionally
  require a safe integer so the runtime representation stays exact.
- Binding has two ordered code sections: frame-free `init` is reserved for
  preparation that needs no frame; frame-aware `bind` runs against a
  scratch-only provisional frame, computes immutable input aliases/UDFs, and
  reports depths, param active states, output args, and static request pairs.
  The runtime then discards that frame and allocates the final tree from the
  reported depths. All bind-reporting calls are illegal after execution
  begins; series depth demands are a provider contract, not an allocation.
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
