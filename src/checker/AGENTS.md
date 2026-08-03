# checker

The Tea checker: an eager pass over syntax (the types2 shape) producing the
`Info` side tables the noder consumes. `catalog.ts` declares every host
primitive, `scope.ts` is the binder, `check.ts` walks statements and
expressions, `library.ts` loads the builtin Tea-authored libraries.

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
- User-function declarations bind as templates; calls stencil one
  instantiation per concrete argument signature (memoized), each with its
  own `SideTables` and a scope rooted at the template's base — the user
  global scope, or the owning library's scope. Recursion is rejected (the
  static call graph must stay acyclic for frame pre-allocation), and
  function bodies read but never write outer-scope variables.
- Standard libraries are ordinary Tea libraries under `src/lib`, loaded by
  `library.ts`: each file's `library("...")` declaration names its
  namespace, exported templates are the public surface, and every builtin
  library is implicitly imported (a `Library` entry in the universe scope
  above the file's global scope). `import <lib> [as alias]` re-binds or
  aliases builtins; external `owner/name/version` paths are a clean error
  until a distribution story exists. There is no separate prelude
  mechanism.
- Checker errors queue into the compilation's `Errors` and poison with
  `TypeKind.Invalid` (assignable both ways, unify-absorbed) so one error
  never cascades; the checker never throws on user input and silently
  tolerates Bad syntax nodes the parser already reported.
- Ambient series resolve to one pooled `SeriesInput` object per host id
  (`Info.series`), shared by every use — the depth pass annotates these
  objects in place.
- Request captures re-check in a CHILD context (fresh side tables and a
  fresh ambient pool): only bind-time (⊑ input) script values cross
  contexts; series/simple script variables and functions that read the
  context directly (ambient series or outer-scope variables, tracked by
  `FuncInstance.touchesContext`) are rejected with clean errors. Placement
  rules treat captures like function bodies.
- `checkPackage` is the pipeline's check stage, wired between loadPackage
  and buildProgram behind a phase barrier in `src/compile.ts` — the only
  module that owns stage ordering.
- Semantic vocabularies are named constants, never bare string literals at
  use sites: `EntryKind.*` (scope entries), `Effect.*` (native effect
  classes), `TypeRef.*` / `JoinResult` (catalog signature markers) — the
  Tok/NodeKind/IrOp pattern applied to the checker's domains.
