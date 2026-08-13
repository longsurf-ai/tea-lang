// Purpose: Lexical IR child traversal and single-write bind-known name discovery shared by the depth policy pass.

import {fatal} from '../base/print';
import {
  IrKind,
  PlaceKind,
  Storage,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../ir/node';
import type {IrFunc} from '../ir/program';
import {Qualifier, qualifierLE} from '../ir/type';
import {visitExprChildren, visitStmtChildren} from '../ir/visit';

export function immutableBindLocals(func: IrFunc): ReadonlySet<Name> {
  const writes = new Map<Name, number>();
  countWritesExpr(func.body, writes);
  return immutableBindNamesFromCounts(func.locals, writes);
}

export function immutableBindNames(
  names: readonly Name[],
  stmts: readonly IrStmt[],
): ReadonlySet<Name> {
  const writes = new Map<Name, number>();
  for (const stmt of stmts) {
    countWritesStmt(stmt, writes);
  }
  return immutableBindNamesFromCounts(names, writes);
}

function immutableBindNamesFromCounts(
  names: readonly Name[],
  writes: ReadonlyMap<Name, number>,
): ReadonlySet<Name> {
  return new Set(
    names.filter(
      name =>
        name.storage === Storage.PerBar &&
        qualifierLE(name.qualifier, Qualifier.Simple) &&
        writes.get(name) === 1,
    ),
  );
}

function countWritesStmt(stmt: IrStmt, writes: Map<Name, number>): void {
  if (stmt.kind === IrKind.WriteName) {
    writes.set(stmt.name, (writes.get(stmt.name) ?? 0) + 1);
  }
  if (stmt.kind === IrKind.UpdateValuePath) {
    const root = stmt.path.root;
    writes.set(root, (writes.get(root) ?? 0) + 1);
  }
  for (const child of stmtExprs(stmt)) {
    countWritesExpr(child, writes);
  }
}

function countWritesExpr(expr: IrExpr, writes: Map<Name, number>): void {
  if (
    expr.kind === IrKind.CallMutableMethod ||
    expr.kind === IrKind.MutateCollection
  ) {
    const root = expr.path.root;
    writes.set(root, (writes.get(root) ?? 0) + 1);
  }
  if (expr.kind === IrKind.BlockExpr) {
    for (const stmt of expr.stmts) {
      countWritesStmt(stmt, writes);
    }
    if (expr.value !== null) {
      countWritesExpr(expr.value, writes);
    }
    return;
  }
  for (const child of exprChildren(expr)) {
    countWritesExpr(child, writes);
  }
}

// Lexical expression children only: user calls expose their receiver (for a
// method) and explicit arguments, never their shared function body. The
// context-aware policy enters that body once per call site with a substituted
// environment.
export function exprChildren(
  expr: Exclude<IrExpr, {kind: typeof IrKind.BlockExpr}>,
): readonly IrExpr[] {
  const children: IrExpr[] = [];
  visitExprChildren(
    expr,
    child => children.push(child),
    stmt => fatal(`non-block expression exposed child statement ${stmt.kind}`),
  );
  if (expr.kind === IrKind.HistRead && expr.place.kind === PlaceKind.Request) {
    const edge = expr.place.request;
    children.push(
      edge.symbol,
      edge.timeframe,
      edge.merge.gaps,
      edge.merge.lookahead,
      edge.merge.ignoreInvalidSymbol,
      edge.merge.calcBarsCount,
    );
  }
  return children;
}

export function stmtExprs(stmt: IrStmt): readonly IrExpr[] {
  const children: IrExpr[] = [];
  visitStmtChildren(stmt, child => children.push(child));
  return children;
}
