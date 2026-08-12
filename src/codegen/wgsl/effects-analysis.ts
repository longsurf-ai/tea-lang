// Purpose: Prove a fixed per-row sparse-effect bound and deterministic string
// ids before WGSL emission so the host never reverse-engineers shader source.

import type {Pos} from '../../base/pos';
import {fatal} from '../../base/print';
import {
  IrKind,
  PlaceKind,
  Storage,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../../ir/node';
import type {IrFunc, Program} from '../../ir/program';
import {TypeKind} from '../../ir/type';
import {funcsOf, namesOf} from '../../ir/visit';

export interface WgslEffectAnalysis {
  readonly maxEffectsPerRow: number;
  readonly literalStrings: readonly string[];
}

export class WgslEffectAnalysisError extends Error {
  constructor(
    message: string,
    readonly pos?: Pos,
  ) {
    super(message);
    this.name = 'WgslEffectAnalysisError';
  }
}

export function analyzeWgslEffects(program: Program): WgslEffectAnalysis {
  return Object.freeze({
    maxEffectsPerRow: new EffectBound(program).analyze(),
    literalStrings: collectLiteralStrings(program),
  });
}

// Literal strings become artifact-owned ids. Walk the executable graph in
// deterministic evaluation order and enter each called function at its first
// call site. Declaration metadata and unreachable functions do not consume ids.
export function collectLiteralStrings(program: Program): readonly string[] {
  const strings = new Set<string>();
  const names = new Set<Name>();
  const funcs = new Set<IrFunc>();

  const visitName = (name: Name): void => {
    if (names.has(name)) return;
    names.add(name);
    if (name.init !== null) visitExpr(name.init);
  };

  const visitFunc = (func: IrFunc): void => {
    if (funcs.has(func)) return;
    funcs.add(func);
    if (func.callMode !== 'free') visitName(func.receiver);
    func.params.forEach(visitName);
    func.locals.forEach(visitName);
    visitExpr(func.body);
  };

  const visitArgs = (
    args: readonly IrExpr[],
    order: readonly number[],
  ): void => {
    validateEvaluationOrder(args, order);
    order.forEach(index => visitExpr(args[index]));
  };

  const visitStmt = (stmt: IrStmt): void => {
    switch (stmt.kind) {
      case IrKind.ExprStmt:
        visitExpr(stmt.x);
        return;
      case IrKind.WriteName:
        visitExpr(stmt.value);
        return;
      case IrKind.UpdateValuePath:
        visitExpr(stmt.value);
        return;
      case IrKind.Emit:
        visitArgs(stmt.args, stmt.argumentEvaluationOrder);
        return;
      case IrKind.EmitEffect:
        visitExpr(stmt.payload);
        return;
      case IrKind.Break:
      case IrKind.Continue:
        return;
      default:
        return unreachableStmt(stmt);
    }
  };

  function visitExpr(expr: IrExpr): void {
    switch (expr.kind) {
      case IrKind.Const:
        if (
          expr.type.kind === TypeKind.String &&
          typeof expr.value === 'string'
        ) {
          strings.add(expr.value);
        }
        return;
      case IrKind.OutputRef:
        return;
      case IrKind.HistRead:
        if (expr.place.kind === PlaceKind.Name) visitName(expr.place.name);
        if (expr.offset !== null) visitExpr(expr.offset);
        return;
      case IrKind.Binary:
        visitExpr(expr.x);
        visitExpr(expr.y);
        return;
      case IrKind.Unary:
        visitExpr(expr.x);
        return;
      case IrKind.Cond:
        // Tea Cond is eager: both value arms execute.
        visitExpr(expr.cond);
        visitExpr(expr.then);
        visitExpr(expr.else);
        return;
      case IrKind.CallFunc:
        visitArgs(expr.args, expr.argumentEvaluationOrder);
        visitFunc(expr.func);
        return;
      case IrKind.CallConstMethod:
      case IrKind.CallMutableMethod:
        visitExpr(expr.receiver);
        visitArgs(expr.args, expr.argumentEvaluationOrder);
        visitFunc(expr.func);
        return;
      case IrKind.CallNative:
        visitArgs(expr.args, expr.argumentEvaluationOrder);
        return;
      case IrKind.MutateCollection:
        visitExpr(expr.receiver);
        visitArgs(expr.args, expr.argumentEvaluationOrder);
        return;
      case IrKind.NewUserValue:
        visitArgs(expr.args, expr.argumentEvaluationOrder);
        return;
      case IrKind.MakeTuple:
        expr.elems.forEach(visitExpr);
        return;
      case IrKind.TupleGet:
      case IrKind.FieldGet:
        visitExpr(expr.x);
        return;
      case IrKind.IfExpr:
        visitExpr(expr.cond);
        visitExpr(expr.then);
        if (expr.else !== null) visitExpr(expr.else);
        return;
      case IrKind.SwitchExpr:
        if (expr.subject !== null) visitExpr(expr.subject);
        expr.arms.forEach(arm => {
          if (arm.pattern !== null) visitExpr(arm.pattern);
          visitExpr(arm.body);
        });
        return;
      case IrKind.ForExpr:
        visitExpr(expr.from);
        visitExpr(expr.to);
        if (expr.step !== null) visitExpr(expr.step);
        visitExpr(expr.body);
        return;
      case IrKind.ForInExpr:
        visitExpr(expr.x);
        visitExpr(expr.body);
        return;
      case IrKind.WhileExpr:
        visitExpr(expr.cond);
        visitExpr(expr.body);
        return;
      case IrKind.BlockExpr:
        expr.stmts.forEach(visitStmt);
        if (expr.value !== null) visitExpr(expr.value);
        return;
      default:
        return unreachableExpr(expr);
    }
  }

  program.packageGlobals.forEach(visitName);
  program.init.forEach(visitStmt);
  program.body.forEach(visitStmt);
  return Object.freeze([...strings]);
}

class EffectBound {
  private readonly functionBounds = new Map<IrFunc, number>();
  private readonly activeFunctions = new Set<IrFunc>();

  constructor(private readonly program: Program) {}

  analyze(): number {
    // Effects in bind/initializer contexts are rejected by the checker. Keep
    // this assertion fail-closed because GPU chunks size only per-row records.
    const initializationEffects = sum(this.program.init, stmt =>
      this.stmt(stmt),
    );
    if (initializationEffects !== 0) {
      throw new WgslEffectAnalysisError(
        'GPU effect transport cannot size initialization-time emissions',
      );
    }
    for (const root of persistentInitializationRoots(this.program)) {
      if (root.init !== null && this.expr(root.init) !== 0) {
        throw new WgslEffectAnalysisError(
          `GPU effect transport cannot execute emissions from persistent initializer '${root.name}'`,
          root.init.pos,
        );
      }
    }
    return checkedBound(sum(this.program.body, stmt => this.stmt(stmt)));
  }

  private stmt(stmt: IrStmt): number {
    switch (stmt.kind) {
      case IrKind.ExprStmt:
        return this.expr(stmt.x);
      case IrKind.WriteName:
      case IrKind.UpdateValuePath:
        return this.expr(stmt.value);
      case IrKind.Emit:
        return this.args(stmt.args, stmt.argumentEvaluationOrder);
      case IrKind.EmitEffect:
        return checkedAdd(this.expr(stmt.payload), 1, stmt.pos);
      case IrKind.Break:
      case IrKind.Continue:
        return 0;
      default:
        return unreachableStmt(stmt);
    }
  }

  private expr(expr: IrExpr): number {
    switch (expr.kind) {
      case IrKind.Const:
      case IrKind.OutputRef:
        return 0;
      case IrKind.HistRead:
        return expr.offset === null ? 0 : this.expr(expr.offset);
      case IrKind.Binary:
        // And/Or are lazy, but executing the right side remains the maximum.
        return checkedAdd(this.expr(expr.x), this.expr(expr.y), expr.pos);
      case IrKind.Unary:
        return this.expr(expr.x);
      case IrKind.Cond:
        // Unlike IfExpr, Cond evaluates both value arms.
        return checkedAdd(
          checkedAdd(this.expr(expr.cond), this.expr(expr.then), expr.pos),
          this.expr(expr.else),
          expr.pos,
        );
      case IrKind.CallFunc:
        return checkedAdd(
          this.args(expr.args, expr.argumentEvaluationOrder),
          this.func(expr.func, expr.pos),
          expr.pos,
        );
      case IrKind.CallConstMethod:
      case IrKind.CallMutableMethod:
        return checkedAdd(
          checkedAdd(
            this.expr(expr.receiver),
            this.args(expr.args, expr.argumentEvaluationOrder),
            expr.pos,
          ),
          this.func(expr.func, expr.pos),
          expr.pos,
        );
      case IrKind.CallNative:
        return this.args(expr.args, expr.argumentEvaluationOrder);
      case IrKind.MutateCollection:
        return checkedAdd(
          this.expr(expr.receiver),
          this.args(expr.args, expr.argumentEvaluationOrder),
          expr.pos,
        );
      case IrKind.NewUserValue:
        return this.args(expr.args, expr.argumentEvaluationOrder);
      case IrKind.MakeTuple:
        return sum(expr.elems, elem => this.expr(elem));
      case IrKind.TupleGet:
      case IrKind.FieldGet:
        return this.expr(expr.x);
      case IrKind.IfExpr:
        return checkedAdd(
          this.expr(expr.cond),
          Math.max(
            this.expr(expr.then),
            expr.else === null ? 0 : this.expr(expr.else),
          ),
          expr.pos,
        );
      case IrKind.SwitchExpr:
        return this.switchExpr(expr);
      case IrKind.ForExpr:
        return this.forExpr(expr);
      case IrKind.ForInExpr: {
        const collection = this.expr(expr.x);
        const body = this.expr(expr.body);
        if (body === 0) return collection;
        throw new WgslEffectAnalysisError(
          'GPU effect transport cannot prove a bound for collection iteration',
          expr.pos,
        );
      }
      case IrKind.WhileExpr: {
        const condition = this.expr(expr.cond);
        const body = this.expr(expr.body);
        if (condition === 0 && body === 0) return 0;
        throw new WgslEffectAnalysisError(
          'GPU effect transport cannot prove a bound for while iteration',
          expr.pos,
        );
      }
      case IrKind.BlockExpr:
        return checkedAdd(
          sum(expr.stmts, stmt => this.stmt(stmt)),
          expr.value === null ? 0 : this.expr(expr.value),
          expr.pos,
        );
      default:
        return unreachableExpr(expr);
    }
  }

  private args(args: readonly IrExpr[], order: readonly number[]): number {
    validateEvaluationOrder(args, order);
    return sum(order, index => this.expr(args[index]));
  }

  private func(func: IrFunc, pos: Pos): number {
    const cached = this.functionBounds.get(func);
    if (cached !== undefined) return cached;
    if (this.activeFunctions.has(func)) {
      throw new WgslEffectAnalysisError(
        `GPU effect transport cannot prove a bound for recursive function '${func.name}'`,
        pos,
      );
    }
    this.activeFunctions.add(func);
    try {
      const bound = this.expr(func.body);
      this.functionBounds.set(func, bound);
      return bound;
    } finally {
      this.activeFunctions.delete(func);
    }
  }

  private switchExpr(
    expr: Extract<IrExpr, {kind: typeof IrKind.SwitchExpr}>,
  ): number {
    const subject = expr.subject === null ? 0 : this.expr(expr.subject);
    let testedPatterns = 0;
    let selectedMaximum = 0;
    for (const arm of expr.arms) {
      if (arm.pattern !== null) {
        testedPatterns = checkedAdd(
          testedPatterns,
          this.expr(arm.pattern),
          expr.pos,
        );
      }
      selectedMaximum = Math.max(
        selectedMaximum,
        checkedAdd(testedPatterns, this.expr(arm.body), expr.pos),
      );
    }
    return checkedAdd(subject, selectedMaximum, expr.pos);
  }

  private forExpr(
    expr: Extract<IrExpr, {kind: typeof IrKind.ForExpr}>,
  ): number {
    const setup = checkedAdd(
      checkedAdd(this.expr(expr.from), this.expr(expr.to), expr.pos),
      expr.step === null ? 0 : this.expr(expr.step),
      expr.pos,
    );
    const body = this.expr(expr.body);
    if (body === 0) return setup;
    const from = constInteger(expr.from);
    const to = constInteger(expr.to);
    const step = expr.step === null ? 1 : constInteger(expr.step);
    if (from === null || to === null || step === null || step === 0) {
      throw new WgslEffectAnalysisError(
        'GPU effect transport requires compile-time integer for bounds and a non-zero step',
        expr.pos,
      );
    }
    const iterations =
      step > 0
        ? from > to
          ? 0
          : Math.floor((to - from) / step) + 1
        : from < to
          ? 0
          : Math.floor((from - to) / -step) + 1;
    return checkedAdd(
      setup,
      checkedMultiply(iterations, body, expr.pos),
      expr.pos,
    );
  }
}

// Program.init is not the whole initialization graph: persistent script roots
// and imported package globals carry their initializer directly on Name.init.
// Function/default/constructor expansion is already explicit in those IrExprs,
// so EffectBound.expr follows the same ordinary call and argument graph used by
// per-row sizing.
function persistentInitializationRoots(program: Program): readonly Name[] {
  const functionNames = new Set<Name>();
  for (const func of funcsOf(program)) {
    if (func.callMode !== 'free') functionNames.add(func.receiver);
    func.params.forEach(name => functionNames.add(name));
    func.locals.forEach(name => functionNames.add(name));
  }

  const roots = new Set<Name>(program.packageGlobals);
  for (const name of namesOf(program)) {
    if (
      !functionNames.has(name) &&
      (name.storage === Storage.Var || name.storage === Storage.Varip)
    ) {
      roots.add(name);
    }
  }
  return [...roots];
}

function validateEvaluationOrder(
  args: readonly IrExpr[],
  order: readonly number[],
): void {
  if (
    order.length !== args.length ||
    new Set(order).size !== args.length ||
    order.some(index => index < 0 || index >= args.length)
  ) {
    fatal('malformed argument evaluation order in WGSL effect analysis');
  }
}

function constInteger(expr: IrExpr): number | null {
  return expr.kind === IrKind.Const &&
    typeof expr.value === 'number' &&
    Number.isSafeInteger(expr.value)
    ? expr.value
    : null;
}

function checkedAdd(left: number, right: number, pos?: Pos): number {
  return checkedBound(left + right, pos);
}

function checkedMultiply(left: number, right: number, pos?: Pos): number {
  return checkedBound(left * right, pos);
}

function checkedBound(value: number, pos?: Pos): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new WgslEffectAnalysisError(
      'GPU per-row effect bound exceeds the u32 transport domain',
      pos,
    );
  }
  return value;
}

function sum<T>(values: readonly T[], project: (value: T) => number): number {
  let total = 0;
  for (const value of values) {
    total = checkedAdd(total, project(value));
  }
  return total;
}

function unreachableExpr(expr: never): never {
  return fatal(
    `unhandled WGSL effect-analysis expression ${JSON.stringify(expr)}`,
  );
}

function unreachableStmt(stmt: never): never {
  return fatal(`unhandled WGSL effect-analysis statement ${JSON.stringify(stmt)}`);
}
