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
  switch (expr.kind) {
    case IrKind.Const:
    case IrKind.OutputRef:
      return [];
    case IrKind.HistRead: {
      const children = expr.offset === null ? [] : [expr.offset];
      if (expr.place.kind !== PlaceKind.Request) {
        return children;
      }
      const edge = expr.place.request;
      return [
        ...children,
        edge.symbol,
        edge.timeframe,
        edge.merge.gaps,
        edge.merge.lookahead,
        edge.merge.ignoreInvalidSymbol,
        edge.merge.calcBarsCount,
      ];
    }
    case IrKind.Binary:
      return [expr.x, expr.y];
    case IrKind.Unary:
      return [expr.x];
    case IrKind.Cond:
      return [expr.cond, expr.then, expr.else];
    case IrKind.CallFunc:
    case IrKind.CallNative:
      return expr.args;
    case IrKind.CallConstMethod:
    case IrKind.CallMutableMethod:
    case IrKind.MutateCollection:
      return [expr.receiver, ...expr.args];
    case IrKind.NewUserValue:
      return expr.args;
    case IrKind.MakeTuple:
      return expr.elems;
    case IrKind.TupleGet:
    case IrKind.FieldGet:
      return [expr.x];
    case IrKind.IfExpr:
      return [expr.cond, expr.then, ...(expr.else === null ? [] : [expr.else])];
    case IrKind.SwitchExpr:
      return [
        ...(expr.subject === null ? [] : [expr.subject]),
        ...expr.arms.flatMap(arm =>
          arm.pattern === null ? [arm.body] : [arm.pattern, arm.body],
        ),
      ];
    case IrKind.ForExpr:
      return [
        expr.from,
        expr.to,
        ...(expr.step === null ? [] : [expr.step]),
        expr.body,
      ];
    case IrKind.ForInExpr:
      return [expr.x, expr.body];
    case IrKind.WhileExpr:
      return [expr.cond, expr.body];
    default:
      return unreachableExpr(expr);
  }
}

export function stmtExprs(stmt: IrStmt): readonly IrExpr[] {
  switch (stmt.kind) {
    case IrKind.ExprStmt:
      return [stmt.x];
    case IrKind.WriteName:
      return [stmt.value];
    case IrKind.UpdateValuePath:
      return [stmt.value];
    case IrKind.Emit:
      return stmt.args;
    case IrKind.EmitEffect:
      return [stmt.payload];
    case IrKind.Break:
    case IrKind.Continue:
      return [];
    default:
      return unreachableStmt(stmt);
  }
}

function unreachableExpr(expr: never): never {
  return fatal(`unhandled depth-walk expression: ${JSON.stringify(expr)}`);
}

function unreachableStmt(stmt: never): never {
  return fatal(`unhandled depth-walk statement: ${JSON.stringify(stmt)}`);
}
