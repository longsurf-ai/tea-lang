# loader

The driver-side half of the import seam: parses entry files (`loadPackage`)
and resolves import paths into libraries (`resolveImports`), handing the
checker an `Importer`. Go's split: the build driver owns the DAG; the checker
only consumes packages.

## Invariants

- The registry is the source of truth for what an import path means:
  loadable source, `external` (staged distribution mechanism), or unknown.
  Adding a library source kind changes the registry, never the checker.
- Resolution is recursive with cycle detection (the error names the chain)
  and memoized per path; a library's own imports resolve here, and its
  binding table (aliases applied) travels on `ResolvedLibrary.imports`.
- The loader never reports user errors: outcomes are cached and the checker
  positions them at the import statements. Implicit (builtin) libraries
  failing to load is `fatal` — a compiler defect.
- `src/checker` production code must not import this package; the seam is
  `checker/importer.ts` and the driver (`compile.ts`) injects the instance.
  Test helpers are the sanctioned exception.
