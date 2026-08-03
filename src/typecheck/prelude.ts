// Purpose: Prelude loader — the Tea-authored standard library (ta.*) parsed once and exposed as namespaced function templates; a parse error here is a compiler defect, never a user error.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {formatPos, newFileBase} from '../base/pos';
import {fatal} from '../base/print';
import {NodeKind, type FuncDecl} from '../syntax/nodes';
import {parse} from '../syntax/syntax';

interface Prelude {
  // 'ta.ema' → template, the resolution surface for user calls.
  readonly templates: ReadonlyMap<string, FuncDecl>;
  // Plain-name templates per namespace, for intra-prelude resolution
  // (rsi calls rma by its plain name).
  readonly locals: ReadonlyMap<string, FuncDecl>;
  readonly roots: ReadonlySet<string>;
  // Display names ('ta.ema') keyed by template identity.
  readonly displayNames: ReadonlyMap<FuncDecl, string>;
}

const SOURCES = [{namespace: 'ta', filename: 'ta.tea'}] as const;

let loaded: Prelude | null = null;

function load(): Prelude {
  if (loaded !== null) {
    return loaded;
  }
  const templates = new Map<string, FuncDecl>();
  const locals = new Map<string, FuncDecl>();
  const roots = new Set<string>();
  const displayNames = new Map<FuncDecl, string>();
  for (const {namespace, filename} of SOURCES) {
    const path = join(import.meta.dir, '../prelude', filename);
    const src = readFileSync(path, 'utf8');
    const problems: string[] = [];
    const file = parse(newFileBase(`prelude/${filename}`), src, (pos, msg) =>
      problems.push(`${formatPos(pos)}: ${msg}`),
    );
    if (problems.length > 0) {
      return fatal(`prelude failed to parse: ${problems.join('; ')}`);
    }
    roots.add(namespace);
    for (const stmt of file.stmtList) {
      if (stmt.kind !== NodeKind.FuncDecl) {
        return fatal(
          `prelude ${filename} contains a non-function top-level statement`,
        );
      }
      const dotted = `${namespace}.${stmt.name.value}`;
      templates.set(dotted, stmt);
      locals.set(stmt.name.value, stmt);
      displayNames.set(stmt, dotted);
    }
  }
  loaded = {templates, locals, roots, displayNames};
  return loaded;
}

export function preludeTemplate(path: string): FuncDecl | null {
  return load().templates.get(path) ?? null;
}

export function preludeLocalTemplates(): ReadonlyMap<string, FuncDecl> {
  return load().locals;
}

export function preludeDisplayName(decl: FuncDecl): string | null {
  return load().displayNames.get(decl) ?? null;
}

// True when declaring `name` would shadow a prelude namespace (ta).
export function isPreludeRoot(name: string): boolean {
  return load().roots.has(name);
}
