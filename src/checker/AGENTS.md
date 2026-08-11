# checker

The Tea checker: an eager semantic pass over syntax (the types2 shape)
producing a `CheckedPackage`. `package.ts`, `scope.ts`, and `object.ts` own the
semantic declaration graph; `info.ts` owns per-context occurrence facts;
`catalog.ts` declares every host primitive; `type-catalog.ts` owns the complete
source-facing type vocabulary and its writable projections; `binding.ts`
creates variable objects and reassignment facts; `check.ts` walks statements
and expressions; and `importer.ts` is the import seam (loading lives in
`src/loader`).

## Invariants

- `Package → Scope → Object → Type` is the semantic source of truth.
  Declaration sites create canonical semantic objects; scopes contain those
  objects, and `Info.defs`/`Info.uses` relate syntax occurrences to them. The
  checker never creates or mutates `IrName`, `SeriesInput`, `ParamInput`,
  `RequestEdge`, `HistoryDepth`, slots, or frames; those are noder/IR
  projections.
- `Info` contains only facts about syntax occurrences in one semantic context:
  expression types, definitions, uses, selections, scopes, calls, and
  reassignment. The package root, every function instance, and every request
  capture have the exact `Info` in which they were checked. No root map keyed
  only by syntax may store a fact that can vary by instance or capture, and an
  `Info` is never backend Program identity.
- Every call occurrence has exactly one discriminated `CallResolution`:
  native, function, constructor, or request. Noding switches on that result;
  parallel per-feature call maps are forbidden.
- A `UserTypeObject` owns its nominal type, ordered `FieldObject`s, and nested
  `MethodObject`s. Fields and methods share one declaration namespace while
  field indices ignore interleaved methods. Each field owns its checked default
  expression, including the `Info` and
  `TypeAndValue` from the context where the default was checked, plus its exact
  semantic dependencies. A constructor resolution aligns every supplied or
  defaulted argument with its field, joins all argument qualifiers, and applies
  capture policy only to defaults that call actually omits; user-type defaults
  never live in a root-global auxiliary map.
- Collection and user-type updates are rooted value writebacks. The checker
  publishes one canonical `CheckedMutationTarget` inside the existing update
  or call fact; it never models ordinary user values as object references or
  assigns Heap persistence policy.
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
  prepass is scope-sensitive: each semantic context records reassignment by
  canonical `VariableObject` identity, never by source spelling. Shadowed
  bindings and locals in other function/library instances cannot affect one
  another.
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
- User-function and nested-method declarations bind as semantic templates;
  calls stencil one `FunctionInstance` per
  `(FunctionObject, concrete type + qualifier signature)` (memoized),
  independent of any physical Program. Imported polymorphic free-function
  bodies follow this same lazy rule: package elaboration predeclares the
  canonical templates and resolves every written parameter annotation as part
  of the complete public type API, but does not invent a body instance before
  a concrete call signature exists. Each instance
  owns its explicit source-parameter objects and `Info`. A method instance also
  owns exactly one synthetic `this` receiver object, separate from its source
  signature, params, defaults, and argument order. `this` is valid only as the
  receiver base of field/method selection; mutable methods require a current
  rooted caller place, while const methods accept values and history and cannot
  write through their receiver. A method's declared result type is resolved at
  its owner and checked against every instantiated body. Method defaults are
  declaration-scope expressions: they may read globals but may not reference
  `this` or any method parameter, and a rejected omitted default never owns a
  lowerable call resolution. Every method also has one canonical checker-only
  declaration-validation instance (declared parameter types, least-constrained
  qualifiers, and a mode-derived receiver); without a real `CallExpr`, that
  instance is never projected into Program IR. Instance scopes root at the
  template's base —
  the user package scope, or the owning library's scope. The same
  instance may be projected into multiple root/request Programs; each
  `ProgramLoweringContext` must create a distinct `IrFunc`, name graph, frame,
  slots, and depth annotations. Recursion is rejected (the static call graph
  must stay acyclic for frame pre-allocation), and function bodies read but
  never write outer-scope variables.
- The checker is provenance-blind about libraries: its injected `Importer`
  (`importer.ts`) supplies only a `SourcePackage` path and parsed files. The
  checker positions loader errors and recursively elaborates each source once
  into a semantic `Package`; it alone interprets `library()`, validates the
  package root and declaration conflicts, and checks types, enums, defaults,
  methods, and imports. A library root permits imports, declarations, and
  single-name `const` values only; tuple constants, mutable values, and
  executable statements are rejected. Where sources come from and how paths
  form a dependency DAG remain `src/loader` concerns.
- `Package.imports` contains unique direct dependency identities, never local
  spellings. Each import alias is a `PackageNameObject` in the importing
  scope. `Package.exports` maps public names directly to the same canonical
  `Object`s held by the package scope; it is the sole cross-package namespace,
  so private objects never resolve through an alias.
- Qualified APIs resolve through that canonical export map: `pkg.function`,
  `pkg.Type`, `pkg.Type.new`, and `pkg.Enum.member` all record their package and
  member occurrences in the active `Info`. Imported methods remain owned and
  resolved by their exported `UserTypeObject`, not by the caller's lexical
  scope.
- Checker errors queue into the compilation's `Errors` and poison with
  `TypeKind.Invalid` (assignable both ways, unify-absorbed) so one error
  never cascades; the checker never throws on user input and silently
  tolerates Bad syntax nodes the parser already reported.
- Ambient names resolve to semantic `BuiltinObject`s. They carry host identity,
  type, qualifier, and any fold value, but no backend depth or buffer state.
  The noder interns one `SeriesInput` per builtin in each Program projection.
- Request captures re-check in a CHILD semantic context with fresh `Info`:
  only constant values and direct scalar input bindings cross contexts;
  computed root aliases fail closed because no child-frame projection exists
  for them. Each `FunctionInstance` records the exact transitive set of
  non-local `VariableObject` and `BuiltinObject` dependencies. Ambient
  builtins reproject safely per Program; outer variables are accepted only
  when they are constants or direct scalar input bindings, otherwise rejected
  cleanly. Scalar input declarations remain compilation-global across the
  capture boundary; source inputs are context-owned and rejected there. The
  request call's own `CallResolution` owns the child semantic facts and result
  type; that capture is not physical Program identity.
- `checkPackage` is the pipeline's check stage, wired between loadPackage
  and buildProgram behind a phase barrier in `src/compile.ts` — the only
  module that owns stage ordering.
- Semantic vocabularies are named constants, never bare string literals at
  use sites: `ObjectKind.*`, `CallKind.*`, and `SelectionKind.*` (semantic
  facts), `Effect.*` (native effect classes), and `TypeRef.*` / `JoinResult`
  (catalog signature markers) — the Tok/NodeKind/IrOp pattern applied to the
  checker's domains.
