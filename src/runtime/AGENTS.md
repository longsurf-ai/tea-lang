# runtime

Tea execution after bind-independent codegen. `JSRuntime` implements the JS
Runtime ABI (`abi.ts` is the stable facade; `value.ts`, `schema.ts`,
`module-abi.ts`, `provider.ts`, `output.ts`, `binding.ts`, and `errors.ts` own
the internal contracts; `docs/runtime.md` is the authority)
and owns the main loop — binding, exact value layouts, frame trees, rings,
immutable collection storage, provisional/commit, and emission flushing.
Generic batch execution and GPU binding/execution also live here because bindings,
datasets, buffers, devices, dispatch, and readback are runtime facts.
The backend-neutral `executeProgram()` host harness lives one level above in
`src/execute.ts`; CLI reporting and Dawn process selection are host concerns.

## Invariants

- Only Time-Machine-relevant operations cross the ABI; generated code never
  sees ring indices, scratch heads, or storage layout. Hosts differ only in
  the injected DataProvider and OutputSink.
- `RUNTIME_ABI_VERSION` is the only JavaScript Runtime ABI version source and
  remains `1` before launch; do not add migration branches or legacy readers.
- Runtime implementation files import the narrow internal contract they use,
  never their own `abi.ts` facade. The versioned physical GPU artifact lives
  in `gpu/contract.ts`; runtime/gpu must not import codegen implementation
  modules or duplicate fixed physical constants.
- CPU batch execution is not a second compiler or strategy runtime. It loads
  one ordinary generated JS module and passes each caller-ordered `BindInputs`
  element through the ordinary `bind()` / `runAll()` / `dispose()` lifecycle.
  Every binding owns its own `OutputSink`; `runCpuBatch` neither captures
  outputs nor imposes capacity, job ids, or sweep metadata. `MemorySink` is an
  optional caller policy for structured in-memory capture.
- Batch execution has no plan or journal abstraction. Caller array order is
  binding identity, and retention, bounds, and transactions belong to the
  injected sink.
- GPU execution consumes a bind-independent WGSL artifact, an injected
  `GPUDevice`, and an ordered `BindInputs[]`. It resolves providers, validates
  and normalizes required inputs, runs the artifact's ordinary generated JS
  provisional bind phase, sizes each binding's history payload, derives dense
  capacity, bounds sparse effect storage, and packs private buffers while
  creating one resumable session. The fixed frame topology and ids come only
  from the artifact; runtime never reads Program or reinterprets Tea depth
  expressions.
  `runChunk()` keeps each Program execution's state on-device and publishes
  decoded absolute rows through each binding's `OutputSink`; `runAll()` is only
  repetition over that lifecycle. Neither runtime method owns Tea broker or
  portfolio semantics.
- `createGpuExecution()` is the sole public GPU binding/execution entry. Do not
  restore separate physical-plan surfaces, GPU-specific job wrappers, caller-owned
  result-cell capacity, materialized-series bindings, or a second compilation
  path.
- The manifest is the runtime's single input besides code: ids (sid/pid/oid/
  fid/slots) are never re-derived from the Program.
- Numeric provider series and typed execution inputs are separate carriers.
  `ExecutionSource.domain` classifies builtin identifiers only; it never
  implies a domain-shaped runtime object. A demanded provider metadata key
  returning `undefined` is a bind error, while `null`, `NaN`, and `false` are
  legitimate typed-empty/value results validated against the manifest layout.
- Fixed historical execution has one required host `timeNow`: a finite safe
  epoch-ms integer shared by the root and every request child. The runtime
  never consults wall-clock time. `timenow` remains series-qualified: only
  simple syminfo/timeframe inputs are visible during bind. Historical
  `barstate` is derived solely from the target row/extent and never invents a
  realtime update object.
- execute always runs the full row from its storage-class baseline — no
  incremental update paths exist. perBar scratch resets to na; var/varip seed
  from the last committed value only after committed initialization;
  declaration-site `InitName` remains eligible otherwise. varip alone keeps
  its value and initialization candidate across completed same-row executions.
  Commit pushes scratch into history; rollback is discarding scratch.
- One Ring class serves all slots. Every local and request result carries an
  exact `LayoutId`; the shared registry validates values, derives typed empty,
  and walks nested collection storage roots. var/varip rings keep at least one
  committed cell regardless of depth.
- Fixed-width Ring cells and materialized request-result columns reserve from
  the shared `maxFixedValueLogicalBytes` budget using the layout's exact
  shallow size. Scratch-only bind Rings release before final allocation;
  completed children release frame Rings when builder ownership transfers,
  while the result-column lease remains with the merged view until disposal.
- Ordinary user-defined values are nominal immutable records with value
  semantics. Collection values are immutable headers over source-hidden
  `StorageRef`s. Published Heap payloads never mutate, Heap owns no semantic
  object identity or `var`/`varip` policy, and generated code cannot control
  attempts or publication.
- Storage descriptors provide an exact builder-byte estimate. Heap enforces
  transient cell/byte limits before descriptor sealing may allocate or copy,
  and the sealed payload's logical byte count must equal the estimate.
- Exactly one nonterminal Heap attempt may exist. Row publication prepares all
  fallible Ring, Heap-reachability, and buffered-emission work before a
  non-throwing internal publish; final sink delivery is post-commit. Abort and
  suspension invalidate scratch/emissions and all tentative storage.
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
  Both sections share one abort-only Heap attempt, so bind-time aggregate
  temporaries can never become published storage.
- bind is async, and awaits otherwise happen only at suspension points:
  static contexts resolve before row 0; a dynamic pair's first encounter
  throws `ContextSuspension` out of `executeRow`, the host awaits
  `resolvePending()`, and the SAME row re-executes — the aborted attempt
  vanishes entirely: tentative writes/storage disappear and retry restores the
  exact pre-attempt varip candidate, including one produced by an earlier
  successful provisional tick. Persistent initialization happens only when an
  emitted lexical `InitName` calls `needsInit`/`initialize`; its scratch and
  committed bits follow the same transaction, so an absent first-row candidate
  reruns the declaration-site initializer. Physical subframe allocation is
  separate from scratch/committed activation: a first call activates
  tentatively, abort/suspension restores the old activation tree, successful
  provisional execution may retain its same-row candidate, and final commit
  promotes it. The per-row hot path itself never awaits. Request children
  recurse through the same JSRuntime class with a null sink, the parent's
  resolved params (compilation-global), and the shared unique-context budget
  (maxRequestContexts, default 40), exact layout registry, and Heap arena.
- Request result builders register as Heap-root owners before retaining
  aggregate values and transfer ownership to result Rings/views before
  unregistering. A `StorageRef` never crosses into an independently owned
  arena.
- Every cached `(edge, symbol, timeframe)` pair consumes the shared request
  context budget, including ignored-invalid pairs cached as na; an uncached
  hard resolution failure releases its reservation.
- Every request edge reports its four evaluated options exactly once during
  bind. Zero `calc_bars_count` selects the full range; a positive safe integer
  selects an exact trailing child extent. Providers receive that demand, and
  the runtime clamps an over-returned context again at its own trust boundary.
  Child row indices restart at zero, pre-window history/merge prefixes are the
  result layout's typed empty, and empty nested pair components inherit the
  current context's provider-normalized symbol/timeframe identity.
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
