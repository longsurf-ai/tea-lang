# tea-lang: Go-shaped importer seam

## 1. System map

```text
BEFORE                                  AFTER
compile.ts                              compile.ts (driver owns the loop)
  loadPackage (parse entry)               loadPackage (parse entry)   src/loader
  checkPackage ----+                      resolveImports(files)       src/loader
  buildProgram     |                        scan ImportStmts + implicit builtins
                   |                        registry: path -> source | external | null
  checker/check.ts v                        parse lib, recurse into ITS imports,
    checkImport():                          cycle detection, library("...") name
      builtinLibrary(path)  <-- checker     --> Importer
      hardcodes WHERE libs               barrier
      come from                          checkPackage(files, importer)
  checker/library.ts                     checker/check.ts
    loads src/tea-lib/*.tea                checkImport(): importer.import(path)
                                           universe scope <- importer.implicit()
                                         checker/importer.ts
                                           Importer + ResolvedLibrary (contract)
```

- Source of truth moves: "what a path resolves to" is owned by the loader's
  registry (driver side), never the checker. The checker consumes only the
  `Importer` interface — Go's `types2.Config.Importer` split.
- Invariant (L1, import-graph enforced): `src/checker/` must not import
  `src/loader/` or read the filesystem for libraries; `compile.ts` remains the
  only module chaining stages.
- `ResolvedLibrary {name, exports, locals}` is the export-surface contract
  (our "export data"); instantiation stays lazy per signature in the checker.
- External `owner/name/version` paths stay staged: the registry classifies
  them `external` and the resolver errors — a resolver decision, not checker
  semantics.

## 2. Problem

`checker/check.ts#checkImport` resolves import paths itself by calling
`builtinLibrary()` and rejects anything with a `/`. That hardcodes library
provenance into semantic analysis: adding filesystem or registry libraries
would mean editing the checker, and library-imports-library, cycle detection,
and load ordering have no owner at all. Go splits this three ways — build
driver owns the DAG and ordering, an injected `Importer` maps path → package,
the checker only consumes packages — and that is the shape we want.

Outcome: `resolveImports` becomes a driver stage between parse and check;
the checker binds `EntryKind.Library` entries exclusively from the injected
`Importer`. Behavior today is unchanged (builtins resolve, externals error
cleanly), but the seam makes recursion, cycles, and future sources real and
testable. Codegen/runtime are out of scope.

## 3. Implementation

1. **Importer contract** — `src/checker/importer.ts`
   - `ResolvedLibrary {name, exports: Map<string, FuncDecl>, locals: …}`
     (today's `BuiltinLibrary`, renamed) and
     `Importer {implicit(): readonly ResolvedLibrary[]; import(path): ResolvedLibrary | {error: string}}`.
   - Types only; no filesystem, no registry.
2. **Loader owns loading** — new `src/loader/loader.ts`; `src/noder/noder.ts`,
   `src/checker/library.ts` (deleted)
   - Move `loadPackage` out of noder (noder keeps `buildProgram` only).
   - `resolveImports(files, errors, registry?): Importer` — collects entry
     ImportStmt paths + all implicit builtins, resolves via the registry
     (`path -> {source} | 'external' | null`), parses each library, extracts
     the `library("...")` name and export/local surfaces, recurses into the
     library's own ImportStmts with a path stack (cycle → error naming the
     chain), memoizes per path.
   - Default registry serves `src/tea-lib/*.tea`; tests inject fakes.
3. **Checker consumes the seam** — `src/checker/check.ts`, `scope.ts`
   - `check`/`checkPackage` take the `Importer`; universe scope seeds from
     `implicit()`; the redeclare guard derives its name set the same way.
   - `checkImport` becomes: placement check → `importer.import(raw)` →
     position the resolver's error, or declare the alias binding. No
     `builtinLibrary` calls, no `/` special case in the checker.
4. **Driver stage** — `src/compile.ts`, `src/main.ts`
   - `compile`/`compileToProgram`: loadPackage → resolveImports (barrier) →
     checkPackage(files, importer) → buildProgram. Import updates for the
     loadPackage move.
5. **Tests** — `src/loader/loader.test.ts`, `src/checker/check.test.ts`
   - Fake-registry tests: library importing a library resolves through the
     chain; A→B→A reports an import cycle; unknown path and external path
     produce the staged errors; implicit ta unchanged.
   - Existing fixtures (`imports.tea`, ta-suite, goldens) must pass untouched.
6. **Docs** — `src/loader/AGENTS.md` (new), checker/noder/package AGENTS,
   `docs/ir.md` libraries paragraph: resolution is driver-owned; checker is
   provenance-blind.

## 4. Verification

- [x] `npm run typecheck` clean; `npm test` passes with existing fixtures
      and goldens unchanged (behavior-preserving refactor).
- [x] Loader unit tests: fake registry chain (lib imports lib) resolves;
      cycle errors with the chain in the message; unknown → `unknown library`;
      external path → staged error.
- [x] `grep -r "from '../loader" src/checker` returns nothing (layering
      invariant holds).
- [x] `node --import tsx src/main.ts parse --ir tests/fixtures/macd.tea` output identical to the
      committed golden.
