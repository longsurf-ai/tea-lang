# ir

The Tea middle-end vocabulary: the single type domain (`type.ts`), the typed
IR node set (`node.ts`), and the Program contract (`program.ts`). Design doc:
`../../docs/ir.md`.

## Invariants

- The compiler describes; the runtime implements. The Program is a pure
  static description — it never encodes Time Machine mechanics (ring buffers,
  copy-on-write, rollback, provisional overlays), which are runtime-owned.
- One type system. Checker, IR, and Program all share `type.ts`; no parallel
  spec-vs-backend type representations. Qualifiers (`const < input < simple <
series`) are an orthogonal axis combined by lattice join; history is a
  property of the qualifier axis, and `var`/`varip` persistence is a property
  of slots, orthogonal to both.
- One Program instance runs against exactly one context (one symbol ×
  timeframe axis) and owns its slots, bindings, and rollback. Requests
  compose by recursion — child Programs whose merged outputs are parent
  inputs — never by multi-context Programs.
- Variables are `Name` objects: one shared declaration object per variable,
  referenced directly from every use — no ids, no top-level variable table.
  Enumerations (allocation plans, serialized indices) are projections derived
  by walking, produced at the boundary that needs them. The binder's objects
  ARE these Names — one object set from binding through codegen. Analysis
  fields (type, qualifier, depth, init) are mutable working fields owned by
  the annotating pass, read-only afterward.
- Every history-readable place's depth is resolvable no later than bind time
  (Names, series inputs, and request results all carry `HistoryDepth`);
  dynamic offsets exist only under a declared cap.
- Every IR expression carries `(type, qualifier)`; every use is a `Place`
  referencing its declaration object and keeping its own position. There are
  no Bad nodes — the IR exists only for error-free compilations (the
  checker's phase barrier gates noding).
- Call-site identity is the universal state mechanism: instantiations are
  per-signature, and runtime state identity is the dynamic chain of
  `CallStateId`s (the call path) — for user functions, the Tea prelude, and
  stateful natives alike.
- `ir` imports only `base/`; it must never import from `syntax/`,
  `typecheck/`, or `noder/` (dependencies point at `ir`, not out of it).
