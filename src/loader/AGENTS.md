# loader

The driver-side half of the import seam: parses entry files (`loadPackage`)
and resolves import paths into source packages (`resolveImports`), handing the
checker an `Importer`. The build driver owns the DAG; the checker consumes
parsed package sources and owns their semantics.

## Invariants

- `docs/imports.md` owns how an import names a package. A path that starts
  with `./` or `../` is a file beside the importing one: `importedFile`
  resolves it to a canonical path, which is the package identity and the cache
  key, and the loader reads it with `readFileSync`. The registry is never
  asked about a file, so a file cannot shadow a library.
- For every other path the registry is the source of truth: loadable source,
  `external` (staged distribution mechanism), or unknown. Adding a package
  source kind changes the registry, never the checker.
- Resolution is recursive with cycle detection (the error names the chain)
  and memoized per path. The loader scans each parsed file's raw top-level
  `ImportStmt`s only to prewarm that dependency DAG. A `SourcePackage` carries
  exactly its registry path or canonical file path and its parsed files;
  import aliases never cross this seam.
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
- The loader owns canonical enumeration of the source files that can affect a
  Program. That closure is the ordered entry files, every compiler-shipped
  Tea library, and the files reached through relative imports; `compile.ts`
  owns the unambiguous exact-byte hash over that enumeration.
