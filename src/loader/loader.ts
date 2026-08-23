// Purpose: Source loading and import resolution — the driver-side half of the import seam: parses entry files, resolves import paths through a registry, loads source packages recursively with cycle detection, and hands the checker an Importer. Never reports user errors; the checker positions them.

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {formatPos, newFileBase} from '../base/pos';
import {fatal, type Errors} from '../base/print';
import {
  isImportError,
  type Importer,
  type ImportOutcome,
  type SourcePackage,
} from '../checker/importer';
import {NodeKind, type File} from '../syntax/nodes';
import {parse} from '../syntax/syntax';

// Frontend orchestrator: one parse per file.
export function loadPackage(
  inputs: readonly SourceInput[],
  errors: Errors,
): File[] {
  return inputs.map(input => {
    const {filename, source} =
      typeof input === 'string'
        ? {filename: input, source: readFileSync(input, 'utf8')}
        : input;
    return parse(newFileBase(filename), source, (pos, msg) =>
      errors.errorAt(pos, msg),
    );
  });
}

// What a registry says about an import path: a loadable source, a path that
// belongs to an external distribution mechanism, or nothing.
export interface PackageSource {
  readonly filename: string;
  readonly source: string;
}

// Entry packages normally arrive as filenames. Embedding hosts may provide
// source text with a virtual filename so positions remain stable without a
// temporary file; both forms enter the same loader/checker/noder pipeline.
export type SourceInput = string | PackageSource;

export type Registry = (path: string) => PackageSource | 'external' | null;

// Compiler-shipped libraries use single-segment import paths. Shipping a
// library and placing it in the implicit prelude are separate decisions:
// trade components stay visible as explicit source imports.
const BUILTIN_FILES: ReadonlyMap<string, string> = new Map([
  ['ta', 'ta.tea'],
  ['visual', 'visual.tea'],
  ['broker', 'broker.tea'],
  ['portfolio', 'portfolio.tea'],
  ['trade', 'trade.tea'],
]);

// Namespaced implicit packages and flattened prelude packages are distinct.
const DEFAULT_IMPLICIT: readonly string[] = ['ta'];
const DEFAULT_PRELUDE: readonly string[] = ['visual'];
const LOADER_DIR = dirname(fileURLToPath(import.meta.url));

function builtinFilename(filename: string): string {
  return join(LOADER_DIR, '../tea-lib', filename);
}

export function defaultRegistry(
  path: string,
): PackageSource | 'external' | null {
  if (path.includes('/')) {
    return 'external';
  }
  const filename = BUILTIN_FILES.get(path);
  if (filename === undefined) {
    return null;
  }
  return {
    filename: `tea-lib/${filename}`,
    source: readFileSync(builtinFilename(filename), 'utf8'),
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
  preludePaths: readonly string[] = DEFAULT_PRELUDE,
): Importer {
  const preludeSet = new Set(preludePaths);
  const registryWithPrelude: Registry = path =>
    preludeSet.has(path)
      ? (defaultRegistry(path) ?? registry(path))
      : registry(path);
  const resolver = new Resolver(
    registryWithPrelude,
    implicitPaths,
    preludePaths,
  );
  resolver.implicit();
  resolver.prelude();
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
  private implicitPackages: readonly SourcePackage[] | null = null;
  private preludePackages: readonly SourcePackage[] | null = null;

  constructor(
    private readonly registry: Registry,
    private readonly implicitPaths: readonly string[],
    private readonly preludePaths: readonly string[],
  ) {}

  implicit(): readonly SourcePackage[] {
    if (this.implicitPackages === null) {
      this.implicitPackages = this.implicitPaths.map(path => {
        const outcome = this.import(path);
        if (isImportError(outcome)) {
          // Implicit packages are compiler-owned; failing to load one is a
          // defect, never a user error.
          return fatal(`builtin library '${path}': ${outcome.error}`);
        }
        return outcome;
      });
    }
    return this.implicitPackages;
  }

  prelude(): readonly SourcePackage[] {
    if (this.preludePackages === null) {
      this.preludePackages = this.preludePaths.map(path => {
        const outcome = this.import(path);
        if (isImportError(outcome)) {
          return fatal(`builtin prelude '${path}': ${outcome.error}`);
        }
        return outcome;
      });
    }
    return this.preludePackages;
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

  private load(path: string, {filename, source}: PackageSource): ImportOutcome {
    const problems: string[] = [];
    const file = parse(newFileBase(filename), source, (pos, msg) =>
      problems.push(`${formatPos(pos)}: ${msg}`),
    );
    if (problems.length > 0) {
      return {error: `library '${path}' failed to parse: ${problems[0]}`};
    }

    // Dependency prewarming is intentionally a raw syntax scan. Package
    // headers, legal top-level forms, aliases, declarations, and exports are
    // semantic facts validated and materialized by the checker.
    for (const stmt of file.stmtList) {
      if (stmt.kind === NodeKind.ImportStmt) {
        const dep = this.import(stmt.path.value);
        if (isImportError(dep)) {
          return {error: `in library '${path}': ${dep.error}`};
        }
      }
    }
    return {path, files: [file]};
  }
}
