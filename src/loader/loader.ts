// Purpose: Source loading and import resolution — the driver-side half of the import seam: parses entry files, resolves import paths through a registry, loads libraries recursively with cycle detection, and hands the checker an Importer. Never reports user errors; the checker positions them.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {formatPos, newFileBase} from '../base/pos';
import {fatal, type Errors} from '../base/print';
import {
  isImportError,
  type Importer,
  type ImportOutcome,
  type ResolvedLibrary,
} from '../checker/importer';
import {NodeKind, type Expr, type File, type FuncDecl} from '../syntax/nodes';
import {parse} from '../syntax/syntax';
import {LitKind} from '../syntax/tokens';

// Frontend orchestrator: one parse per file.
export function loadPackage(
  filenames: readonly string[],
  errors: Errors,
): File[] {
  return filenames.map(filename =>
    parse(newFileBase(filename), readFileSync(filename, 'utf8'), (pos, msg) =>
      errors.errorAt(pos, msg),
    ),
  );
}

// What a registry says about an import path: a loadable source, a path that
// belongs to an external distribution mechanism, or nothing.
export interface LibrarySource {
  readonly filename: string;
  readonly source: string;
}

export type Registry = (path: string) => LibrarySource | 'external' | null;

// Builtin libraries ship with the compiler; single-segment import paths only.
const BUILTIN_FILES: ReadonlyMap<string, string> = new Map([['ta', 'ta.tea']]);

// Every builtin library is implicitly imported into every script.
const DEFAULT_IMPLICIT: readonly string[] = [...BUILTIN_FILES.keys()];

export function defaultRegistry(
  path: string,
): LibrarySource | 'external' | null {
  if (path.includes('/')) {
    return 'external';
  }
  const filename = BUILTIN_FILES.get(path);
  if (filename === undefined) {
    return null;
  }
  return {
    filename: `lib/${filename}`,
    source: readFileSync(join(import.meta.dir, '../lib', filename), 'utf8'),
  };
}

// The driver stage between parse and check: builds the Importer and prewarms
// it with the entry files' import paths plus the implicit set, so load work
// (parsing, recursion, cycle detection) happens here. Outcomes are cached;
// the checker re-asks and positions any errors at the import statements.
export function resolveImports(
  files: readonly File[],
  registry: Registry = defaultRegistry,
  implicitPaths: readonly string[] = DEFAULT_IMPLICIT,
): Importer {
  const resolver = new Resolver(registry, implicitPaths);
  resolver.implicit();
  for (const file of files) {
    for (const stmt of file.stmtList) {
      if (stmt.kind === NodeKind.ImportStmt) {
        resolver.import(stmt.path.value);
      }
    }
  }
  return resolver;
}

class Resolver implements Importer {
  private readonly cache = new Map<string, ImportOutcome>();
  private readonly loading: string[] = [];
  private implicitLibs: readonly ResolvedLibrary[] | null = null;

  constructor(
    private readonly registry: Registry,
    private readonly implicitPaths: readonly string[],
  ) {}

  implicit(): readonly ResolvedLibrary[] {
    if (this.implicitLibs === null) {
      this.implicitLibs = this.implicitPaths.map(path => {
        const outcome = this.import(path);
        if (isImportError(outcome)) {
          // Implicit libraries are compiler-owned; failing to load one is a
          // defect, never a user error.
          return fatal(`builtin library '${path}': ${outcome.error}`);
        }
        return outcome;
      });
    }
    return this.implicitLibs;
  }

  import(path: string): ImportOutcome {
    const cached = this.cache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    if (this.loading.includes(path)) {
      const chain = [...this.loading.slice(this.loading.indexOf(path)), path];
      return this.remember(path, {
        error: `import cycle: ${chain.join(' -> ')}`,
      });
    }
    const entry = this.registry(path);
    if (entry === null) {
      return this.remember(path, {error: `unknown library '${path}'`});
    }
    if (entry === 'external') {
      return this.remember(path, {
        error: `external libraries are not supported yet ('${path}')`,
      });
    }
    this.loading.push(path);
    const outcome = this.load(path, entry);
    this.loading.pop();
    return this.remember(path, outcome);
  }

  private remember(path: string, outcome: ImportOutcome): ImportOutcome {
    this.cache.set(path, outcome);
    return outcome;
  }

  private load(path: string, {filename, source}: LibrarySource): ImportOutcome {
    const problems: string[] = [];
    const file = parse(newFileBase(filename), source, (pos, msg) =>
      problems.push(`${formatPos(pos)}: ${msg}`),
    );
    if (problems.length > 0) {
      return {error: `library '${path}' failed to parse: ${problems[0]}`};
    }

    let name: string | null = null;
    const exports = new Map<string, FuncDecl>();
    const locals = new Map<string, FuncDecl>();
    const imports = new Map<string, ResolvedLibrary>();
    for (const stmt of file.stmtList) {
      if (stmt.kind === NodeKind.ExprStmt && name === null) {
        const declared = libraryDeclarationName(stmt.x);
        if (declared !== null) {
          name = declared;
          continue;
        }
      }
      if (stmt.kind === NodeKind.FuncDecl) {
        locals.set(stmt.name.value, stmt);
        if (stmt.exported) {
          exports.set(stmt.name.value, stmt);
        }
        continue;
      }
      if (stmt.kind === NodeKind.ImportStmt) {
        const dep = this.import(stmt.path.value);
        if (isImportError(dep)) {
          return {error: `in library '${path}': ${dep.error}`};
        }
        imports.set(stmt.alias?.value ?? dep.name, dep);
        continue;
      }
      return {
        error: `library '${path}' contains an unexpected top-level statement`,
      };
    }
    if (name === null) {
      return {error: `library '${path}' has no library() declaration`};
    }
    return {path, files: [file], name, exports, locals, imports};
  }
}

// library("ta") -> 'ta'; null when the expression is anything else.
function libraryDeclarationName(e: Expr): string | null {
  if (e.kind !== NodeKind.CallExpr) {
    return null;
  }
  if (e.fun.kind !== NodeKind.Name || e.fun.value !== 'library') {
    return null;
  }
  const first = e.args[0]?.value;
  if (
    first === undefined ||
    first.kind !== NodeKind.BasicLit ||
    first.litKind !== LitKind.String
  ) {
    return null;
  }
  // The lexeme keeps its quotes; library names never need escapes.
  return first.value.slice(1, -1);
}
