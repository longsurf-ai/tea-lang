# runtime

Tea execution after bind-independent codegen. `JSRuntime` is the sole
JavaScript semantic runtime and owns step-based State, Intermediate, and Heap
execution. Fixed-historical provider/sink orchestration is a host adapter in
`fixed-history.ts`; GPU binding projection lives in
`module-binding.ts`. `abi.ts` is the stable host-facing facade; the physical
`JSModule`, `JSModuleBinding`, and execution-only `Runtime` stay internal to
`module-abi.ts`. `value.ts`, `schema.ts`, `provider.ts`, `output.ts`,
`binding.ts`, and `errors.ts` own the remaining contracts, and
`docs/runtime.md` is the authority.
Generic batch execution and GPU binding/execution also live here because bindings,
datasets, buffers, devices, dispatch, and readback are runtime facts.
The backend-neutral `executeProgram()` host harness lives one level above in
`src/execute.ts`; CLI reporting and Dawn process selection are host concerns.

## Invariants

- `JSRuntime` owns its `State`, `Intermediate`, and Heap. Its
  `step()` returns an `Effect`: successful provisional steps replace only the
  owned Intermediate, successful final steps replace both State and
  Intermediate, and failures replace neither. `StepResult` exposes only dense
  output, effects, and provisional finality. Disposal is idempotent.
- The generic `Intermediate` contract contains only its frame root. Heap is an
  injected resource of `stateMachine()` and is owned/disposed by
  `JSRuntime`; it never crosses the transition result. Root discovery
  scans the runtime's retained State and Intermediate before beginning the next
  Heap transaction.
- The fixed-historical adapter consumes evaluated binding facts and recursively
  executes static request children through independent `JSRuntime` instances.
  TeaNode Observable request wiring is a separate, still-unimplemented host
  concern; do not confuse that API gap with runtime request support.
- The generated execution body receives only Time-Machine operations; it never
  sees history indices, scratch storage, provider objects, or physical layout.
  `JSModule.bind(values)` is a separate pure function returning immutable
  `JSModuleBinding` data. Generated implementations may delegate expression
  evaluation to the loader-injected private helper in `module-binding.ts`, but
  that evaluator is not an ABI interface and is never implemented by
  `JSRuntime`. Do not merge binding-only operations or a dynamic-request
  protocol into the execution-only `Runtime`.
- `RUNTIME_ABI_VERSION` is the only JavaScript Runtime ABI version source and
  is currently `4`; do not add compatibility branches for earlier versions.
- Runtime implementation files import the narrow internal contract they use,
  never their own `abi.ts` facade. The versioned physical GPU artifact lives
  in `gpu/contract.ts`; runtime/gpu must not import codegen implementation
  modules or duplicate fixed physical constants.
- CPU batch execution is not a second compiler or strategy runtime. It loads
  one ordinary generated JS module and passes each caller-ordered `BindInputs`
  element through the fixed-historical `bindFixedHistory()` / `runAll()` /
  `dispose()` adapter lifecycle.
  Every binding owns its own `OutputSink`; `runCpuBatch` neither captures
  outputs nor imposes capacity, job ids, or sweep metadata. `MemorySink` is an
  optional caller policy for structured in-memory capture.
- Batch execution has no plan or journal abstraction. Caller array order is
  binding identity, and retention, bounds, and transactions belong to the
  injected sink.
- GPU execution consumes a bind-independent WGSL artifact, an injected
  `GPUDevice`, and an ordered `BindInputs[]`. It resolves providers, validates
  and normalizes required inputs, evaluates the artifact's generated JS binding
  sidecar through `module-binding.ts`, sizes each binding's history payload,
  derives dense capacity, bounds sparse effect storage, and packs private buffers while
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
  never consults wall-clock time. Public/fixed-history module-fact evaluation
  is provider-independent, so no builtin is bind-visible there; GPU's separate
  provider-aware layout projection may read only context-constant
  syminfo/timeframe metadata. Historical
  `barstate` is derived solely from the target row/extent and never invents a
  realtime update object.
- `step()` always runs the full row from its storage-class baseline — no
  incremental update paths exist. A perBar candidate resets to na; var/varip seed
  from the last committed value only after committed initialization;
  declaration-site `InitName` remains eligible otherwise. varip keeps its
  value/rebinding candidate across completed same-row executions; an ordinary
  var retains only its first successful same-row initialization candidate.
  A final success pushes the candidate into history; rollback discards it.
- Every local and request result carries an exact `LayoutId`; the shared
  registry validates values, derives typed empty, and walks nested collection
  storage roots. State keeps newest-first bounded history values, and
  `var`/`varip` retain at least one committed value regardless of history depth.
- The fixed-historical adapter accounts frame workspace, input history, and
  materialized request-result columns against the shared
  `maxFixedValueLogicalBytes` budget using exact shallow layout sizes. A child
  runtime and Heap are disposed after its scalar result column is copied;
  accounting for the parent-owned column remains until its request view is
  released.
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
  Final sink delivery remains post-commit. Abort invalidates candidates/emissions
  and all tentative storage.
- A history offset names a cell only when it is a non-negative safe integer.
  Every other offset (including na, infinity, fractions, and negatives) returns
  the place's typed empty value and retains zero cells when reported at bind;
  it can never address a future row or become an array length.
- The loader-private binding evaluator applies the history-depth rule to each
  synthesized bound-demand component before they are maximized; an invalid
  component contributes zero and cannot poison a valid depth from the same
  carrier.
- Provider series values are finite numbers or NaN. Infinity is an impossible
  provider state and fails loudly at the read; host numeric inputs are stricter
  and reject NaN and both infinities at bind, while int inputs additionally
  require a safe integer so the runtime representation stays exact.
- Each `JSModule` has one pure `bind(values) -> JSModuleBinding` boundary for
  immutable depths, parameter activity, output args, and static request
  pairs/options. The generated implementation uses a loader-private evaluator;
  its frame and local abort-only Heap transaction are discarded before the
  binding data returns, so bind-time aggregate temporaries never enter
  execution state. The same module owns the provider-aware layout projection
  consumed by GPU preparation.
- `bindFixedHistory()` is async because every supported request context resolves before row 0;
  the per-row hot path never awaits or discovers a child context. Persistent
  initialization happens only when an
  emitted lexical `InitName` calls `needsInit`/`initialize`; its scratch and
  committed bits follow the same transaction. Opening logical child-frame state
  is separate from same-row/committed activation: a first call activates
  tentatively, abort restores the old activation tree, successful
  provisional execution may retain its same-row candidate, and final commit
  promotes it. The fixed-historical adapter recursively creates one `JSRuntime`
  per static request child, passing compilation-global params, the shared
  request-context/fixed-width budgets, and exact layout registry. Each child
  owns an independent Heap, so Heap limits apply separately per context.
- Request results are limited by the checker and defended again at binding to
  scalars or recursively scalar-only tuples. Each child row is copied into a
  parent-owned fixed-width result column; no `Ref` or host-resource handle may
  cross the child Heap boundary. The completed child is disposed immediately;
  the merged view retains only the copied column and its accounting.
- Every static edge consumes one request-context budget reservation; a hard
  resolution failure releases it.
- Every request edge returns its four evaluated options exactly once in
  `JSModuleBinding`. Zero `calc_bars_count` selects the full range; a positive
  safe integer selects an exact trailing child extent. Providers receive that
  demand, and the runtime clamps an over-returned context again at its own trust
  boundary. Child row indices restart at zero, pre-window history/merge
  prefixes are the result layout's typed empty, and empty nested pair components
  inherit the current context's provider-normalized symbol/timeframe identity.
- A static edge's history lives in its parent-row-indexed result sequence.
- Merge is alignment, not data movement (`merge.ts` owns the mapping; the
  merged result is a parent-row-indexed view over copied child results).
  Merge reads successful final child values only — provisional child state is
  invisible by construction.
- Bind failures (bad param, missing series) throw `BindError` — user-facing
  and host-actionable; protocol misuse (out-of-order rows, unknown slots)
  is `fatal()`.
- `rt` imports only `base/` and `ir/`; runtime tests drive hand-lowered
  modules in exactly the shape codegen emits.
