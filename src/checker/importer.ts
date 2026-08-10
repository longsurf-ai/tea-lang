// Purpose: The import seam — the checker consumes libraries exclusively through this contract; path resolution, loading, and ordering are the loader's (driver-side) concern.

import type {File, FuncDecl} from '../syntax/nodes';

// A library's checked-surface contract (our "export data"): namespaced
// templates the checker instantiates lazily per signature.
export interface ResolvedLibrary {
  // Registry identity and parsed syntax retained so the checker can expose a
  // real semantic Package boundary rather than a namespace-only projection.
  readonly path: string;
  readonly files: readonly File[];
  // From the file's own library("...") declaration.
  readonly name: string;
  // Exported templates — the public resolution surface (ta.ema).
  readonly exports: ReadonlyMap<string, FuncDecl>;
  // Every template including unexported ones — the intra-library
  // resolution surface (rsi calls rma by plain name).
  readonly locals: ReadonlyMap<string, FuncDecl>;
  // The library's own imports, binding name -> library (aliases applied);
  // the checker adds these to the library's resolution scope.
  readonly imports: ReadonlyMap<string, ResolvedLibrary>;
}

export interface ImportError {
  readonly error: string;
}

export type ImportOutcome = ResolvedLibrary | ImportError;

export function isImportError(outcome: ImportOutcome): outcome is ImportError {
  return 'error' in outcome;
}

// Go's types2.Importer shape: the checker calls import() at each import
// declaration and seeds ambient namespaces from implicit(); it never learns
// where library sources come from.
export interface Importer {
  implicit(): readonly ResolvedLibrary[];
  import(path: string): ImportOutcome;
}
