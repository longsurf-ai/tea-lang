# JavaScript runtime

`context.ts` is the JavaScript execution owner. It owns committed history,
same-index values, and one context-local Heap. `value.ts` owns captured values
and semantic operators; `series.ts` owns typed history/write access. Public `Node` owns the CPU
reactive graph and each runtime it creates. `collections/`, `struct-storage.ts`,
`state-update.ts`, and `heap.ts` are execution mechanics, not shared ABI.

## Invariants

- `Context.step()` executes one complete row synchronously and returns StepResult.
  A successful provisional step replaces same-index values; a successful final
  step also advances committed history. Failure changes neither and throws.
- Context owns bounded newest-first frame, series, builtin, and request history.
  Same-index state contains persistent candidate values and never owns Heap.
- Each runtime owns one Heap and at most one active transaction. A successful
  step validates and commits after main returns normally, including early return.
  A using scope aborts uncommitted storage on exit; failures discard tentative
  state and all output cells. Disposal is idempotent.
- Struct values are source-hidden references to Heap-owned bodies. Assignment
  copies the reference. Collection headers are immutable values whose mutations
  allocate replacement backing. Precise roots cover committed and
  same-index state before collection.
- Every value and result slot carries exact layout identity. Layout validation,
  typed empties, shallow byte accounting, and storage-root tracing come only
  from the shared `StorageTypes`.
- Each public request-child Node owns an independent Context and Heap. Only
  validated copied request values enter the parent runtime; collect arrays are
  materialized in the parent Heap.
- Node owns index chronology and public result delivery. Finite source adapters
  supply deterministic `timeNow`, extent, context metadata, and request data
  before Recipe calls `Node.bind()`.
- Context never acquires external data or owns a finite-job scheduler. Module
  owns parameter binding; Node owns streams and synchronized requests.
- Generated Context types expose exact parameters, named Input records, typed
  Frame locals/calls and output destinations. Generated functions use Value and
  Series methods; numeric storage IDs and concrete Step remain library internals.
- Value captures before later operand effects. Arithmetic temporaries own no
  history. Series.init is lazy; needsInit/initialize allow a statement-level guard preserving a Tea return's function scope. Series.set stages a write, and function calls
  receive captured values. A history-bearing formal is copied into its own
  written call frame; separate written calls never share local state.
- Struct field writes call require() before evaluating their right-hand side.
  Nullable reads still return typed empties. Collection mutators return a new
  header plus their result; callers write the replacement to the captured location.

- Ordinary outputs and events share Arrow-directed detached snapshots taken at emission. Public values use named records, Lists and Maps; mutable Heap identity remains internal. Successful provisional Heap behavior is unchanged.

- StepResult contains one output-cell array aligned with the module Arrow schema. emit assigns one raw nullable value at most once; append adds one raw value in that column's execution order. Absence and explicit null share null; numeric NaN remains distinct. Fixed builtin values replace the current input vector before normal history reads and commits, so the first historical read remains typed-empty.
