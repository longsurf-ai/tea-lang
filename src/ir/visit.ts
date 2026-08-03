// Purpose: IR traversal and derived enumerations — Program declares its external needs (params, requests) and emissions (outputs); ambient series usage, names, funcs, and slot counts are projections computed by walking, and requestsOf is how the noder fills the interface field.

import {fatal} from '../base/print';
import {
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
  type IrFunc,
  type Program,
  type RequestEdge,
  type SeriesInput,
} from './program';

// One traversal, deterministic first-reachable order. Visited sets make
// shared declaration objects (Names, funcs, edges) count once; request
// children are separate Programs and are NOT entered — enumerate them with
// their own walk.
interface Reach {
  readonly names: Set<Name>;
  readonly funcs: Set<IrFunc>;
  readonly requests: Set<RequestEdge>;
  readonly series: Set<SeriesInput>;
  readonly reads: HistReadExpr[];
  maxSlot: number;
}

function reachProgram(program: Program): Reach {
  const reach: Reach = {
    names: new Set(),
    funcs: new Set(),
    requests: new Set(),
    series: new Set(),
    reads: [],
    maxSlot: -1,
  };
  for (const param of program.params) {
    if (param.defaultValue?.kind === ParamDefaultKind.Series) {
      reach.series.add(param.defaultValue.series);
    }
    visitDepth(param.depth, reach);
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
  if (name.init !== null) {
    visitExpr(name.init, reach);
  }
  visitDepth(name.depth, reach);
}

function noteFunc(func: IrFunc, reach: Reach): void {
  if (reach.funcs.has(func)) {
    return;
  }
  reach.funcs.add(func);
  for (const param of func.params) {
    noteName(param, reach);
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
  if (request.merge.calcBarsCount !== null) {
    visitExpr(request.merge.calcBarsCount, reach);
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
  switch (stmt.kind) {
    case IrKind.ExprStmt:
      visitExpr(stmt.x, reach);
      return;
    case IrKind.WriteName:
      noteName(stmt.name, reach);
      visitExpr(stmt.value, reach);
      return;
    case IrKind.WriteField:
      visitExpr(stmt.x, reach);
      visitExpr(stmt.value, reach);
      return;
    case IrKind.Emit:
      for (const arg of stmt.args) {
        visitExpr(arg, reach);
      }
      return;
    case IrKind.Break:
    case IrKind.Continue:
      return;
    default:
      return unreachableStmt(stmt);
  }
}

function visitExpr(expr: IrExpr, reach: Reach): void {
  switch (expr.kind) {
    case IrKind.Const:
    case IrKind.OutputRef:
      // Output declarations live on Program.outputs; a ref has no children.
      return;
    case IrKind.HistRead: {
      reach.reads.push(expr);
      const place = expr.place;
      if (place.kind === PlaceKind.Name) {
        noteName(place.name, reach);
      } else if (place.kind === PlaceKind.Series) {
        visitSeries(place.series, reach);
      } else if (place.kind === PlaceKind.Request) {
        noteRequest(place.request, reach);
      }
      // params are host-contract declarations already listed on the Program
      if (expr.offset !== null) {
        visitExpr(expr.offset, reach);
      }
      return;
    }
    case IrKind.Binary:
      visitExpr(expr.x, reach);
      visitExpr(expr.y, reach);
      return;
    case IrKind.Unary:
      visitExpr(expr.x, reach);
      return;
    case IrKind.Cond:
      visitExpr(expr.cond, reach);
      visitExpr(expr.then, reach);
      visitExpr(expr.else, reach);
      return;
    case IrKind.CallFunc:
      noteFunc(expr.func, reach);
      reach.maxSlot = Math.max(reach.maxSlot, expr.slot);
      for (const arg of expr.args) {
        visitExpr(arg, reach);
      }
      return;
    case IrKind.CallNative:
      if (expr.slot !== null) {
        reach.maxSlot = Math.max(reach.maxSlot, expr.slot);
      }
      for (const arg of expr.args) {
        visitExpr(arg, reach);
      }
      return;
    case IrKind.NewUdt:
    case IrKind.MakeTuple:
      for (const arg of expr.kind === IrKind.NewUdt ? expr.args : expr.elems) {
        visitExpr(arg, reach);
      }
      return;
    case IrKind.TupleGet:
    case IrKind.FieldGet:
      visitExpr(expr.x, reach);
      return;
    case IrKind.IfExpr:
      visitExpr(expr.cond, reach);
      visitExpr(expr.then, reach);
      if (expr.else !== null) {
        visitExpr(expr.else, reach);
      }
      return;
    case IrKind.SwitchExpr:
      if (expr.subject !== null) {
        visitExpr(expr.subject, reach);
      }
      for (const arm of expr.arms) {
        if (arm.pattern !== null) {
          visitExpr(arm.pattern, reach);
        }
        visitExpr(arm.body, reach);
      }
      return;
    case IrKind.ForExpr:
      noteName(expr.index, reach);
      visitExpr(expr.from, reach);
      visitExpr(expr.to, reach);
      if (expr.step !== null) {
        visitExpr(expr.step, reach);
      }
      visitExpr(expr.body, reach);
      return;
    case IrKind.ForInExpr:
      for (const target of expr.targets) {
        noteName(target, reach);
      }
      visitExpr(expr.x, reach);
      visitExpr(expr.body, reach);
      return;
    case IrKind.WhileExpr:
      visitExpr(expr.cond, reach);
      visitExpr(expr.body, reach);
      return;
    case IrKind.BlockExpr:
      for (const stmt of expr.stmts) {
        visitStmt(stmt, reach);
      }
      if (expr.value !== null) {
        visitExpr(expr.value, reach);
      }
      return;
    default:
      return unreachableExpr(expr);
  }
}

function visitSeries(series: SeriesInput, reach: Reach): void {
  if (reach.series.has(series)) {
    return;
  }
  reach.series.add(series);
  visitDepth(series.depth, reach);
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

export function slotCountOf(program: Program): number {
  return reachProgram(program).maxSlot + 1;
}

// Every HistRead in the program, in traversal order — the depth pass's
// input: each read's place accumulates the history the offsets demand.
export function histReadsOf(program: Program): readonly HistReadExpr[] {
  return reachProgram(program).reads;
}
