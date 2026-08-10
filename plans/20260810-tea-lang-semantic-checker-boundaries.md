# Tea checker semantic ownership refactor

## 1. System map

```text
syntax.File[]
     |
     v
+---------------- Checker ----------------+
| Package -> Scope -> Object -> Type       |
| root Info                                |
| FunctionInstance -> instance Info        |
| RequestCall -> checked capture Info      |
+------------------------------------------+
     |
     v
+----------------- Noder -----------------+
| ProgramContext                          |
| VarObject     -> IrName                 |
| BuiltinObject -> SeriesInput            |
| FunctionInstance -> per-Program IrFunc  |
+------------------------------------------+
     |
     v
Program {params, requests, outputs, body}
     |
     v
runtime frames, rings, bindings, and buffers
```

- The semantic `Package -> Scope -> Object -> Type` graph is the source of
  truth for declarations. `Info` only records syntax-occurrence relationships.
- L1 invariant: checker results contain no `IrName`, `SeriesInput`,
  `HistoryDepth`, `ParamInput`, `RequestEdge`, or Program identity. Type
  boundaries and import direction enforce this; tests lock the projections.
- One `Info` exists per semantic checking context. A fact that can vary by
  function signature or request capture can never live in a root map keyed only
  by syntax identity.
- Tea keeps its qualifier lattice, function stenciling, request checking, and
  UDT defaults. The refactor adopts Go's ownership topology, not Go's language
  semantics or lazy generic implementation.

## 2. Problem

The checker currently uses `ir.Name` as declaration identity, constructs
ambient `SeriesInput` objects, and uses a `SideTables` object as Program owner.
`ScopeEntry` consequently mixes syntax templates, types, libraries, and backend
objects. Root-only `Info.captures` and `Info.udtDefaults` also omit the semantic
instance in which their expressions were checked.

This is already incorrect: a series-valued UDT default produces a const
constructor, defaults noded inside functions or requests lack type facts, and
the same request-call syntax in two function stencils overwrites one capture
with the other. The change is compiler-internal only; runtime and generated
Program behavior stay stable except for those correctness repairs.

## 3. Implementation

1. **Establish semantic identity** — `packages/tea-lang/src/checker/object.ts`,
   `scope.ts`, `binding.ts`
   - Add `Package`, persistent `Scope`, and a discriminated `Object` union for
     variables, function templates, type names, fields, enum members, imported
     packages/libraries, and ambient builtins.
   - Bind declarations and reassignment by `VarObject` identity. Storage,
     checked type, qualifier, and folded declaration value stay semantic;
     history depth and lowered initialization do not.

2. **Make `Info` the only occurrence-fact surface** — `checker/info.ts`,
   `check.ts`
   - Replace exported `SideTables` and the three call maps with per-context
     `Info` and one discriminated `CallResolution` union.
   - Record definitions, uses, scopes, selections, calls, and reassignment
     against semantic objects. Function instances are keyed only by
     `(FunctionObject, type + qualifier signature)` and own their `Info`; they
     are not keyed by a physical Program.

3. **Give declared types and captures real owners** — `checker/check.ts`
   - Make type-name objects own nominal UDT types and field objects. Each field
     owns its checked default initializer; constructor resolution aligns every
     supplied or defaulted argument to a field and joins all qualifiers.
   - Store request capture facts in the current call resolution/`Info`, never in
     root-global maps. Keep child-context legality checking and exact context
     effects semantic.

4. **Project semantic objects into Program IR** — `noder/noder.ts`
   - Add an explicit per-Program context that interns `VarObject -> IrName` and
     `BuiltinObject -> SeriesInput`, and owns request/function IR caches. The
     same semantic function instance projects to distinct `IrFunc`/`IrName`
     graphs in distinct Programs.
   - Noder becomes the sole creator of IR names, ambient inputs, Params,
     RequestEdges, slots, and function frames. Depth analysis continues to
     annotate the resulting IR places.

5. **Expose a checked package boundary** — `checker/check.ts`, `compile.ts`,
   `loader/`
   - Return `CheckedPackage {pkg, root}` from the check stage even while
     entry compilation remains single-file. Package/import scopes point to
     semantic objects; imported untyped functions remain lazy templates.
   - Update `AGENTS.md` and `docs/ir.md` in place so the new ownership contract
     replaces the obsolete shared-IR-name and Program-owned-stencil rules.

## 4. Verification

- [x] `bun test src/checker` passes, including field/default qualifier,
      declaration identity, and per-instance request-capture regressions.
- [x] `bun test src/noder` passes, including constructors inside UDF/request
      contexts and distinct IR resources for parent/child Programs.
- [x] `bun run typecheck` proves checker production code imports neither
      `ir/node.ts` nor `ir/program.ts` and all call variants are exhaustive.
- [x] `bun test` passes the complete standalone Tea suite and IR goldens.
- [x] Exact-file Prettier and typed ESLint pass for every changed Tea source and
      documentation file.
- [x] `just check` was run on the final branch state. Repository preflight
      remains red on the worktree's pre-existing import-standard violations,
      unrelated `.impeccable/hook.cache.json` formatting, and stale authoring
      assets; the Tea package checks above are green.
