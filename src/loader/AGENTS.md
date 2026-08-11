# loader

The driver-side half of the import seam: parses entry files (`loadPackage`)
and resolves import paths into source packages (`resolveImports`), handing the
checker an `Importer`. The build driver owns the DAG; the checker consumes
parsed package sources and owns their semantics.

## Invariants

- The registry is the source of truth for what an import path means:
  loadable source, `external` (staged distribution mechanism), or unknown.
  Adding a package source kind changes the registry, never the checker.
- Resolution is recursive with cycle detection (the error names the chain)
  and memoized per path. The loader scans each parsed file's raw top-level
  `ImportStmt`s only to prewarm that dependency DAG. A `SourcePackage` carries
  exactly its registry path and parsed files; import aliases never cross this
  seam.
- The loader performs no package-header or top-level semantic validation. It
  does not interpret `library()`, collect declarations or exports, apply
  aliases, or decide which statements are legal in an imported package. The
  checker materializes and validates that semantic `Package` from the complete
  source boundary.
- The loader never reports user errors: outcomes are cached and the checker
  positions them at the import statements. Implicit (builtin) libraries
  failing to load is `fatal` — a compiler defect.
- `src/checker` production code must not import this package; the seam is
  `checker/importer.ts` and the driver (`compile.ts`) injects the instance.
  Test helpers are the sanctioned exception.
