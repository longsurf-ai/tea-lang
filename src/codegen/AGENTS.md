# codegen

Program → self-describing JS module (code + manifest) against the rt ABI;
`docs/runtime.md` owns the module contract. `codegen.ts` assigns dense ids
and assembles sections; `lower.ts` is the emitter — expression/statement
lowering plus the per-backend rules tables.

## Invariants

- Dense ids (sid/pid/oid/fid/slots) are assigned here and published in the
  manifest; the kernel never re-derives them from the Program. Frame
  ownership is explicit: a func owns its params + locals, the program frame
  owns every remaining Name — never ownership by reachability.
- Only Time-Machine ops lower to rt calls; arithmetic, comparisons, math
  intrinsics, and na()/nz() expand inline via the rules tables in lower.ts.
  Backend-specific rendering decisions live only in those tables.
- Division and modulo by zero are na (the $div/$mod helpers), int division
  truncates, And/Or stay lazy (statement-lowered when the right side needs
  statements), ternaries evaluate all operands (Pine semantics).
- Generated code is deterministic and pure: no Date, no Math.random, no
  host I/O; generation of the same Program is byte-identical (locked by
  tests).
- Staged constructs (UDT execution, for-in/collections, request reads,
  unlisted natives) throw UnimplementedError at generation — exit 2, never
  wrong code.
- Bound depth expressions must be evaluable without a frame (constants and
  scalar param reads); the depth pass guarantees it by falling back to
  capped otherwise.
