// Purpose: Depth resolution pass — walks history demands in call-site context and annotates each place so the runtime can size every buffer at bind time.

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
} from '../ir/node';
import {ParamDefaultKind, type IrFunc, type Program} from '../ir/program';
import {IntType, Qualifier, joinQualifiers, qualifierLE} from '../ir/type';
import {funcsOf, namesOf, walkIrExpr} from '../ir/visit';
import {
  exprChildren,
  immutableBindLocals,
  immutableBindNames,
  stmtExprs,
} from './depth-walk';

// The engine default for dynamic offsets without an explicit declaration cap
// (Pine's max_bars_back default).
export const DEFAULT_MAX_BARS_BACK = 500;

interface DepthCarrier {
  depth: HistoryDepth;
}

interface Demand {
  maxConst: number;
  bound: IrExpr[];
  dynamicCap: number | null;
  pos: HistReadExpr['pos'];
}

interface Normalized {
  readonly expr: IrExpr;
  // True only when this expression retains valid root-frame ownership after
  // function parameters and locals have been substituted.
  readonly rootSafe: boolean;
}

interface WalkContext {
  readonly env: Map<Name, Normalized>;
  // Exact induction-variable reads may use the bind-normalized range maximum.
  // More complex expressions stay dynamic until an interval pass can prove a
  // safe maximum; substituting the endpoint through arbitrary arithmetic can
  // under-estimate decreasing expressions.
  readonly induction: ReadonlyMap<Name, Normalized>;
  readonly immutable: ReadonlySet<Name>;
  readonly immutableByFunc: ReadonlyMap<IrFunc, ReadonlySet<Name>>;
  readonly scope: 'root' | 'function';
  readonly active: Set<IrFunc>;
}

// Bind-known demands (input or root-safe simple) are evaluated exactly at
// bind. Function-local parameters and immutable aliases are substituted with
// the root call-site arguments that feed them, so one IR function called with
// multiple bind-known values contributes one max expression. Any demand that
// still depends on per-bar state remains capped.
export function resolveDepths(program: Program): void {
  const demands = new Map<DepthCarrier, Demand>();
  collectDemands(program, demands, new Set());
  for (const [carrier, demand] of demands) {
    carrier.depth = finalize(demand);
  }
}

// Request children may share compilation-global ParamInputs with the root and
// sibling Programs. Accumulate the entire Program tree before annotating any
// carrier so a later Program cannot overwrite an earlier, deeper demand.
function collectDemands(
  program: Program,
  demands: Map<DepthCarrier, Demand>,
  visited: Set<Program>,
): void {
  if (visited.has(program)) {
    return;
  }
  visited.add(program);
  const cap = declarationCap(program);
  const funcs = funcsOf(program);
  const names = namesOf(program);
  const functionNames = new Set(
    funcs.flatMap(func => [
      ...(func.callMode === 'free' ? [] : [func.receiver]),
      ...func.params,
      ...func.locals,
    ]),
  );
  const rootNames = names.filter(name => !functionNames.has(name));
  const immutableByFunc = new Map(
    funcs.map(func => [func, immutableBindLocals(func)] as const),
  );
  const rootImmutable = immutableBindNames(rootNames, [
    ...program.init,
    ...program.body,
  ]);

  const note = (read: HistReadExpr, ctx: WalkContext): void => {
    if (read.offset === null) {
      return;
    }
    const carrier = carrierOf(read);
    let demand = demands.get(carrier);
    if (demand === undefined) {
      demand = {maxConst: 0, bound: [], dynamicCap: null, pos: read.pos};
      demands.set(carrier, demand);
    }
    const offset = read.offset;
    if (offset.kind === IrKind.Const && typeof offset.value === 'number') {
      if (Number.isSafeInteger(offset.value) && offset.value >= 0) {
        demand.maxConst = Math.max(demand.maxConst, offset.value);
      }
      return;
    }
    const induction =
      offset.kind === IrKind.HistRead &&
      offset.offset === null &&
      offset.place.kind === PlaceKind.Name
        ? ctx.induction.get(offset.place.name)
        : undefined;
    const normalized = induction ?? normalize(offset, ctx, functionNames);
    if (
      qualifierLE(normalized.expr.qualifier, Qualifier.Simple) &&
      normalized.rootSafe
    ) {
      demand.bound.push(normalized.expr);
      return;
    }
    demand.dynamicCap = Math.max(demand.dynamicCap ?? 0, cap);
  };

  const walkStmt = (stmt: IrStmt, ctx: WalkContext): void => {
    for (const expr of stmtExprs(stmt)) {
      walkExpr(expr, ctx);
    }
    if (stmt.kind === IrKind.WriteName && ctx.immutable.has(stmt.name)) {
      ctx.env.set(stmt.name, normalize(stmt.value, ctx, functionNames));
    }
  };

  const walkBlock = (
    stmts: readonly IrStmt[],
    value: IrExpr | null,
    ctx: WalkContext,
  ): void => {
    const block = {...ctx, env: new Map(ctx.env)};
    for (const stmt of stmts) {
      walkStmt(stmt, block);
    }
    if (value !== null) {
      walkExpr(value, block);
    }
  };

  const walkCall = (
    expr: Extract<
      IrExpr,
      {
        kind:
          | typeof IrKind.CallFunc
          | typeof IrKind.CallConstMethod
          | typeof IrKind.CallMutableMethod;
      }
    >,
    ctx: WalkContext,
  ): void => {
    const args =
      expr.kind === IrKind.CallFunc ? expr.args : [expr.receiver, ...expr.args];
    for (const arg of args) {
      walkExpr(arg, ctx);
    }
    if (ctx.active.has(expr.func)) {
      return fatal(`recursive function '${expr.func.name}' reached depth pass`);
    }
    const env = new Map<Name, Normalized>();
    const params =
      expr.func.callMode === 'free'
        ? expr.func.params
        : [expr.func.receiver, ...expr.func.params];
    params.forEach((param, index) => {
      const arg = args[index];
      if (arg === undefined) {
        return fatal(
          `call to '${expr.func.name}' is missing argument ${index}`,
        );
      }
      env.set(param, normalize(arg, ctx, functionNames));
    });
    const active = new Set(ctx.active);
    active.add(expr.func);
    const callee: WalkContext = {
      env,
      induction: new Map(),
      immutable: immutableByFunc.get(expr.func) ?? new Set<Name>(),
      immutableByFunc,
      scope: 'function',
      active,
    };
    walkExpr(expr.func.body, callee);
  };

  function walkExpr(expr: IrExpr, ctx: WalkContext): void {
    if (expr.kind === IrKind.HistRead) {
      note(expr, ctx);
    }
    if (
      expr.kind === IrKind.CallFunc ||
      expr.kind === IrKind.CallConstMethod ||
      expr.kind === IrKind.CallMutableMethod
    ) {
      walkCall(expr, ctx);
      return;
    }
    if (expr.kind === IrKind.BlockExpr) {
      walkBlock(expr.stmts, expr.value, ctx);
      return;
    }
    if (expr.kind === IrKind.ForExpr) {
      walkExpr(expr.from, ctx);
      walkExpr(expr.to, ctx);
      if (expr.step !== null) walkExpr(expr.step, ctx);
      const from = normalize(expr.from, ctx, functionNames);
      const to = normalize(expr.to, ctx, functionNames);
      let maximum: Normalized;
      const step = expr.step;
      if (
        step === null ||
        (step.kind === IrKind.Const &&
          typeof step.value === 'number' &&
          step.value > 0)
      ) {
        maximum = to;
      } else if (
        step.kind === IrKind.Const &&
        typeof step.value === 'number' &&
        step.value < 0
      ) {
        maximum = from;
      } else {
        const args = [from.expr, to.expr];
        maximum = {
          expr: {
            kind: IrKind.CallNative,
            pos: expr.pos,
            type: IntType,
            qualifier: joinQualifiers(from.expr.qualifier, to.expr.qualifier),
            native: 'math.max',
            slot: null,
            args,
            argumentEvaluationOrder: [0, 1],
          },
          rootSafe: from.rootSafe && to.rootSafe,
        };
      }
      const induction = new Map(ctx.induction);
      let indexReassigned = false;
      walkIrExpr(expr.body, {
        stmt: stmt => {
          if (stmt.kind === IrKind.WriteName && stmt.name === expr.index) {
            indexReassigned = true;
          }
        },
      });
      if (!indexReassigned) {
        induction.set(expr.index, maximum);
      }
      const loop = {...ctx, env: new Map(ctx.env), induction};
      walkBlock(expr.body.stmts, expr.body.value, loop);
      return;
    }
    for (const child of exprChildren(expr)) {
      walkExpr(child, ctx);
    }
  }

  const root: WalkContext = {
    env: new Map(),
    induction: new Map(),
    immutable: rootImmutable,
    immutableByFunc,
    scope: 'root',
    active: new Set(),
  };
  for (const param of program.params) {
    walkExpr(param.active, root);
  }
  for (const output of program.outputs) {
    for (const arg of output.bindArgs) {
      walkExpr(arg.expr, root);
    }
  }
  for (const stmt of [...program.init, ...program.body]) {
    walkStmt(stmt, root);
  }
  for (const request of program.requests) {
    collectDemands(request.child, demands, visited);
  }
}

function normalize(
  expr: IrExpr,
  ctx: WalkContext,
  functionNames: ReadonlySet<Name>,
): Normalized {
  switch (expr.kind) {
    case IrKind.Const:
      return {expr, rootSafe: true};
    case IrKind.HistRead: {
      if (expr.offset === null && expr.place.kind === PlaceKind.Name) {
        const bound = ctx.env.get(expr.place.name);
        if (bound !== undefined) {
          return bound;
        }
        return {
          expr,
          rootSafe:
            !functionNames.has(expr.place.name) &&
            qualifierLE(expr.place.name.qualifier, Qualifier.Simple),
        };
      }
      return {
        expr,
        rootSafe:
          expr.offset === null &&
          ((expr.place.kind === PlaceKind.Param &&
            expr.place.param.defaultValue?.kind !== ParamDefaultKind.Series) ||
            (expr.place.kind === PlaceKind.Builtin &&
              qualifierLE(expr.qualifier, Qualifier.Simple))),
      };
    }
    case IrKind.Binary: {
      const x = normalize(expr.x, ctx, functionNames);
      const y = normalize(expr.y, ctx, functionNames);
      return {
        expr: {...expr, x: x.expr, y: y.expr},
        rootSafe: x.rootSafe && y.rootSafe,
      };
    }
    case IrKind.Unary: {
      const x = normalize(expr.x, ctx, functionNames);
      return {expr: {...expr, x: x.expr}, rootSafe: x.rootSafe};
    }
    case IrKind.Cond: {
      const cond = normalize(expr.cond, ctx, functionNames);
      const then = normalize(expr.then, ctx, functionNames);
      const otherwise = normalize(expr.else, ctx, functionNames);
      return {
        expr: {
          ...expr,
          cond: cond.expr,
          then: then.expr,
          else: otherwise.expr,
        },
        rootSafe: cond.rootSafe && then.rootSafe && otherwise.rootSafe,
      };
    }
    case IrKind.CallNative: {
      const args = expr.args.map(arg => normalize(arg, ctx, functionNames));
      return {
        expr: {...expr, args: args.map(arg => arg.expr)},
        rootSafe: args.every(arg => arg.rootSafe),
      };
    }
    case IrKind.CallFunc: {
      const args = expr.args.map(arg => normalize(arg, ctx, functionNames));
      if (ctx.scope === 'function') {
        return normalizeFunctionCall(expr, args, ctx, functionNames);
      }
      return {
        expr: {...expr, args: args.map(arg => arg.expr)},
        rootSafe: args.every(arg => arg.rootSafe),
      };
    }
    case IrKind.CallConstMethod: {
      const receiver = normalize(expr.receiver, ctx, functionNames);
      const args = expr.args.map(arg => normalize(arg, ctx, functionNames));
      const operands = [receiver, ...args];
      if (ctx.scope === 'function') {
        return normalizeFunctionCall(expr, operands, ctx, functionNames);
      }
      return {
        expr: {
          ...expr,
          receiver: receiver.expr,
          args: args.map(arg => arg.expr),
        },
        rootSafe: operands.every(arg => arg.rootSafe),
      };
    }
    case IrKind.CallMutableMethod:
      // A mutable method writes a root and cannot participate in a bind-time
      // history-depth expression. Its body is still entered by walkExpr so
      // history demands inside the method are collected.
      return {expr, rootSafe: false};
    case IrKind.OutputRef:
    case IrKind.MutateCollection:
    case IrKind.NewStruct:
    case IrKind.MakeTuple:
    case IrKind.TupleGet:
    case IrKind.FieldGet:
    case IrKind.IfExpr:
    case IrKind.SwitchExpr:
    case IrKind.ForExpr:
    case IrKind.ForInExpr:
    case IrKind.WhileExpr:
    case IrKind.BlockExpr:
      return {expr, rootSafe: false};
    default:
      return unreachableExpr(expr);
  }
}

function normalizeFunctionCall(
  call: Extract<
    IrExpr,
    {kind: typeof IrKind.CallFunc | typeof IrKind.CallConstMethod}
  >,
  args: readonly Normalized[],
  ctx: WalkContext,
  functionNames: ReadonlySet<Name>,
): Normalized {
  if (
    !qualifierLE(call.qualifier, Qualifier.Input) ||
    args.some(arg => !arg.rootSafe)
  ) {
    return {expr: call, rootSafe: false};
  }
  if (ctx.active.has(call.func)) {
    return fatal(`recursive function '${call.func.name}' reached depth pass`);
  }
  const env = new Map<Name, Normalized>();
  const params =
    call.func.callMode === 'free'
      ? call.func.params
      : [call.func.receiver, ...call.func.params];
  params.forEach((param, index) => {
    const arg = args[index];
    if (arg === undefined) {
      return fatal(`call to '${call.func.name}' is missing argument ${index}`);
    }
    env.set(param, arg);
  });
  const active = new Set(ctx.active);
  active.add(call.func);
  const callee: WalkContext = {
    env,
    induction: new Map(),
    immutable: ctx.immutableByFunc.get(call.func) ?? new Set<Name>(),
    immutableByFunc: ctx.immutableByFunc,
    scope: 'function',
    active,
  };
  return normalizeFunctionResult(call.func.body, callee, functionNames);
}

function normalizeFunctionResult(
  expr: IrExpr,
  ctx: WalkContext,
  functionNames: ReadonlySet<Name>,
): Normalized {
  if (expr.kind !== IrKind.BlockExpr) {
    return normalize(expr, ctx, functionNames);
  }
  const block = {...ctx, env: new Map(ctx.env)};
  for (const stmt of expr.stmts) {
    if (stmt.kind !== IrKind.WriteName || !block.immutable.has(stmt.name)) {
      return {expr, rootSafe: false};
    }
    const value = normalize(stmt.value, block, functionNames);
    if (!value.rootSafe) {
      return {expr, rootSafe: false};
    }
    block.env.set(stmt.name, value);
  }
  return expr.value === null
    ? {expr, rootSafe: false}
    : normalize(expr.value, block, functionNames);
}

function carrierOf(read: HistReadExpr): DepthCarrier {
  const place = read.place;
  switch (place.kind) {
    case PlaceKind.Name:
      return place.name;
    case PlaceKind.Param:
      return place.param;
    case PlaceKind.Series:
      return place.series;
    case PlaceKind.Builtin:
      return place.builtin;
    case PlaceKind.Request:
      return place.request;
  }
}

function finalize(demand: Demand): HistoryDepth {
  const minimum = Math.max(demand.maxConst, demand.dynamicCap ?? 0);
  if (demand.bound.length === 0) {
    if (demand.dynamicCap !== null) {
      return cappedDepth(demand, minimum);
    }
    return minimum > 0
      ? {kind: DepthKind.Const, bars: minimum}
      : {kind: DepthKind.None};
  }
  if (demand.bound.length === 1 && minimum === 0) {
    return {kind: DepthKind.Bound, expr: demand.bound[0]};
  }
  return {kind: DepthKind.Bound, expr: maxDemand(demand, minimum)};
}

function maxDemand(demand: Demand, minimum: number): IrExpr {
  const zero = intConst(0, demand.pos);
  const args: IrExpr[] = [
    zero,
    ...demand.bound.map(expr => validDepthDemand(expr)),
  ];
  if (minimum > 0) {
    args.push(intConst(minimum, demand.pos));
  }
  return {
    kind: IrKind.CallNative,
    pos: demand.pos,
    type: IntType,
    qualifier: args.reduce<Qualifier>(
      (qualifier, expr) => joinQualifiers(qualifier, expr.qualifier),
      Qualifier.Const,
    ),
    native: 'math.max',
    slot: null,
    args,
    argumentEvaluationOrder: args.map((_arg, index) => index),
  };
}

function validDepthDemand(expr: IrExpr): IrExpr {
  return {
    kind: IrKind.CallNative,
    pos: expr.pos,
    type: IntType,
    qualifier: expr.qualifier,
    native: '$historyDepth',
    slot: null,
    args: [expr],
    argumentEvaluationOrder: [0],
  };
}

function intConst(value: number, pos: HistReadExpr['pos']): IrExpr {
  return {
    kind: IrKind.Const,
    pos,
    type: IntType,
    qualifier: Qualifier.Const,
    value,
  };
}

function cappedDepth(demand: Demand, cap: number): HistoryDepth {
  return {
    kind: DepthKind.Capped,
    bars: intConst(cap, demand.pos),
  };
}

// indicator(max_bars_back=N) declares the cap; the engine default otherwise.
// OutputDecl.effect holds the native's NAME (indicator/strategy), not its
// effect class.
function declarationCap(program: Program): number {
  for (const output of program.outputs) {
    if (output.effect !== 'indicator' && output.effect !== 'strategy') {
      continue;
    }
    const declared = output.staticArgs.find(a => a.name === 'max_bars_back');
    if (declared !== undefined && typeof declared.value === 'number') {
      return declared.value;
    }
  }
  return DEFAULT_MAX_BARS_BACK;
}

function unreachableExpr(expr: never): never {
  return fatal(`unhandled depth expression: ${JSON.stringify(expr)}`);
}
