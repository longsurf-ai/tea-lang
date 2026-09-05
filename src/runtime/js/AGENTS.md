# JavaScript runtime

`runtime.ts` is the sole JavaScript semantic runtime. It owns State,
same-row Intermediate, and one context-local Heap. Public `Node` owns the CPU
reactive graph and each runtime it creates. `collections/`, `struct-storage.ts`,
`state-update.ts`, and `heap.ts` are execution mechanics, not shared ABI.

## Invariants

- `JSRuntime.step()` executes one complete row and returns an Effect. A
  successful provisional step replaces only Intermediate; a successful final
  step replaces State and Intermediate. Failure replaces neither.
- State owns bounded newest-first frame, series, builtin, and request history.
  Intermediate contains only the current frame candidate and never owns Heap.
- Each runtime owns one Heap and at most one active transaction. A successful
  step commits state and storage together; abort discards tentative storage and
  all output cells. Disposal is idempotent.
- Struct values are source-hidden references to Heap-owned bodies. Assignment
  copies the reference. Collection headers are immutable values whose mutations
  allocate replacement backing. Precise roots cover both State and
  Intermediate before collection.
- Every value and result slot carries exact layout identity. Layout validation,
  typed empties, shallow byte accounting, and storage-root tracing come only
  from the shared `ValueLayoutRegistry`.
- Each public request-child Node owns an independent JSRuntime and Heap. Only
  validated copied request values enter the parent runtime; collect arrays are
  materialized in the parent Heap.
- Node owns index chronology and public result delivery. Finite source adapters
  supply deterministic `timeNow`, extent, context metadata, and request data
  before Recipe calls `Node.bind()`.
- `JSRuntime` never iterates parameter bindings, acquires external data, or owns a
  finite-job scheduler.
- Generated `RuntimeContext` exposes Tea operations only. It never exposes
  physical history arrays, Heap cells, source objects, or host buffers.

- Ordinary outputs and events share Arrow-directed detached snapshots taken at emission. Public values use named records, Lists and Maps; mutable Heap identity remains internal. Successful provisional Heap behavior is unchanged.

- StepResult contains one output-cell array aligned with the module Arrow schema. emit assigns record channels; append adds an ordinal/payload entry. Fixed builtin values replace the current input vector before normal history reads and commits, so the first historical read remains typed-empty.
