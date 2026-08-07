# codegen

Program → self-describing JS module (code + manifest) against the rt ABI;
`docs/runtime.md` owns the module contract. `codegen.ts` assigns dense ids
and assembles sections; `lower.ts` is the emitter — expression/statement
lowering plus the per-backend rules tables.

## Invariants

- Dense ids (sid/pid/oid/fid/slots) are assigned here and published in the
  manifest; the runtime never re-derives them from the Program. Frame
  ownership is explicit: a func owns its params + locals, the program frame
  owns every remaining Name — never ownership by reachability.
- Only Time-Machine ops lower to rt calls; arithmetic, comparisons, math
  intrinsics, and na()/nz() expand inline via the rules tables in lower.ts.
  Backend-specific rendering decisions live only in those tables.
- Division and modulo by zero are na (the $div/$mod helpers), int division
  truncates, And/Or stay lazy (statement-lowered when the right side needs
  statements), ternaries evaluate all operands (Pine semantics).
- Runtime numeric values are finite-or-na: every arithmetic and numeric-native
  result passes through `$num`, which canonicalizes NaN and both infinities to
  NaN. Equality and inequality are both false when either typed operand is na;
  subject-form switch matching uses that same equality rule, and string
  concatenation propagates reference na instead of spelling `null`. A raw
  non-finite Program constant is an upstream invariant violation and fails
  lowering instead of being repaired here.
- Synthesized mixed history demands normalize each bound component through
  `rt.historyDepth` before `math.max`; never normalize only the aggregate,
  because one invalid/unsafe input offset must contribute zero without erasing
  another valid demand.
- Generated code is deterministic and pure: no Date, no Math.random, no
  host I/O; generation of the same Program is byte-identical (locked by
  tests).
- Portability contract: strict-mode ES2015 FunctionBody, no module syntax,
  whitelisted globals only (Math.\*, Number.isFinite, Number.isNaN, String,
  NaN) — enforced
  by the acorn ES2015 parse gate and deny-list test in
  codegen/portability.test.ts. New emissions must stay inside the ceiling.
- Request edges lower to one primitive: JSON metadata in
  `manifest.requests[rid]` (incl. the `dynamic` flag — bind-evaluability
  of the context args), the child Program recursively generated as a
  sibling const (`M1`, `M2`… in dependency order — code cannot live in the
  JSON manifest) referenced from `requests: [...]`. Static edges declare
  their pair via `rt.bindRequest` in the frame-aware bind section and read via
  `rt.request(rid, offset)`; a dynamic edge's offset-null read evaluates
  its context args inline and calls `rt.requestFor(rid, sym, tf)` — the
  noder guarantees dynamic reads are offset-null only (history rides
  materialized Names). Every module's code names its own funcs table via
  its const (`ctx.moduleRef`), never `M`.
- Staged constructs (UDT execution, for-in/collections, collect merge,
  request currency/calc_bars_count, unlisted natives) throw
  UnimplementedError at generation — exit 2, never wrong code.
- Bound depth expressions may read root-frame immutable aliases and call
  input-only UDFs. `bind()` evaluates them against the provisional root frame
  after the immutable input prelude; context-owned or row-varying demands
  remain capped.
