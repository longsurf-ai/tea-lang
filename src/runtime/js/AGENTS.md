# JavaScript runtime

`runtime.ts` is the sole JavaScript semantic runtime. It owns State,
same-row Intermediate, and one context-local Heap. `fixed-history.ts` is the
finite provider/sink host adapter. `collections/`, `struct-storage.ts`,
`state-update.ts`, and `heap.ts` are execution mechanics, not shared ABI.

## Invariants

- `JSRuntime.step()` executes one complete row and returns an Effect. A
  successful provisional step replaces only Intermediate; a successful final
  step replaces State and Intermediate. Failure replaces neither.
- State owns bounded newest-first frame, series, builtin, and request history.
  Intermediate contains only the current frame candidate and never owns Heap.
- Each runtime owns one Heap and at most one active transaction. A successful
  step commits state and storage together; abort discards tentative storage and
  all output/effects. Disposal is idempotent.
- Struct values are source-hidden references to Heap-owned bodies. Assignment
  copies the reference. Collection headers are immutable values whose mutations
  allocate replacement backing. Precise roots cover both State and
  Intermediate before collection.
- Every value and result slot carries exact layout identity. Layout validation,
  typed empties, shallow byte accounting, and storage-root tracing come only
  from the shared `ValueLayoutRegistry`.
- `fixed-history.ts` resolves the main provider context and every static request
  before row zero. Each request child owns an independent JSRuntime and Heap;
  only copied scalar sample results enter the parent. Collect requests are a
  public Node feature and are rejected here.
- Fixed-history owns row chronology, deterministic `timeNow`, fixed-width state
  accounting, sink publication, and request-context budgets. A sink exception
  makes the execution terminal.
- `executeFixedHistory()` is only ordered repetition of the ordinary bind,
  `runAll()`, and dispose lifecycle. It is not a batch runtime or scheduler.
- Generated `RuntimeContext` exposes Tea operations only. It never exposes
  physical history arrays, Heap cells, provider objects, or host buffers.
