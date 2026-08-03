// Purpose: Builtin library loader — Tea-authored standard libraries under src/lib, parsed once; each file's library("...") declaration names its namespace. A failure here is a compiler defect, never a user error.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {formatPos, newFileBase} from '../base/pos';
import {fatal} from '../base/print';
import {NodeKind, type Expr, type FuncDecl} from '../syntax/nodes';
import {LitKind} from '../syntax/tokens';
import {parse} from '../syntax/syntax';

export interface BuiltinLibrary {
  // The namespace from the file's library("...") declaration; builtin
  // libraries are implicitly imported into every script under this name.
  readonly name: string;
  // Exported templates — the public resolution surface (ta.ema).
  readonly exports: ReadonlyMap<string, FuncDecl>;
  // Every template including unexported ones — the intra-library
  // resolution surface (rsi calls rma by plain name).
  readonly locals: ReadonlyMap<string, FuncDecl>;
}

// Library source files shipped with the compiler; the namespace comes from
// each file's own library() declaration, not from this list.
const FILES = ['ta.tea'];

let loaded: ReadonlyMap<string, BuiltinLibrary> | null = null;

function load(): ReadonlyMap<string, BuiltinLibrary> {
  if (loaded !== null) {
    return loaded;
  }
  const libraries = new Map<string, BuiltinLibrary>();
  for (const filename of FILES) {
    const path = join(import.meta.dir, '../lib', filename);
    const src = readFileSync(path, 'utf8');
    const problems: string[] = [];
    const file = parse(newFileBase(`lib/${filename}`), src, (pos, msg) =>
      problems.push(`${formatPos(pos)}: ${msg}`),
    );
    if (problems.length > 0) {
      return fatal(`builtin library failed to parse: ${problems.join('; ')}`);
    }

    let name: string | null = null;
    const exports = new Map<string, FuncDecl>();
    const locals = new Map<string, FuncDecl>();
    for (const stmt of file.stmtList) {
      if (stmt.kind === NodeKind.ExprStmt) {
        const declared = libraryDeclarationName(stmt.x);
        if (declared !== null && name === null) {
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
      return fatal(
        `builtin library ${filename} contains an unexpected top-level statement`,
      );
    }
    if (name === null) {
      return fatal(`builtin library ${filename} has no library() declaration`);
    }
    if (libraries.has(name)) {
      return fatal(`duplicate builtin library name '${name}'`);
    }
    libraries.set(name, {name, exports, locals});
  }
  loaded = libraries;
  return libraries;
}

// library("ta") → 'ta'; null when the expression is anything else.
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
    return fatal('library() declaration requires a string title');
  }
  // The lexeme keeps its quotes; builtin library names never need escapes.
  return first.value.slice(1, -1);
}

export function builtinLibrary(name: string): BuiltinLibrary | null {
  return load().get(name) ?? null;
}

export function builtinLibraries(): readonly BuiltinLibrary[] {
  return [...load().values()];
}

// True when declaring name would shadow a builtin library namespace.
export function isBuiltinLibraryName(name: string): boolean {
  return load().has(name);
}
