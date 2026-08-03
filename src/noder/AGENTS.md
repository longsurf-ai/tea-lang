# noder

Checked syntax → Program. `loadPackage` parses the package's files;
`buildProgram` nodes one checked file into the Tea Program using the
checker's `Info` side tables; `depth.ts` is the depth resolution pass.

## Invariants

- The noder never re-checks: every type, qualifier, and resolution comes
  from `Info`. A Bad node or missing side-table entry here is a phase-barrier
  violation and `fatal()`s — never a queued user error.
- Aggressive folding: any expression the checker resolved to a constant
  nodes as a `Const`; const-qualified expressions are pure by construction,
  so folding never drops effects.
- Reference bindings are compile-time only: a never-reassigned declaration
  whose initializer is an input call binds the name to its `ParamInput`
  (reads become param reads, no per-bar write), and one whose initializer
  nodes to an `OutputRef` binds the name to its `OutputDecl` (fill resolves
  refs at init). Tea `const` declarations vanish entirely.
- Param identity: the binding name when the input call initializes a
  declaration, else `input@line:col`. One `ParamInput`/`OutputDecl` per call
  site, deduped by syntax node.
- Output args partition by when they are known: folded constants →
  `staticArgs`; output refs and at-most-simple exprs → `bindArgs` (init
  time); series exprs → `channels` + one per-bar `Emit` after the statement.
  `indicator()`/`strategy()` are OutputDecls whose effect is the native's
  name — script metadata is an emission to the host.
- History on a computed expression desugars to a synthetic `$hist@line:col`
  name written unconditionally every bar before the read — which is why the
  desugaring exists only at top level; inside a block it is a clean error.
- Depth resolution (first cut): all-const offsets take their max; a single
  bind-time offset stays `bound`; anything dynamic or mixed falls back to
  `capped` with the `indicator(max_bars_back=…)` cap or the engine default.
  Depths annotate the shared place objects (Names, series, params) in place.
- Program.init stays empty for now: hoisting const/input/simple work out of
  the bar loop is a later optimization, not a correctness requirement.
