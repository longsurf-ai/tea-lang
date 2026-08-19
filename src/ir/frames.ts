// Purpose: Target-neutral frame ownership and static call-site topology derived from one Program.

import {fatal} from '../base/print';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  type HistoryDepth,
  type IrExpr,
  type IrStmt,
  type Name,
} from './node';
import type {IrFunc, Program, RequestEdge} from './program';
import {
  builtinInputsOf,
  funcsOf,
  namesOf,
  requestsOf,
  seriesInputsOf,
  walkIrExpr,
  walkIrStmt,
} from './visit';

export interface FrameChild {
  readonly slot: number;
  readonly callee: IrFunc;
  readonly frameId: number;
}

export interface FrameTemplate {
  readonly id: number;
  readonly owner: IrFunc | null;
  readonly locals: readonly Name[];
  readonly children: readonly FrameChild[];
}

export interface FrameNameLocation {
  readonly frameId: number;
  readonly slot: number;
}

export interface FrameTopology {
  readonly frames: readonly FrameTemplate[];
  readonly root: FrameTemplate;
  readonly frameByFunc: ReadonlyMap<IrFunc, FrameTemplate>;
  readonly nameLocations: ReadonlyMap<Name, FrameNameLocation>;
}

export function frameTopologyOf(program: Program): FrameTopology {
  const funcs = funcsOf(program);
  const names = namesOf(program);
  const frameIdByFunc = new Map<IrFunc, number>();
  funcs.forEach((func, index) => frameIdByFunc.set(func, index + 1));

  const functionNames = new Set<Name>();
  const localsByOwner = new Map<IrFunc | null, readonly Name[]>();
  for (const func of funcs) {
    const receiver = func.callMode === 'free' ? [] : [func.receiver];
    if (
      func.callMode !== 'free' &&
      (func.params.includes(func.receiver) ||
        func.locals.includes(func.receiver))
    ) {
      return fatal(
        `method '${func.name}' hidden receiver also appears in explicit params or locals`,
      );
    }
    const locals = [...receiver, ...func.params, ...func.locals];
    locals.forEach(name => functionNames.add(name));
    localsByOwner.set(func, locals);
  }

  const packageGlobals = new Set(program.packageGlobals);
  localsByOwner.set(null, [
    ...program.packageGlobals,
    ...names.filter(
      name => !functionNames.has(name) && !packageGlobals.has(name),
    ),
  ]);

  const childrenByOwner = new Map<IrFunc | null, readonly FrameChild[]>();
  for (const owner of [null, ...funcs]) {
    const children = new Map<number, IrFunc>();
    const noteCall = (expr: IrExpr): void => {
      if (
        expr.kind !== IrKind.CallFunc &&
        expr.kind !== IrKind.CallConstMethod &&
        expr.kind !== IrKind.CallMutableMethod
      ) {
        return;
      }
      const existing = children.get(expr.slot);
      if (existing !== undefined && existing !== expr.func) {
        return fatal(`frame slot ${expr.slot} has two callees`);
      }
      children.set(expr.slot, expr.func);
    };
    if (owner === null) {
      walkRootFrame(program, names, noteCall);
    } else {
      walkFrameExpr(owner.body, noteCall);
    }
    childrenByOwner.set(
      owner,
      [...children]
        .sort(([left], [right]) => left - right)
        .map(([slot, callee]) => {
          const frameId = frameIdByFunc.get(callee);
          if (frameId === undefined) {
            return fatal(
              `call site reaches unmapped function '${callee.name}'`,
            );
          }
          return {slot, callee, frameId};
        }),
    );
  }

  const frames: FrameTemplate[] = [null, ...funcs].map((owner, id) => ({
    id,
    owner,
    locals: localsByOwner.get(owner) ?? fatal(`missing locals for frame ${id}`),
    children:
      childrenByOwner.get(owner) ?? fatal(`missing children for frame ${id}`),
  }));
  const root = frames[0] ?? fatal('Program has no root frame');
  const frameByFunc = new Map<IrFunc, FrameTemplate>();
  funcs.forEach((func, index) => {
    frameByFunc.set(
      func,
      frames[index + 1] ?? fatal(`missing frame for function '${func.name}'`),
    );
  });
  const nameLocations = new Map<Name, FrameNameLocation>();
  frames.forEach(frame => {
    frame.locals.forEach((name, slot) => {
      if (nameLocations.has(name)) {
        return fatal(`name '${name.name}' belongs to two frames`);
      }
      nameLocations.set(name, {frameId: frame.id, slot});
    });
  });
  return {frames, root, frameByFunc, nameLocations};
}

// The root frame serves both module.bind and the per-row body. Keep all
// executable Program-owned expressions here so a bind-only call site (for
// example input.active, an output bind argument, or a bound history depth)
// receives the same static child-frame identity as a body call.
function walkRootFrame(
  program: Program,
  names: readonly Name[],
  visitExpr: (expr: IrExpr) => void,
): void {
  const walkExpr = (expr: IrExpr): void => walkFrameExpr(expr, visitExpr);
  const walkDepth = (depth: HistoryDepth): void => {
    if (depth.kind === DepthKind.Bound) {
      walkExpr(depth.expr);
    } else if (depth.kind === DepthKind.Capped) {
      walkExpr(depth.bars);
    }
  };

  program.init.forEach(stmt => walkFrameStmt(stmt, visitExpr));
  program.body.forEach(stmt => walkFrameStmt(stmt, visitExpr));
  program.params.forEach(param => {
    walkExpr(param.active);
    walkDepth(param.depth);
  });
  program.outputs.forEach(output =>
    output.bindArgs.forEach(arg => walkExpr(arg.expr)),
  );
  names.forEach(name => walkDepth(name.depth));
  seriesInputsOf(program).forEach(series => walkDepth(series.depth));
  builtinInputsOf(program).forEach(builtin => walkDepth(builtin.depth));
  requestsOf(program).forEach(request => {
    // Static contexts are captured by module.bind in the root frame. Dynamic
    // contexts execute at their lexical HistRead site and are expanded by
    // walkFrameExpr under that site's owner instead.
    if (!request.dynamic) {
      walkExpr(request.symbol);
      walkExpr(request.timeframe);
    }
    walkExpr(request.merge.gaps);
    walkExpr(request.merge.lookahead);
    walkExpr(request.merge.ignoreInvalidSymbol);
    walkExpr(request.merge.calcBarsCount);
    walkDepth(request.depth);
  });
}

function walkFrameStmt(
  stmt: IrStmt,
  visitExpr: (expr: IrExpr) => void,
): void {
  const activeRequests = new Set<RequestEdge>();
  walkIrStmt(stmt, {
    expr: expr => visitFrameExpr(expr, visitExpr, activeRequests),
  });
}

function walkFrameExpr(expr: IrExpr, visitExpr: (expr: IrExpr) => void): void {
  const activeRequests = new Set<RequestEdge>();
  walkIrExpr(expr, {
    expr: nested => visitFrameExpr(nested, visitExpr, activeRequests),
  });
}

function visitFrameExpr(
  expr: IrExpr,
  visitExpr: (expr: IrExpr) => void,
  activeRequests: Set<RequestEdge>,
): void {
  visitExpr(expr);
  if (
    expr.kind !== IrKind.HistRead ||
    expr.offset !== null ||
    expr.place.kind !== PlaceKind.Request ||
    !expr.place.request.dynamic
  ) {
    return;
  }
  const request = expr.place.request;
  if (activeRequests.has(request)) {
    return fatal('dynamic request context recursively reaches itself');
  }
  activeRequests.add(request);
  try {
    walkIrExpr(request.symbol, {
      expr: nested => visitFrameExpr(nested, visitExpr, activeRequests),
    });
    walkIrExpr(request.timeframe, {
      expr: nested => visitFrameExpr(nested, visitExpr, activeRequests),
    });
  } finally {
    activeRequests.delete(request);
  }
}
