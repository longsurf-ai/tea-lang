// Purpose: The import seam — the checker consumes parsed source packages exclusively through this contract; path resolution, loading, and ordering are the loader's (driver-side) concern.

import type {File} from '../syntax/nodes';

// The loader-owned source boundary. Header interpretation, declarations,
// exports, import aliases, and every other semantic fact belong to the checker.
export interface SourcePackage {
  readonly path: string;
  readonly files: readonly File[];
}

export interface ImportError {
  readonly error: string;
}

export type ImportOutcome = SourcePackage | ImportError;

export function isImportError(outcome: ImportOutcome): outcome is ImportError {
  return 'error' in outcome;
}

// The checker calls import() at each import declaration and seeds ambient
// packages from implicit(); it never learns where package sources come from.
export interface Importer {
  implicit(): readonly SourcePackage[];
  import(path: string): ImportOutcome;
}
