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
- Step stores pending local changes in a sparse write set keyed by LocalState
  identity and opens called frames lazily. Reads see pending writes before
  persistence defaults/history. Do not recreate WorkspaceFrame/WorkspaceLocal
  or a parallel mutable frame tree. Final history advancement still traverses
  retained calls, and all next histories are prepared before the Heap commit.
- Each runtime owns one Heap and at most one active transaction. A successful
  step validates and commits after main returns normally, including early return.
  A using scope aborts uncommitted storage on exit; failures discard tentative
  state and all output cells. Disposal is idempotent.
- Struct values are source-hidden references to Heap-owned bodies. Assignment
  copies the reference. Collection headers are immutable values whose mutations
  allocate replacement backing. Precise roots cover committed and
  same-index state before collection.
- Bindings retain captured empty Values. Collection backing and tuples retain
  captured elements directly; no runtime structural type table exists. Value
  checks its declared scalar kind, element types or actual struct constructor.
  Heap tracing visits Ref values and collection backing; byte accounting uses
  existing TypeInfo policies and concrete carrier sizes.
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
  Series methods; concrete Step remains a library implementation detail.
- Value captures before later operand effects. Arithmetic temporaries own no
  history. Series.init is lazy; needsInit/initialize allow a statement-level guard preserving a Tea return's function scope. Series.set stages a write, and function calls
  receive captured values. A history-bearing formal is copied into its own
  written call frame; separate written calls never share local state.
- Struct field writes call require() before evaluating their right-hand side.
  Bodies are generated class instances with named Value fields; Heap transaction
  views preserve their prototype and aliases while recording field writes.
  Nullable reads still return typed empties. Collection mutators return a new
  header plus their result; callers write the replacement to the captured location.

- Ordinary outputs and events share Arrow-directed detached snapshots taken at emission. Public values use named records, Lists and Maps; mutable Heap identity remains internal. Successful provisional Heap behavior is unchanged.

- StepResult contains one output-cell array aligned with the module Arrow schema. emit assigns one raw nullable value at most once; append adds one raw value in that column's execution order. Absence and explicit null share null; numeric NaN remains distinct. Fixed builtin values replace the current input vector before normal history reads and commits, so the first historical read remains typed-empty.
