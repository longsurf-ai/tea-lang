// Purpose: IR traversal and derived enumerations — Program declares its external needs (params, requests) and emissions (outputs); context-input usage, names, funcs, and slot counts are projections computed by walking, and requestsOf is how the noder fills the interface field.

import {fatal} from '../base/print';
import {
  CollectionLocationKind,
  DepthKind,
  IrKind,
  PlaceKind,
  type HistoryDepth,
  type HistReadExpr,
  type IrExpr,
  type IrStmt,
  type Name,
} from './node';
import {
  ParamDefaultKind,
  type BuiltinInput,
  type IrFunc,
  type Program,
  type RequestEdge,
  type SeriesInput,
} from './program';
import {Qualifier, qualifierLE} from './type';

// Canonical lexical child enumeration. This deliberately does not enter a
// called function body, a request child Program, or metadata such as a Name's
// depth; analyses that own those semantic edges add them explicitly.
export function visitStmtChildren(
  stmt: IrStmt,
  visitExprChild: (expr: IrExpr) => void,
): void {
  switch (stmt.kind) {
    case IrKind.ExprStmt:
      visitExprChild(stmt.x);
      return;
    case IrKind.InitName:
    case IrKind.WriteName:
      visitExprChild(stmt.value);
      return;
    case IrKind.StoreField:
      visitExprChild(stmt.object);
      visitExprChild(stmt.value);
      return;
    case IrKind.Emit:
      stmt.args.forEach(visitExprChild);
      return;
    case IrKind.EmitEffect:
      visitExprChild(stmt.payload);
      return;
    case IrKind.Break:
    case IrKind.Continue:
      return;
    default:
      return unreachableStmt(stmt);
  }
}

export function visitExprChildren(
  expr: IrExpr,
  visitExprChild: (expr: IrExpr) => void,
  visitStmtChild: (stmt: IrStmt) => void,
): void {
  switch (expr.kind) {
    case IrKind.Const:
    case IrKind.OutputRef:
      return;
    case IrKind.HistRead:
      if (expr.offset !== null) visitExprChild(expr.offset);
      return;
    case IrKind.Binary:
      visitExprChild(expr.x);
      visitExprChild(expr.y);
      return;
    case IrKind.Unary:
      visitExprChild(expr.x);
      return;
    case IrKind.Cond:
      visitExprChild(expr.cond);
      visitExprChild(expr.then);
      visitExprChild(expr.else);
      return;
    case IrKind.CallFunc:
    case IrKind.CallNative:
      expr.args.forEach(visitExprChild);
      return;
    case IrKind.CallConstMethod:
    case IrKind.CallMutableMethod:
      visitExprChild(expr.receiver);
      expr.args.forEach(visitExprChild);
      return;
    case IrKind.MutateCollection:
      if (expr.location.kind === CollectionLocationKind.StructField) {
        visitExprChild(expr.location.object);
      }
      expr.args.forEach(visitExprChild);
      return;
    case IrKind.NewStruct:
      expr.args.forEach(visitExprChild);
      return;
    case IrKind.MakeTuple:
      expr.elems.forEach(visitExprChild);
      return;
    case IrKind.TupleGet:
    case IrKind.FieldGet:
      visitExprChild(expr.x);
      return;
    case IrKind.IfExpr:
      visitExprChild(expr.cond);
      visitExprChild(expr.then);
      if (expr.else !== null) visitExprChild(expr.else);
      return;
    case IrKind.SwitchExpr:
      if (expr.subject !== null) visitExprChild(expr.subject);
      expr.arms.forEach(arm => {
        if (arm.pattern !== null) visitExprChild(arm.pattern);
        visitExprChild(arm.body);
      });
      return;
    case IrKind.ForExpr:
      visitExprChild(expr.from);
      visitExprChild(expr.to);
      if (expr.step !== null) visitExprChild(expr.step);
      visitExprChild(expr.body);
      return;
    case IrKind.ForInExpr:
      visitExprChild(expr.x);
      visitExprChild(expr.body);
      return;
    case IrKind.WhileExpr:
      visitExprChild(expr.cond);
      visitExprChild(expr.body);
      return;
    case IrKind.BlockExpr:
      expr.stmts.forEach(visitStmtChild);
      if (expr.value !== null) visitExprChild(expr.value);
      return;
    default:
      return unreachableExpr(expr);
  }
}

export interface IrVisitor {
  readonly expr?: (expr: IrExpr) => void;
  readonly stmt?: (stmt: IrStmt) => void;
}

export function walkIrStmt(stmt: IrStmt, visitor: IrVisitor): void {
  visitor.stmt?.(stmt);
  visitStmtChildren(stmt, expr => walkIrExpr(expr, visitor));
}

export function walkIrExpr(expr: IrExpr, visitor: IrVisitor): void {
  visitor.expr?.(expr);
  visitExprChildren(
    expr,
    child => walkIrExpr(child, visitor),
    stmt => walkIrStmt(stmt, visitor),
  );
}

// One traversal, deterministic first-reachable order. Visited sets make
// shared declaration objects (Names, funcs, edges) count once; request
// children are separate Programs and are NOT entered — enumerate them with
// their own walk.
interface Reach {
  readonly names: Set<Name>;
  readonly funcs: Set<IrFunc>;
  readonly requests: Set<RequestEdge>;
  readonly series: Set<SeriesInput>;
  readonly builtin: Set<BuiltinInput>;
  readonly reads: HistReadExpr[];
  maxSlot: number;
}

function reachProgram(program: Program): Reach {
  const reach: Reach = {
    names: new Set(),
    funcs: new Set(),
    requests: new Set(),
    series: new Set(),
    builtin: new Set(),
    reads: [],
    maxSlot: -1,
  };
  for (const global of program.packageGlobals) {
    noteName(global, reach);
  }
  for (const param of program.params) {
    if (param.defaultValue?.kind === ParamDefaultKind.Series) {
      reach.series.add(param.defaultValue.series);
    }
    visitDepth(param.depth, reach);
    visitExpr(param.active, reach);
  }
  for (const output of program.outputs) {
    for (const arg of output.bindArgs) {
      visitExpr(arg.expr, reach);
    }
  }
  for (const stmt of program.init) {
    visitStmt(stmt, reach);
  }
  for (const stmt of program.body) {
    visitStmt(stmt, reach);
  }
  return reach;
}

function noteName(name: Name, reach: Reach): void {
  if (reach.names.has(name)) {
    return;
  }
  reach.names.add(name);
  visitDepth(name.depth, reach);
}

function noteFunc(func: IrFunc, reach: Reach): void {
  if (reach.funcs.has(func)) {
    return;
  }
  reach.funcs.add(func);
  if (func.callMode !== 'free') {
    noteName(func.receiver, reach);
  }
  for (const name of [...func.params, ...func.locals]) {
    noteName(name, reach);
  }
  visitExpr(func.body, reach);
}

function noteRequest(request: RequestEdge, reach: Reach): void {
  if (reach.requests.has(request)) {
    return;
  }
  reach.requests.add(request);
  visitExpr(request.symbol, reach);
  visitExpr(request.timeframe, reach);
  for (const option of [
    request.merge.availability,
    request.merge.fill,
    request.merge.ignoreInvalidSymbol,
    request.merge.calcBarsCount,
  ]) {
    visitExpr(option, reach);
  }
  visitDepth(request.depth, reach);
  // request.resultName and request.child belong to the child Program.
}

function visitDepth(depth: HistoryDepth, reach: Reach): void {
  if (depth.kind === DepthKind.Bound) {
    visitExpr(depth.expr, reach);
  } else if (depth.kind === DepthKind.Capped) {
    visitExpr(depth.bars, reach);
  }
}

function visitStmt(stmt: IrStmt, reach: Reach): void {
  if (stmt.kind === IrKind.InitName || stmt.kind === IrKind.WriteName) {
    noteName(stmt.name, reach);
  }
  visitStmtChildren(stmt, child => visitExpr(child, reach));
}

function visitExpr(expr: IrExpr, reach: Reach): void {
  if (expr.kind === IrKind.HistRead) {
    reach.reads.push(expr);
    const place = expr.place;
    if (place.kind === PlaceKind.Name) {
      noteName(place.name, reach);
    } else if (place.kind === PlaceKind.Series) {
      visitSeries(place.series, reach);
    } else if (place.kind === PlaceKind.Builtin) {
      visitBuiltin(place.builtin, reach);
    } else if (place.kind === PlaceKind.Request) {
      noteRequest(place.request, reach);
    }
  } else if (
    expr.kind === IrKind.CallFunc ||
    expr.kind === IrKind.CallConstMethod ||
    expr.kind === IrKind.CallMutableMethod
  ) {
    noteFunc(expr.func, reach);
    reach.maxSlot = Math.max(reach.maxSlot, expr.slot);
  } else if (expr.kind === IrKind.CallNative && expr.slot !== null) {
    reach.maxSlot = Math.max(reach.maxSlot, expr.slot);
  } else if (expr.kind === IrKind.MutateCollection) {
    if (expr.location.kind === CollectionLocationKind.Name) {
      noteName(expr.location.name, reach);
    }
  } else if (expr.kind === IrKind.ForExpr) {
    noteName(expr.index, reach);
  } else if (expr.kind === IrKind.ForInExpr) {
    expr.targets.forEach(target => noteName(target, reach));
  }
  visitExprChildren(
    expr,
    child => visitExpr(child, reach),
    stmt => visitStmt(stmt, reach),
  );
}

function visitSeries(series: SeriesInput, reach: Reach): void {
  if (reach.series.has(series)) {
    return;
  }
  reach.series.add(series);
  visitDepth(series.depth, reach);
}

function visitBuiltin(builtin: BuiltinInput, reach: Reach): void {
  if (reach.builtin.has(builtin)) {
    return;
  }
  reach.builtin.add(builtin);
  visitDepth(builtin.depth, reach);
}

// Whether an expression can evaluate without any frame: only constants,
// scalar param reads, and pure combinations qualify. This is the strict
// subset used when no owner-proven root bind frame is available.
export function bindEvaluable(e: IrExpr): boolean {
  switch (e.kind) {
    case IrKind.Const:
      return true;
    case IrKind.HistRead:
      // Source params are excluded: their reads are series (a bound host
      // series), not bind-time scalars, and would lower to ctx.series. A typed
      // A builtin is bind-visible only when its Tea qualifier is no later
      // than simple; row-varying builtins remain per-row reads.
      return (
        e.offset === null &&
        ((e.place.kind === PlaceKind.Param &&
          e.place.param.defaultValue?.kind !== ParamDefaultKind.Series) ||
          (e.place.kind === PlaceKind.Builtin &&
            qualifierLE(e.qualifier, Qualifier.Simple)))
      );
    case IrKind.Binary:
      return bindEvaluable(e.x) && bindEvaluable(e.y);
    case IrKind.Unary:
      return bindEvaluable(e.x);
    case IrKind.Cond:
      return (
        bindEvaluable(e.cond) && bindEvaluable(e.then) && bindEvaluable(e.else)
      );
    case IrKind.CallNative:
      return e.args.every(bindEvaluable);
    default:
      return false;
  }
}

// Adding an IrKind without extending the walker fails to compile here.
function unreachableExpr(expr: never): never {
  return fatal(`unhandled IR expression: ${JSON.stringify(expr)}`);
}

function unreachableStmt(stmt: never): never {
  return fatal(`unhandled IR statement: ${JSON.stringify(stmt)}`);
}

// ---- derived enumerations ---------------------------------------------------

export function namesOf(program: Program): readonly Name[] {
  return [...reachProgram(program).names];
}

export function funcsOf(program: Program): readonly IrFunc[] {
  return [...reachProgram(program).funcs];
}

export function requestsOf(program: Program): readonly RequestEdge[] {
  return [...reachProgram(program).requests];
}

export function seriesInputsOf(program: Program): readonly SeriesInput[] {
  return [...reachProgram(program).series];
}

export function builtinInputsOf(program: Program): readonly BuiltinInput[] {
  return [...reachProgram(program).builtin];
}

export function slotCountOf(program: Program): number {
  return reachProgram(program).maxSlot + 1;
}

// Every HistRead in the program, in traversal order — the depth pass's
// input: each read's place accumulates the history the offsets demand.
export function histReadsOf(program: Program): readonly HistReadExpr[] {
  return reachProgram(program).reads;
}
