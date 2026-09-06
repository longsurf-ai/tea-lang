# noder

Checked semantics → Program. `buildProgram` nodes one checked file into the
Tea Program using the exact per-context `Info` produced by the checker;
`depth.ts` owns depth policy and normalization, while `depth-walk.ts` owns
lexical traversal and single-write bind-known discovery. Source loading lives in
`src/loader`.

## Invariants

- The noder never re-checks: every type, qualifier, and resolution comes
  from the active semantic context's `Info`. A Bad node or missing fact here
  is a phase-barrier violation and `fatal()`s — never a queued user error.
- The noder is the sole semantic-to-backend projection. Each
  `ProgramLoweringContext` interns `VariableObject → IrName` and projects each
  `BuiltinObject` through its catalog-owned binding to either `SeriesInput` or
  `BuiltinInput`; the noder also creates `ParamInput`,
  `RequestEdge`, `IrFunc`, synthetic/result names, call-site slots, and the
  static frame layout. Checker objects never acquire backend depth, init,
  slot, or frame state.
- Aggressive folding: any expression the checker resolved to a constant
  nodes as a `Const`; const-qualified expressions are pure by construction,
  so folding never drops effects.
- `TypeKind.Na` is checker-only. Noding contextualizes every `NA_VALUE` with
  the concrete nullable type known from its declaration, branch join, field,
  or call parameter; an uncontextualized na reaching Program construction is
  a phase-barrier violation and `fatal()`s.
- Struct constructors consume their one `ConstructorCall` resolution. Its
  field-ordered arguments include supplied expressions and field-owned
  defaults; each `CheckedExpression` supplies the exact semantic `Info` to use
  while the value lowers into the caller's current Program and frame. A
  default expression is never prebuilt IR shared between Programs.
- A checked `StructFieldStore` projects to the ordinary `FieldGet` destination of `Assign`; binding destinations use `Read`. Compound assignment retains its operator so lowering captures the receiver and previous value exactly once. Collection inout calls reuse these destinations with a concrete intrinsic signature/effect descriptor; user method policy remains on the callee.
- Reference bindings- Parameter bindings are compile-time only: a never-reassigned input-call declaration binds its name to `ParamInput`. Tea const declarations vanish entirely. Visual values use ordinary names, structs, calls and history; there are no output handles.
- Param identity- Param identity: the binding name when the input call initializes a program-
  scope declaration, else `input@line:col`. Inputs in local blocks and
  non-exported UDFs, plus scalar inputs in request captures, are extracted
  globally; local declaration spellings are labels, never identities, because
  separate scopes may reuse them. The checker guarantees each extracted
  `active` expression is evaluable without its source function/capture frame.
  One `ParamInput` per call site, deduped by syntax node; output columns instead use their checker-owned static names. Supported
  projections must not discard fields: the exclusive range/options constraint,
  concrete group/inline/tooltip/confirm/display metadata, nominal enum type, and
  input-qualified `active` expression are copied into that ParamInput after
  the checker rejects invalid metadata.
- Exported values must have finite Arrow schemas. The noder reports recursive
  output or effect payload types through the compilation's Errors; recursive
  structs used only inside execution remain valid. Nominal declaration ids
  pass directly from the checked package into Program.nominalIds.
- `Info.emits` projects to one Program-owned column table and `Emit(output, value)`. Columns carry name, write mode and Tea value type. Visual declarations and append payloads use this same path; no output-wrapper expansion or separate effect declaration remains.
- `Return` nodes preserve lexical exits and concrete result types. Ternaries node as lazy `IfExpr` using the original checked qualifier/type; returning branches carry no block value.
- History is valid- History is valid only on a direct readable binding. Noding projects that
  binding to its ordinary `Place` and never creates a synthetic history Name;
  offset zero follows the same checked-binding rule as every other offset. Current reads use `Read`; `HistRead` always carries an explicit offset.
- Depth resolution walks each UDF body in call-site context. It substitutes
  parameters and single-write bind-known locals with root-safe expressions,
  then combines every constant/bound demand on a carrier into one exact,
  na-safe maximum. Any remaining per-bar or unresolved frame dependency is
  `capped` by the engine's generic 500-bar fallback. Depths
  annotate the noder-created IR place objects (names, series, params, and
  requests) in place and accumulate across the recursive Program graph; every
  `bound` expression is normalized for lowering from the root bind frame.
  Immutable root-safe `simple` aliases, including typed builtins, are
  exact `DepthKind.Bound` demands rather than conservatively capped history.
  A history read indexed exactly by a numeric range induction variable uses
  that range's bind-safe maximum; compound induction arithmetic stays capped
  until a general interval pass can prove it without under-allocation.
- Alias bindings: a never-reassigned plain declaration whose initializer is
  a current-bar read of a STABLE place (series, param, STATIC request —
  never a Name, whose later writes would leak through) binds the name to
  the place, so history offsets land on the place itself. The noder computes
  `RequestEdge.dynamic` from bind-evaluability, then reports every dynamic edge
  as unsupported before a Program can cross the phase barrier. Direct
  request-call history is rejected with every other computed history operand.
- A checked request call nodes into one `RequestEdge` whose `name` is the
  direct top-level declaration target and therefore the public Node stream key.
  Symbol/timeframe/merge evaluate in the parent context; the captured scalar
  expression nodes against the request resolution's child `Info` into a child
  Program with its own name and series projection, frame, slot counter,
  request list, and `$result` Name. `captureType` is the child result type;
  `resultType` is the parent's scalar `T` for sample mode or `array<T>` for
  collect mode. `request.security` selects `Sample`, and
  `request.security_lower_tf` selects `Collect`. The child `Info` is semantic
  capture facts, not Program identity or an IR cache key.
  Direct bind-time params stay compilation-global — a child references the
  parent's `ParamInput` objects and declares none of its own. Computed root
  aliases are rejected by the checker until dependency-closure extraction can
  materialize them there.
- One `IrFunc` per checker `FunctionInstance` per Program projection, its body
  noded against the instance's `Info` under its own frame-local slot counter.
  All user calls use `CallFunc`; the callee distinguishes free functions and receiver modes. A
  method's hidden receiver is projected separately from explicit params and
  from named/default argument ordering. Every user-call site mints the next
  slot of the frame it sits in — the sub-frame selector. Omitted arguments node
  the instance's checked default expression at the call site; defaults must not
  reference sibling params.
- Program.init stays empty for now: hoisting const/input/simple work out of
  the bar loop is a later optimization, not a correctness requirement.
- Reachable imported package globals project as ordinary program-frame Names.
  `Program.packageGlobals` carries explicit dependency order (including
  imported-before-importer), and dependency-ordered `InitName` statements are
  prepended to that Program's body. The projection includes only state reached
  through actual global reads/function dependencies plus initializer closure;
  a bare import, exported type use, or unused sibling global never allocates
  state. Every request child receives a fresh Name projection of the same
  canonical semantic object.
