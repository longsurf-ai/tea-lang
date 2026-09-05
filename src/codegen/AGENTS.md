# codegen

Bind-independent target lowering from the one canonical `Program`.
`codegen.ts` + `lower.ts` emit a recursive self-describing `JSModule`; only its
`main` and `funcs` target the execution `RuntimeContext`. Its raw
`bind(module, contextConstants?)` callback writes calculated facts into a private
configuration draft; the loader captures that callback behind
`module.bind(values, context?)`, which mutates and returns the existing module.
`wgsl/` audits the supported generic Program subset and emits a complete WGSL module with target layouts. `docs/runtime.md`
owns both execution boundaries.

## Invariants

- Dense ids (sid/pid/oid/fid/slots) are assigned here and published in the
  module; the runtime never re-derives them from the Program. Frame
  ownership is explicit: a method owns its hidden receiver, and every func
  owns its explicit params + locals; the program frame owns every remaining
  Name — never ownership by reachability. `ir/frames.ts` is the one
  target-neutral ownership + call-site topology projection; JS and WGSL add
  only their physical frame representations.
- `gpu/contract.ts` is the one versioned physical WebGPU artifact contract.
  WGSL lowering consumes its fixed bindings/offsets/strides and produces it;
  runtime validates the same constants instead of importing codegen modules.
- Both targets consume `Program` directly. There is no strategy wrapper IR and
  no strategy-only lowering entry. A backend may reject unsupported Program
  constructs, but it must not reconstruct source semantics from output effect
  spellings or recognize `broker`, `portfolio`, `trade`, a coordinator family,
  lifecycle method, or another Tea library by package/type name. The native
  `strategy()` declaration is ordinary output metadata; direct trade-family
  values and their statically specialized methods are ordinary Program state
  and calls. Checker-only interfaces have no runtime representation.
- Target lowering is pure and bind-independent. JS/WGSL generation receives no
  external data source, series payload, parameter set, job list, result capacity, GPU
  device, or dispatch policy. CPU/GPU runtimes own those physical inputs after
  codegen.
- Runtime ABI 10 has no parallel manifest. The module owns `inputs` (Arrow
  schema, numeric series, typed builtins), `parameters`, `state` (one shared
  layout table plus frame templates), `outputs` (one Arrow schema and physical
  declarations), and `requests` (metadata beside each executable child).
  Codegen emits schema IPC; loading restores Arrow objects.
- One output schema owns field names, structure and `tea:write`/`tea:kind`
  metadata. Set declarations precede append declarations; generated `emit` and
  `append` share one output-ID space. Declaration entries contain only combined
  arguments and physical layout IDs, never duplicate Arrow fields.
- Static depths, activity, arguments and request contexts emit directly. The
  raw binding callback first resets every generated late fact, then checks for
  missing parameters, then computes new facts. A missing contextual value must
  never leave an older ready depth or argument array behind.
- Typed builtin `constant` flags come from the checked qualifier, never name
  matching. Host-provided fixed values belong to each module's context; codegen
  receives none of them.
- A WGSL artifact embeds the ordinary generated module. GPU preparation uses
  the same public `module.bind` method on an independent module per job to
  resolve parameter-dependent capacities; there is no second expression language or preparation engine.
- Only Time-Machine ops lower to ctx calls; arithmetic, comparisons, math
  intrinsics, and na()/nz() expand inline via the rules tables in lower.ts.
  Backend-specific rendering decisions live only in those tables.
- Numeric ranges have no arbitrary target trip-count cap. JS and WGSL capture
  bounds once, preserve inclusive ascending/descending semantics and
  break/continue/index-write behavior, and terminate a dynamic zero or
  non-progressing update safely. A separate sparse-effect analysis may still
  require a provable emission bound; that transport constraint is not loop
  eligibility.
- Persistent declarations are lexical `InitName` statements. JS lowering must
  place initializer evaluation inside a `ctx.needsInit` guard and publish it
  with `ctx.initialize`; modules have no detached initializer-thunk table.
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
- Synthesized mixed history demands normalize each bound component in generated
  module binding before `math.max`; never normalize only the
  aggregate, because one invalid/unsafe input offset must contribute zero
  without erasing another valid demand.
- Generated code is deterministic and pure: no Date, no Math.random, no
  host I/O; generation of the same Program is byte-identical (locked by
  tests).
- Portability contract: strict-mode ES2015 FunctionBody, no module syntax,
  whitelisted globals only (Math.\*, Number.isFinite, Number.isNaN, String,
  Error, NaN) — enforced
  by the acorn ES2015 parse gate and deny-list test in
  codegen/portability.test.ts. New emissions must stay inside the ceiling.
- Request edges lower to one primitive: JSON metadata in
  `module.requests[rid]`, with the child Program generated as a sibling
  `JSModule` (`M1`, `M2`… in dependency order) and stored in that entry's `module`
  field. Every child carries the same ABI and shared `state.layout` reference.
  Static pairs/options emit directly into `module.requests[rid].context`; late
  values are assigned by the private binding callback. Execution reads the prepared result via
  `ctx.request(rid, offset)`. Each spec also carries the direct declaration
  `name`, `Sample`/`Collect` mode, child `resultSlot`/`resultLayout`, and parent
  `layout`; collect therefore transports child scalars while the parent sees an
  array layout. The noder rejects every dynamic edge before a valid Program
  reaches codegen, so generated request contexts are static. Every edge
  evaluates options and pair once in Program-owned source order; bound values
  have no parallel owner. Every module's code names its own funcs table via its
  const (`ctx.moduleRef`), never `M`.
- Typed builtins are a distinct runtime carrier: dense bids and exact
  `{source, layout, depth}` specs publish in `module.inputs.builtins`, reads lower
  to `ctx.builtin`, and bound history becomes concrete module depth.
  Numeric application series remain `ctx.series` only.
- Struct construction and field access lower through `newStruct`,
  `structField`, and `storeStructField` using exact module layouts. A field
  store validates and captures its reference before the RHS. Collection
  mutation captures either its Name or struct-field location before explicit
  arguments and writes only the replacement header afterward. Mutable method
  calls validate and capture the shared receiver before explicit arguments and
  return only their declared result. WGSL fails closed for every reachable
  struct reference until a later GPU storage design lands.
- `schema.ts` owns the only Type-to-Arrow Field projection, shared by JS and
  WGSL. Generated modules embed standard Arrow IPC schema bytes; loading
  restores genuine Arrow objects. Nominal identity comes from
  `Program.nominalIds`, never display names or a parallel recursive schema.
  Physical value layouts retain the same nominal ids for runtime validation.
- Output bind arguments and per-bar channels evaluate in their Program-owned
  source order before codegen assembles the canonical host argument order.
- Staged constructs (matrix iteration, unlisted natives) throw
  UnimplementedError at generation — exit 2, never wrong code.
- Bound depth expressions may read root-frame immutable aliases and call
  input-only UDFs; request options may also read context-constant builtins.
  The raw binding callback evaluates only the supported non-allocating
  const/input/simple subset directly from module parameter values and
  permitted context constants; it has no provisional frame or Heap.
  Row-varying demands remain capped.
