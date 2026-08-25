# runtime

Tea execution after bind-independent codegen. The legacy `JSRuntime` still
implements the existing provider/sink, request-child, batch, CLI, and GPU bind
paths. `StateMachineRuntime` is the implemented step-based migration target;
both currently coexist. `abi.ts` is the stable legacy facade; `value.ts`,
`schema.ts`, `module-abi.ts`, `provider.ts`, `output.ts`, `binding.ts`, and
`errors.ts` own the internal contracts, and `docs/runtime.md` is the authority.
Generic batch execution and GPU binding/execution also live here because bindings,
datasets, buffers, devices, dispatch, and readback are runtime facts.
The backend-neutral `executeProgram()` host harness lives one level above in
`src/execute.ts`; CLI reporting and Dawn process selection are host concerns.

## Invariants

- `StateMachineRuntime` owns its `State`, `Intermediate`, and Heap. Its
  `step()` returns an `Effect`: successful provisional steps replace only the
  owned Intermediate, successful final steps replace both State and
  Intermediate, and failures replace neither. `StepResult` exposes only dense
  output, effects, and provisional finality. Disposal is idempotent.
- The generic `Intermediate` contract contains only its frame root. Heap is an
  injected resource of `stateMachine()` and is owned/disposed by
  `StateMachineRuntime`; it never crosses the transition result. Root discovery
  scans the runtime's retained State and Intermediate before beginning the next
  Heap transaction.
- The step runtime consumes already evaluated binding facts. Static request
  facts can be produced by module binding, but TeaNode child-request execution
  is not implemented yet; do not claim that the new path executes requests.
  The legacy JSRuntime remains the current request execution path.
- Only Time-Machine-relevant operations cross the ABI; generated code never
  sees ring indices, scratch heads, or storage layout. Hosts differ only in
  the injected DataProvider and OutputSink.
- `RUNTIME_ABI_VERSION` is the only JavaScript Runtime ABI version source and
  is currently `2`; do not add migration branches or legacy readers.
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
- Numeric provider series and typed builtins are separate carriers.
  `BuiltinSource.domain` classifies builtin identifiers only; it never
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
  declaration-site `InitName` remains eligible otherwise. varip keeps its
  value/rebinding candidate across completed same-row executions; an ordinary
  var retains only its first successful same-row initialization candidate.
  Commit pushes scratch into history; rollback is discarding scratch.
- One Ring class serves all slots. Every local and request result carries an
  exact `LayoutId`; the shared registry validates values, derives typed empty,
  and walks nested collection storage roots. var/varip rings keep at least one
  committed cell regardless of depth.
- Fixed-width Ring cells and materialized request-result columns reserve from
  the shared `maxFixedValueLogicalBytes` budget using the layout's exact
  shallow size. Scratch-only bind Rings release before final allocation;
  completed children release their frame Rings and context-local Heap after
  their scalar result column has been copied, while the result-column lease
  remains with the merged view until disposal.
- Struct values are nominal references represented by source-hidden
  `Ref`s; assignment and history copy the reference while the Heap-owned
  body is transactionally mutable. Collection values remain immutable headers
  whose operations allocate replacement backing. Both use the same
  context-local Heap, transaction, version guards, limits, tracing, and
  collection.
- `TypeInfo<A, V>` owns a stored payload type's stable identity,
  `bytesFor(args)`, `create(args)`, `bytesOf(value)`, and direct-child
  `trace(value, visit)` policy. A transaction stages complete replacement
  payloads for committed identities; its reads see that overlay first. Commit
  installs replacements and tentative allocations, while abort discards both,
  so no edit/undo protocol or in-place journal is exposed.
- Exactly one active Heap transaction may exist. After it becomes terminal, the
  runtime replaces the Heap's complete precise root snapshot and may run
  stop-the-world, non-generational, non-moving Mark-Sweep collection. Root
  discovery scans Heap-external persistent values; `TypeInfo.trace` walks the
  Heap-internal transitive graph. Physical deallocation is private to the Heap.
  Final sink delivery remains post-commit. Abort invalidates scratch/emissions
  and all tentative storage.
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
  Both sections share one abort-only Heap transaction, so bind-time aggregate
  temporaries can never become committed storage.
- bind is async because every supported request context resolves before row 0;
  the per-row hot path never awaits or discovers a child context. Persistent
  initialization happens only when an
  emitted lexical `InitName` calls `needsInit`/`initialize`; its scratch and
  committed bits follow the same transaction. Physical subframe allocation is
  separate from scratch/committed activation: a first call activates
  tentatively, abort restores the old activation tree, successful
  provisional execution may retain its same-row candidate, and final commit
  promotes it. Request children
  recurse through the same JSRuntime class with a null sink, the parent's
  resolved scalar params (compilation-global), the shared request-context budget
  (maxRequestContexts, default 40), the exact layout registry, and an independent
  Heap/struct/collection runtime. Heap limits apply independently to each
  context.
- Request results are limited by the checker and defended again at binding to
  scalars or recursively scalar-only tuples. Each child row is copied into a
  parent-owned fixed-width result column; no `Ref` or host-resource handle may
  cross the child Heap boundary. The completed child then releases its Rings
  and Heap, while the merged view retains only the copied column and its lease.
- Every static edge consumes one request-context budget reservation; a hard
  resolution failure releases it.
- Every request edge reports its four evaluated options exactly once during
  bind. Zero `calc_bars_count` selects the full range; a positive safe integer
  selects an exact trailing child extent. Providers receive that demand, and
  the runtime clamps an over-returned context again at its own trust boundary.
  Child row indices restart at zero, pre-window history/merge prefixes are the
  result layout's typed empty, and empty nested pair components inherit the
  current context's provider-normalized symbol/timeframe identity.
- A static edge's history lives in its parent-row-indexed result ring.
- Merge is alignment, not data movement (`merge.ts` owns the mapping; the
  merged result is a parent-row-indexed view over child committed values).
  Merge reads committed child cells only — provisional child state is
  invisible by construction.
- Bind failures (bad param, missing series) throw `BindError` — user-facing
  and host-actionable; protocol misuse (out-of-order rows, unknown slots)
  is `fatal()`.
- `rt` imports only `base/` and `ir/`; runtime tests drive hand-lowered
  modules in exactly the shape codegen emits.
