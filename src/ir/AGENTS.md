# ir

The Tea middle-end vocabulary: the single type domain (`type.ts`), the typed
IR node set (`node.ts`), and the Program contract (`program.ts`). Design doc:
`../../docs/ir.md`.

## Invariants

- The compiler describes; the runtime implements. The Program is a pure
  static description — it never encodes Time Machine mechanics (ring buffers,
  copy-on-write, rollback, provisional overlays), which are runtime-owned.
- One type system. Checker, IR, and Program all share `type.ts`; no parallel
  spec-vs-backend type representations. Qualifiers
  (`const < input < simple < series`) are an orthogonal axis; combining values
  takes the later-known qualifier. History is a property of the qualifier
  axis, and `var`/`varip` persistence is a property of Names, orthogonal to
  both.
- One Program instance runs against exactly one context (one symbol ×
  timeframe axis) and owns its slots, bindings, and rollback. Requests
  compose by recursion — child Programs whose merged outputs are parent
  inputs — never by multi-context Programs.
- Variables in the Program are `Name` objects referenced directly from every
  IR use — no ids, no top-level variable table. They are backend objects, not
  checker declarations: the noder projects a semantic `VariableObject` to one
  `Name` per Program context, and parent/request-child Programs never share
  mutable names. Enumerations (allocation plans, serialized indices) are
  projections derived by walking, produced at the boundary that needs them.
  Type, qualifier, and storage copy from semantic facts; init and depth are
  noder/depth working fields, read-only after those passes finish.
- Every history-readable place's depth is resolvable no later than bind time
  (Names, series inputs, and request results all carry `HistoryDepth`);
  dynamic offsets exist only under a declared cap.
- Every IR expression carries `(type, qualifier)`; every use is a `Place`
  referencing its projected IR object and keeping its own position. There are
  no Bad nodes — the IR exists only for error-free compilations (the checker's
  phase barrier gates noding).
- Functions are called, never force-inlined: semantic `FunctionInstance`s are
  keyed by `(FunctionObject, type + qualifier signature)`, never by Program
  ownership. The noder projects an instance to a distinct `IrFunc` and name
  graph in each Program context. Each stateful call site's `SlotId` selects a
  sub-frame in the caller's frame; the frame tree is statically enumerable
  from the call graph and pre-allocated at bind — for user functions, the Tea
  prelude, and stateful natives alike.
- Free functions, const methods, and mutable methods are an exhaustive
  Program union. A method owns one hidden receiver Name separate from every
  source-visible param; const calls carry no writeback path, while mutable
  calls carry the rooted path used by success-only copy-out.
- `visit.ts` owns IR traversal; its switches are exhaustive over `IrKind`
  (a new kind fails compilation there until handled). Program fields are
  the external-needs interface (params, requests) plus emissions (outputs)
  — explicit even where derivable, so codegen/runtime never walk trees to
  learn what a program needs. Ambient context builtins (close,
  syminfo.\*) are never declared; composition internals (names, funcs,
  call-site slots) come from the visit projections.
- `ir` imports only `base/`; it must never import from `syntax/`,
  `checker/`, or `noder/` (dependencies point at `ir`, not out of it).
