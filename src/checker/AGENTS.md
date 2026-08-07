# checker

The Tea checker: an eager pass over syntax (the types2 shape) producing the
`Info` side tables the noder consumes. `catalog.ts` declares every host
primitive, `binding.ts` creates variable bindings and reassignment facts,
`scope.ts` owns lexical lookup, `check.ts` walks statements and expressions,
and `importer.ts` is the import seam (loading lives in `src/loader`).

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
  assignment target. This remains deliberately flow-insensitive, but the
  prepass is scope-sensitive: each side-table context records reassignment by
  canonical `ir.Name` identity, never by source spelling. Shadowed bindings
  and locals in other function/library instances cannot affect one another.
- Compile-time na has exactly one representation: `NA_VALUE`. Non-finite JS
  numbers are only generated/runtime artifacts; numeric literal conversion
  and every constant folder canonicalize all of them before publishing a
  `TypeAndValue` or feeding another folder, so malformed numeric artifacts can
  never enter a Program.
- A typed expression whose runtime value is na makes every comparison false,
  including inequality. A direct bare `na` operand in a comparison is a
  checker error; missingness tests use `na(x)`.
- `NativeParam.acceptsNa` owns parameter-level nullability beyond ordinary
  type assignability. Input defaults and concrete settings metadata reject
  folded `NA_VALUE` before noding, including min/max/step. Input overloads,
  dependent option types/default membership, source-default vocabulary,
  display domain/default, and active qualifier are catalog/checker-owned;
  downstream manifest or UI projections must not reinterpret them.
- Every `input.*` syntax call is one program-global parameter even when it
  appears in a local block, non-exported UDF, or scalar request capture.
  Source inputs in request captures and all inputs in exported functions are
  rejected. An input's `active` expression may read direct input bindings and
  program-root bind values, but never function/capture execution-frame state.
  Local declaration names are UI-label hints, not parameter identity, because
  separate scopes may reuse the same spelling.
- User-function declarations bind as templates; calls stencil one
  instantiation per Program owner and concrete argument signature (memoized),
  each with its own `SideTables` and a scope rooted at the template's base —
  the user global scope, or the owning library's scope. A request capture is
  a distinct Program owner: its function Names, frame layout, and mutable
  depth annotations must never alias the parent's or a sibling capture's.
  Recursion is rejected (the static call graph must stay acyclic for frame
  pre-allocation), and function bodies read but never write outer-scope
  variables.
- The checker is provenance-blind about libraries: it consumes the injected
  `Importer` only (`importer.ts`), seeding the universe scope from
  `implicit()` and calling `import(path)` at each import declaration —
  positioning the resolver's errors, never resolving paths itself. Library
  bodies check against a scope of the library's locals plus its own import
  bindings. Where libraries come from (builtin registry, filesystem,
  external distribution) is `src/loader`'s concern.
- Checker errors queue into the compilation's `Errors` and poison with
  `TypeKind.Invalid` (assignable both ways, unify-absorbed) so one error
  never cascades; the checker never throws on user input and silently
  tolerates Bad syntax nodes the parser already reported.
- Ambient series resolve to one pooled `SeriesInput` object per host id
  (`Info.series`), shared by every use — the depth pass annotates these
  objects in place.
- Request captures re-check in a CHILD context (fresh side tables and a
  fresh ambient pool): only constant values and direct scalar input bindings
  cross contexts; computed root aliases fail closed until capture dependency
  closure exists. Series/simple script variables and functions that read the
  context directly (ambient series or outer-scope variables, tracked by
  `FuncInstance.touchesContext`) are rejected with clean errors. Scalar input
  declarations remain compilation-global across the capture boundary; source
  inputs are context-owned and rejected there.
- `checkPackage` is the pipeline's check stage, wired between loadPackage
  and buildProgram behind a phase barrier in `src/compile.ts` — the only
  module that owns stage ordering.
- Semantic vocabularies are named constants, never bare string literals at
  use sites: `EntryKind.*` (scope entries), `Effect.*` (native effect
  classes), `TypeRef.*` / `JoinResult` (catalog signature markers) — the
  Tok/NodeKind/IrOp pattern applied to the checker's domains.
