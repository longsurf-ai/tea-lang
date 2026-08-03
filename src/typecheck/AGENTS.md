# typecheck

The Tea checker: an eager pass over syntax (the types2 shape) producing the
`Info` side tables the noder consumes. `catalog.ts` declares every host
primitive, `scope.ts` is the binder, `check.ts` walks statements and
expressions.

## Invariants

- The binder's objects ARE the IR Names: declaration sites create `ir.Name`
  objects directly (`Info.defs`/`Info.uses` map syntax names to these shared
  objects); there is no separate symbol representation to translate later.
- The catalog lists a builtin only if it is inexpressible in Tea. All of
  `ta.*` is prelude source compiled by the ordinary pipeline; a new builtin
  family is a catalog entry plus at most a noding policy, never new checker
  architecture.
- Qualifier propagation takes the later-known operand: expression results
  join their operands, native results follow the catalog (`'join'` or a
  fixed qualifier), control structures yield series, and writes join the
  enclosing flow qualifier (loop bodies join series).
- Fold values travel through a name only when reassignment is impossible:
  Tea `const` declarations, or plain declarations that never appear as an
  assignment target (the whole-file prepass is conservative, by name
  string).
- User-function declarations bind as templates; bodies are checked per
  concrete argument signature when calls are stenciled (the function slice).
- Checker errors queue into the compilation's `Errors` and poison with
  `TypeKind.Invalid` (assignable both ways, unify-absorbed) so one error
  never cascades; the checker never throws on user input and silently
  tolerates Bad syntax nodes the parser already reported.
- Ambient series resolve to one pooled `SeriesInput` object per host id
  (`Info.series`), shared by every use — the depth pass annotates these
  objects in place.
- Not wired into `compile()` yet: the check phase barrier lands with the
  noder slice, and `src/compile.ts` is the only place that ordering changes.
