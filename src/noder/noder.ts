// Purpose: Noder — buildProgram() turns checked syntax plus the checker's Info into the Tea Program (desugaring compound assigns, tuple patterns, param/output extraction, and history-on-expression); source loading lives in src/loader.
//
// The noder consumes checked, error-free syntax and never re-checks: every
// type and qualifier comes from Info side tables, every use resolves through
// Info.uses/defs/ambient to the binder's shared ir objects. Bad nodes or
// missing table entries here mean the phase barrier was violated — fatal.

import type {Pos} from '../base/pos';
import {fatal, type Errors} from '../base/print';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type IrBinaryOp,
  type IrExpr,
  type IrStmt,
  type IrUnaryOp,
  type BlockExpr,
  type HistReadExpr,
  type Name as IrName,
  type OutputRefExpr,
  type Place,
  type SwitchArm,
} from '../ir/node';
import {
  MergeMode,
  ParamConstraintKind,
  ParamDefaultKind,
  type IrFunc,
  type MergePolicy,
  type OutputDecl,
  type ParamConstraints,
  type ParamDefault,
  type ParamInput,
  type Program,
  type RequestEdge,
} from '../ir/program';
import {
  assignable,
  BoolType,
  FloatType,
  IntType,
  NaType,
  NA_VALUE,
  Qualifier,
  qualifierLE,
  TypeKind,
  VoidType,
  joinQualifiers,
  unifyTypes,
  type ConstValue,
  type Type,
  type TypeAndValue,
} from '../ir/type';
import {bindEvaluable} from '../ir/visit';
import {ASSIGN_BASE_OP, AssignOp, Mode, NodeKind} from '../syntax/nodes';
import type * as syntax from '../syntax/nodes';
import {Op} from '../syntax/tokens';
import {Effect, TypeRef, type NativeParam} from '../checker/catalog';
import type {
  FuncInstance,
  Info,
  ResolvedCall,
  SideTables,
} from '../checker/check';
import {resolveDepths} from './depth';

// Build the Program from checked syntax ("noding"). Requires a clean check —
// compile()'s phase barrier guarantees it.
export function buildProgram(
  file: syntax.File,
  info: Info,
  errors: Errors,
): Program {
  return new Noder(info, errors).build(file);
}

// Surface lexeme vocabulary → semantic operation vocabulary.
const BINARY_OP_MAP: Readonly<Partial<Record<Op, IrBinaryOp>>> = {
  [Op.Or]: IrOp.Or,
  [Op.And]: IrOp.And,
  [Op.EqEq]: IrOp.Eq,
  [Op.NotEq]: IrOp.Ne,
  [Op.Lt]: IrOp.Lt,
  [Op.Le]: IrOp.Le,
  [Op.Gt]: IrOp.Gt,
  [Op.Ge]: IrOp.Ge,
  [Op.Plus]: IrOp.Add,
  [Op.Minus]: IrOp.Sub,
  [Op.Star]: IrOp.Mul,
  [Op.Slash]: IrOp.Div,
  [Op.Percent]: IrOp.Mod,
};

class Noder {
  private readonly params: ParamInput[] = [];
  private readonly outputs: OutputDecl[] = [];
  // One ParamInput / OutputDecl per call site, deduped by the syntax node.
  private readonly paramOf = new Map<syntax.CallExpr, ParamInput>();
  // Compile-time reference bindings: `len = input.int(...)` and
  // `p = plot(...)` bind the name to the param/output instead of emitting a
  // per-bar write (only when the name is never reassigned).
  private readonly paramRefs = new Map<IrName, ParamInput>();
  private readonly outputRefs = new Map<IrName, OutputDecl>();
  // Alias bindings: a never-reassigned declaration whose initializer is a
  // current-bar read of a STABLE place (series, param, request — never a
  // Name, whose later writes would leak through) binds the name to that
  // place, so history offsets land on the place itself.
  private readonly aliasRefs = new Map<IrName, Place>();
  // Per-top-statement queues: synthetic history writes go before the
  // statement, output Emits after it.
  private hoisted: IrStmt[] = [];
  private emitted: IrStmt[] = [];
  private nesting = 0;
  // One IrFunc per checker instance (per-signature stencil); bodies node
  // against the instance's own side tables.
  private readonly instanceFuncs = new Map<FuncInstance, IrFunc>();
  // Names owned by each user-function frame currently being noded. This is
  // the ownership information request classification needs to distinguish a
  // root alias (bind-readable through rt.root()) from a function-local input
  // parameter (which requires a per-call frame and is therefore dynamic).
  private readonly functionFrameNames: Set<IrName>[] = [];
  // Frame-local slot counters: the program frame at the bottom, one counter
  // per IrFunc body being noded. Every call site mints the next slot of the
  // frame it sits in — the sub-frame selector within that frame.
  private readonly slots: number[] = [0];
  // Request edges per Program level: the parent's list at the bottom, one
  // pushed per child capture being noded (nested requests belong to the
  // child).
  private readonly requestLevels: RequestEdge[][] = [[]];
  // Request edges memoize per (side-table view, call site): the same syntax
  // call noded under two FuncInstances must yield two edges — the context
  // exprs reference the INSTANCE's param Names.
  private readonly requestOf = new Map<
    SideTables,
    Map<syntax.CallExpr, RequestEdge>
  >();
  private version = 1;

  // The side-table view for the context being noded: the Info itself for
  // the main body, a FuncInstance's tables inside its body.
  private tables: SideTables;

  constructor(
    private readonly info: Info,
    private readonly errors: Errors,
  ) {
    this.tables = info;
  }

  private mintSlot(): number {
    const top = this.slots.length - 1;
    const id = this.slots[top];
    this.slots[top] += 1;
    return id;
  }

  build(file: syntax.File): Program {
    const body: IrStmt[] = [];
    for (const stmt of file.stmtList) {
      this.hoisted = [];
      this.emitted = [];
      const stmts = this.nodeStmt(stmt);
      body.push(...this.hoisted, ...stmts, ...this.emitted);
    }
    const versionNumber = Number(file.version ?? '1');
    this.version = Number.isFinite(versionNumber) ? versionNumber : 1;
    const program: Program = {
      version: this.version,
      params: this.params,
      requests: this.requestLevels[0],
      outputs: this.outputs,
      // Hoisting const/input/simple work out of the bar loop is a later
      // optimization; everything runs in the per-bar body for now.
      init: [],
      body,
    };
    resolveDepths(program);
    this.checkDynamicRequestsFlag(program);
    return program;
  }

  // Pine v6 dynamic_requests defaults to true; an explicit false on the
  // declaration restores the static-only gate on context args. A post-pass
  // so declaration order cannot dodge it.
  private checkDynamicRequestsFlag(program: Program): void {
    const declared = program.outputs
      .flatMap(output => output.staticArgs)
      .find(arg => arg.name === 'dynamic_requests');
    if (declared === undefined || declared.value !== false) {
      return;
    }
    const visit = (requests: readonly RequestEdge[]): void => {
      for (const edge of requests) {
        if (edge.dynamic) {
          this.errors.errorAt(
            edge.pos,
            'series context arguments need dynamic_requests=true',
          );
        }
        visit(edge.child.requests);
      }
    };
    visit(program.requests);
  }

  private tvOf(e: syntax.Expr): TypeAndValue {
    const tv = this.tables.types.get(e);
    if (tv === undefined) {
      return fatal(`unchecked expression reached the noder: ${e.kind}`);
    }
    return tv;
  }

  private read(name: IrName, pos: Pos): HistReadExpr {
    return {
      kind: IrKind.HistRead,
      pos,
      type: name.type,
      qualifier: name.qualifier,
      place: {kind: PlaceKind.Name, name},
      offset: null,
    };
  }

  private constExpr(pos: Pos, type: Type, value: ConstValue): IrExpr {
    return {
      kind: IrKind.Const,
      pos,
      type,
      qualifier: Qualifier.Const,
      value,
    };
  }

  private naConst(pos: Pos, type: Type): IrExpr {
    if (!assignable(NaType, type) || type.kind === TypeKind.Na) {
      return fatal('uncontextualized na reached Program construction');
    }
    return this.constExpr(pos, type, NA_VALUE);
  }

  private nativeExpectedType(
    param: NativeParam,
    resultType: Type,
    nativeName: string | null = null,
  ): Type | null {
    if (typeof param.type !== 'string') {
      return param.type;
    }
    if (param.type === TypeRef.Num) {
      return resultType.kind === TypeKind.Int ||
        resultType.kind === TypeKind.Float
        ? resultType
        : FloatType;
    }
    if (param.type === TypeRef.Enum) {
      return resultType.kind === TypeKind.Enum ? resultType : null;
    }
    if (param.type === TypeRef.Nullable) {
      return FloatType;
    }
    if (param.type === TypeRef.Any && nativeName === 'str.tostring') {
      return FloatType;
    }
    return null;
  }

  // ---- statements -----------------------------------------------------------

  private nodeStmt(stmt: syntax.Stmt): IrStmt[] {
    switch (stmt.kind) {
      case NodeKind.ExprStmt:
        return this.nodeExprStmt(stmt);
      case NodeKind.DeclStmt:
        return this.nodeDecl(stmt);
      case NodeKind.AssignStmt:
        return this.nodeAssign(stmt);
      case NodeKind.FuncDecl:
      case NodeKind.TypeDecl:
      case NodeKind.EnumDecl:
      case NodeKind.ImportStmt:
        // Compile-time declarations; nothing runs per bar. (Function bodies
        // instantiate at call sites when the function slice lands.)
        return [];
      case NodeKind.BreakStmt:
        return [{kind: IrKind.Break, pos: stmt.pos}];
      case NodeKind.ContinueStmt:
        return [{kind: IrKind.Continue, pos: stmt.pos}];
      case NodeKind.BadStmt:
        return fatal('Bad statement reached the noder past the check barrier');
    }
  }

  private nodeExprStmt(stmt: syntax.ExprStmt): IrStmt[] {
    const call = unwrapCall(stmt.x);
    if (call !== null) {
      const resolved = this.tables.calls.get(call);
      if (resolved !== undefined) {
        if (resolved.native.effect === Effect.Declaration) {
          this.nodeDeclarationCall(resolved);
          return [];
        }
        if (resolved.native.effect === Effect.Output) {
          this.nodeOutputCall(call, resolved);
          return [];
        }
        if (resolved.native.effect === Effect.Param) {
          this.ensureParam(call, resolved, null);
          return [];
        }
      }
    }
    const tv = this.tvOf(stmt.x);
    if (tv.type.kind === TypeKind.Na && tv.value !== null) {
      // A standalone na is a dead constant, so it never enters Program IR.
      return [];
    }
    const x = this.nodeExpr(stmt.x);
    // A fully-folded statement expression is pure and dead.
    if (x.kind === IrKind.Const) {
      return [];
    }
    return [{kind: IrKind.ExprStmt, pos: stmt.pos, x}];
  }

  private nodeDecl(d: syntax.DeclStmt): IrStmt[] {
    if (d.target.kind === NodeKind.TuplePattern) {
      return this.nodeTupleDecl(d, d.target);
    }
    const name = this.tables.defs.get(d.target);
    if (name === undefined) {
      return fatal(
        `undeclared decl target reached the noder: ${d.target.value}`,
      );
    }
    const rebindable = !this.tables.reassigned.has(name);

    // `len = input.int(...)` binds the name to the param: reads become
    // param reads, no per-bar write exists.
    const call = unwrapCall(d.init);
    if (call !== null && rebindable && d.mode === Mode.None) {
      const resolved = this.tables.calls.get(call);
      if (resolved !== undefined && resolved.native.effect === Effect.Param) {
        const param = this.ensureParam(call, resolved, name.name);
        this.paramRefs.set(name, param);
        return [];
      }
    }

    // Tea const declarations are fully compile-time: every read folded.
    if (d.mode === Mode.Const) {
      return [];
    }

    const init = this.nodeExpr(d.init, name.type);

    // `p = plot(...)` (or an alias of it) binds the name to the output
    // declaration: refs resolve at bind time, never per bar.
    if (init.kind === IrKind.OutputRef && rebindable && d.mode === Mode.None) {
      this.outputRefs.set(name, init.output);
      return [];
    }

    if (
      init.kind === IrKind.HistRead &&
      init.offset === null &&
      init.place.kind !== PlaceKind.Name &&
      // Dynamic request reads must EXECUTE per row (rt.requestFor); an
      // alias would erase the execution, so the declaration stays a real
      // per-row Name write.
      !(init.place.kind === PlaceKind.Request && init.place.request.dynamic) &&
      rebindable &&
      d.mode === Mode.None
    ) {
      this.aliasRefs.set(name, init.place);
      return [];
    }

    if (name.storage === Storage.Var || name.storage === Storage.Varip) {
      // First-bar initializer, evaluated once by the runtime.
      name.init = init;
      return [];
    }
    return [{kind: IrKind.WriteName, pos: d.pos, name, value: init}];
  }

  private nodeTupleDecl(
    d: syntax.DeclStmt,
    pattern: syntax.TuplePattern,
  ): IrStmt[] {
    if (d.mode === Mode.Var || d.mode === Mode.Varip) {
      this.errors.errorAt(
        d.pos,
        'var tuple declarations are not supported yet',
      );
      return [];
    }
    const initTv = this.tvOf(d.init);
    const temp: IrName = {
      name: `$tuple@${d.pos.line}:${d.pos.col}`,
      storage: Storage.PerBar,
      type: initTv.type,
      qualifier: initTv.qualifier,
      depth: {kind: DepthKind.None},
      init: null,
    };
    const stmts: IrStmt[] = [
      {
        kind: IrKind.WriteName,
        pos: d.pos,
        name: temp,
        value: this.nodeExpr(d.init, initTv.type),
      },
    ];
    pattern.elems.forEach((elem, i) => {
      const name = this.tables.defs.get(elem);
      if (name === undefined) {
        return fatal(
          `undeclared tuple element reached the noder: ${elem.value}`,
        );
      }
      stmts.push({
        kind: IrKind.WriteName,
        pos: elem.pos,
        name,
        value: {
          kind: IrKind.TupleGet,
          pos: elem.pos,
          type: name.type,
          qualifier: name.qualifier,
          x: this.read(temp, elem.pos),
          index: i,
        },
      });
    });
    return stmts;
  }

  private nodeAssign(a: syntax.AssignStmt): IrStmt[] {
    if (a.target.kind === NodeKind.Name) {
      const name = this.tables.uses.get(a.target);
      if (name === undefined) {
        return fatal(
          `unresolved assign target reached the noder: ${a.target.value}`,
        );
      }
      const value = this.nodeExpr(a.value, name.type);
      const base = ASSIGN_BASE_OP[a.op];
      const written =
        a.op === AssignOp.Define || base === undefined
          ? value
          : ({
              kind: IrKind.Binary,
              pos: a.pos,
              type: name.type,
              qualifier: joinQualifiers(name.qualifier, value.qualifier),
              op: mapBinaryOp(base),
              x: this.read(name, a.pos),
              y: value,
            } as const);
      return [{kind: IrKind.WriteName, pos: a.pos, name, value: written}];
    }
    if (a.target.kind === NodeKind.SelectorExpr) {
      const targetType = this.tvOf(a.target).type;
      return [
        {
          kind: IrKind.WriteField,
          pos: a.pos,
          x: this.nodeExpr(a.target.x),
          field: a.target.sel.value,
          value: this.nodeExpr(a.value, targetType),
        },
      ];
    }
    return fatal('invalid assignment target reached the noder');
  }

  // ---- expressions ----------------------------------------------------------

  private nodeExpr(e: syntax.Expr, expectedType: Type | null = null): IrExpr {
    const checked = this.tvOf(e);
    const contextualType =
      checked.type.kind === TypeKind.Na &&
      expectedType !== null &&
      expectedType.kind !== TypeKind.Na &&
      assignable(checked.type, expectedType)
        ? expectedType
        : checked.type;
    if (contextualType.kind === TypeKind.Na) {
      return fatal('uncontextualized na reached Program construction');
    }
    const tv: TypeAndValue =
      contextualType === checked.type
        ? checked
        : {...checked, type: contextualType};
    // Aggressive folding: any expression the checker resolved to a constant
    // becomes a Const node (const-qualified exprs are pure by construction).
    if (tv.value !== null) {
      return {
        kind: IrKind.Const,
        pos: e.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        value: tv.value,
      };
    }
    switch (e.kind) {
      case NodeKind.Name:
      case NodeKind.SelectorExpr:
        return this.nodePlaceRead(e, tv);
      case NodeKind.BasicLit:
        return fatal('unfolded literal reached the noder');
      case NodeKind.UnaryExpr: {
        if (e.op === Op.Plus) {
          return this.nodeExpr(e.x, tv.type);
        }
        const op: IrUnaryOp = e.op === Op.Minus ? IrOp.Neg : IrOp.Not;
        return {
          kind: IrKind.Unary,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          op,
          x: this.nodeExpr(e.x, tv.type),
        };
      }
      case NodeKind.BinaryExpr: {
        const operandType =
          unifyTypes(this.tvOf(e.x).type, this.tvOf(e.y).type) ?? tv.type;
        return {
          kind: IrKind.Binary,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          op: mapBinaryOp(e.op),
          x: this.nodeExpr(e.x, operandType),
          y: this.nodeExpr(e.y, operandType),
        };
      }
      case NodeKind.CondExpr:
        return {
          kind: IrKind.Cond,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          cond: this.nodeExpr(e.cond),
          then: this.nodeExpr(e.then, tv.type),
          else: this.nodeExpr(e.else, tv.type),
        };
      case NodeKind.CallExpr:
        return this.nodeCall(e, tv);
      case NodeKind.HistoryExpr:
        return this.nodeHistory(e, tv);
      case NodeKind.TupleExpr:
        return {
          kind: IrKind.MakeTuple,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          elems: e.elems.map((elem, i) =>
            this.nodeExpr(
              elem,
              tv.type.kind === TypeKind.Tuple ? tv.type.elems[i] : null,
            ),
          ),
        };
      case NodeKind.ParenExpr:
        return this.nodeExpr(e.x, tv.type);
      case NodeKind.IfExpr:
        return this.nodeIf(e, tv);
      case NodeKind.ForExpr: {
        const index = this.tables.defs.get(e.index);
        if (index === undefined) {
          return fatal('unresolved loop index reached the noder');
        }
        return {
          kind: IrKind.ForExpr,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          index,
          from: this.nodeExpr(e.from, index.type),
          to: this.nodeExpr(e.to, index.type),
          step: e.step !== null ? this.nodeExpr(e.step, index.type) : null,
          body: this.nodeBlock(e.body, tv.type),
        };
      }
      case NodeKind.ForInExpr: {
        const targetNames =
          e.target.kind === NodeKind.Name ? [e.target] : e.target.elems;
        const targets = targetNames.map(n => {
          const name = this.tables.defs.get(n);
          if (name === undefined) {
            return fatal('unresolved for-in target reached the noder');
          }
          return name;
        });
        return {
          kind: IrKind.ForInExpr,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          targets,
          x: this.nodeExpr(e.x),
          body: this.nodeBlock(e.body, tv.type),
        };
      }
      case NodeKind.WhileExpr:
        return {
          kind: IrKind.WhileExpr,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          cond: this.nodeExpr(e.cond),
          body: this.nodeBlock(e.body, tv.type),
        };
      case NodeKind.SwitchExpr: {
        const subjectType =
          e.subject !== null && this.tvOf(e.subject).type.kind === TypeKind.Na
            ? (e.arms
                .map(arm =>
                  arm.pattern !== null ? this.tvOf(arm.pattern).type : null,
                )
                .find(
                  (type): type is Type =>
                    type !== null && type.kind !== TypeKind.Na,
                ) ?? null)
            : e.subject !== null
              ? this.tvOf(e.subject).type
              : null;
        const arms: SwitchArm[] = e.arms.map(arm => ({
          pattern:
            arm.pattern !== null
              ? this.nodeExpr(
                  arm.pattern,
                  e.subject === null ? BoolType : subjectType,
                )
              : null,
          body: this.blockify(arm.body, tv.type),
        }));
        return {
          kind: IrKind.SwitchExpr,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          subject:
            e.subject !== null ? this.nodeExpr(e.subject, subjectType) : null,
          arms,
        };
      }
      case NodeKind.BadExpr:
        return fatal('Bad expression reached the noder past the check barrier');
    }
  }

  // A Name or Selector read: ambient series, param/output reference
  // bindings, UDT fields, or a plain name read.
  private nodePlaceRead(
    e: syntax.Name | syntax.SelectorExpr,
    tv: TypeAndValue,
  ): IrExpr {
    const series = this.tables.ambient.get(e);
    if (series !== undefined) {
      const place: Place = {kind: PlaceKind.Series, series};
      return {
        kind: IrKind.HistRead,
        pos: e.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        place,
        offset: null,
      };
    }
    if (e.kind === NodeKind.Name) {
      const name = this.tables.uses.get(e);
      if (name === undefined) {
        return fatal(`unresolved name reached the noder: ${e.value}`);
      }
      const param = this.paramRefs.get(name);
      if (param !== undefined) {
        return {
          kind: IrKind.HistRead,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          place: {kind: PlaceKind.Param, param},
          offset: null,
        };
      }
      const output = this.outputRefs.get(name);
      if (output !== undefined) {
        return {
          kind: IrKind.OutputRef,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          output,
        };
      }
      const alias = this.aliasRefs.get(name);
      if (alias !== undefined) {
        return {
          kind: IrKind.HistRead,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          place: alias,
          offset: null,
        };
      }
      return this.read(name, e.pos);
    }
    // A selector that is not ambient and not folded is a UDT field read.
    return {
      kind: IrKind.FieldGet,
      pos: e.pos,
      type: tv.type,
      qualifier: tv.qualifier,
      x: this.nodeExpr(e.x),
      field: e.sel.value,
    };
  }

  private nodeCall(c: syntax.CallExpr, tv: TypeAndValue): IrExpr {
    const constructed = this.tables.news.get(c);
    if (constructed !== undefined) {
      const defaults = this.info.udtDefaults.get(constructed.udt);
      const args = constructed.udt.fields.map((field, i) => {
        const provided = constructed.args[i];
        if (provided !== null) {
          return this.nodeExpr(provided, field.type);
        }
        const fallback = defaults?.get(field.name);
        // The checker required an argument when no default exists.
        return fallback !== undefined
          ? this.nodeExpr(fallback, field.type)
          : this.naConst(c.pos, field.type);
      });
      return {
        kind: IrKind.NewUdt,
        pos: c.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        udt: constructed.udt,
        args,
      };
    }
    const userCall = this.tables.userCalls.get(c);
    if (userCall !== undefined) {
      const func = this.funcOf(userCall.instance);
      const args = userCall.instance.params.map((param, i) => {
        const provided = userCall.args[i];
        if (provided !== null) {
          return this.nodeExpr(provided, param.type);
        }
        return this.nodeInstanceDefault(userCall.instance, i, param.type);
      });
      return {
        kind: IrKind.CallFunc,
        pos: c.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        func,
        slot: this.mintSlot(),
        args,
      };
    }
    const resolved = this.tables.calls.get(c);
    if (resolved === undefined) {
      return fatal('unresolved call reached the noder');
    }
    switch (resolved.native.effect) {
      case Effect.Param: {
        const param = this.ensureParam(c, resolved, null);
        return {
          kind: IrKind.HistRead,
          pos: c.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          place: {kind: PlaceKind.Param, param},
          offset: null,
        };
      }
      case Effect.Output:
        return this.nodeOutputCall(c, resolved);
      case Effect.Request:
        return this.nodeRequest(c, resolved, tv);
      case Effect.Declaration:
        return fatal(
          'declaration call in expression position reached the noder',
        );
      default: {
        // Provided args in param order; omitted middles become na, omitted
        // trailing optionals are dropped (the runtime applies defaults).
        const provided = [...resolved.args];
        while (provided.length > 0 && provided[provided.length - 1] === null) {
          provided.pop();
        }
        return {
          kind: IrKind.CallNative,
          pos: c.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          native: resolved.native.name,
          slot: null,
          args: provided.map((arg, i) =>
            arg !== null
              ? this.nodeExpr(
                  arg,
                  this.nativeExpectedType(
                    resolved.native.params[
                      Math.min(i, resolved.native.params.length - 1)
                    ],
                    tv.type,
                    resolved.native.name,
                  ),
                )
              : this.naConst(
                  c.pos,
                  this.nativeExpectedType(
                    resolved.native.params[
                      Math.min(i, resolved.native.params.length - 1)
                    ],
                    tv.type,
                    resolved.native.name,
                  ) ?? FloatType,
                ),
          ),
        };
      }
    }
  }

  // `x[k]`: history through a readable place, or the synthetic-slot policy
  // for history on a computed expression — the slot is written
  // unconditionally every bar, which is what keeps its history well-defined,
  // so the desugaring exists only at the top level.
  private nodeHistory(e: syntax.HistoryExpr, tv: TypeAndValue): IrExpr {
    const offset = this.nodeExpr(e.offset, IntType);
    const x = this.nodeExpr(e.x, tv.type);
    // e[0] IS e: the current-bar value, whatever the expression.
    if (offset.kind === IrKind.Const && offset.value === 0) {
      return x;
    }
    if (
      x.kind === IrKind.HistRead &&
      x.offset === null &&
      // A dynamic request read cannot collapse into an offset read — the
      // offset-0 read is its execution; history desugars through the
      // synthetic per-row name below.
      !(x.place.kind === PlaceKind.Request && x.place.request.dynamic)
    ) {
      return {
        kind: IrKind.HistRead,
        pos: e.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        place: x.place,
        offset,
      };
    }
    if (this.nesting > 0) {
      this.errors.errorAt(
        e.pos,
        'history on an expression is only supported at the top level of the script',
      );
      return x;
    }
    const xTv = this.tvOf(e.x);
    const synthetic: IrName = {
      name: `$hist@${e.pos.line}:${e.pos.col}`,
      storage: Storage.PerBar,
      type: xTv.type,
      qualifier: Qualifier.Series,
      depth: {kind: DepthKind.None},
      init: null,
    };
    this.hoisted.push({
      kind: IrKind.WriteName,
      pos: e.pos,
      name: synthetic,
      value: x,
    });
    return {
      kind: IrKind.HistRead,
      pos: e.pos,
      type: tv.type,
      qualifier: tv.qualifier,
      place: {kind: PlaceKind.Name, name: synthetic},
      offset,
    };
  }

  private nodeIf(e: syntax.IfExpr, tv: TypeAndValue): IrExpr {
    let elseBlock: BlockExpr | null = null;
    if (e.else !== null) {
      elseBlock =
        e.else.kind === NodeKind.IfExpr
          ? this.blockify(e.else, tv.type)
          : this.nodeBlock(e.else, tv.type);
    }
    return {
      kind: IrKind.IfExpr,
      pos: e.pos,
      type: tv.type,
      qualifier: tv.qualifier,
      cond: this.nodeExpr(e.cond),
      then: this.nodeBlock(e.then, tv.type),
      else: elseBlock,
    };
  }

  // An expression in block position (switch arm bodies, else-if chains)
  // wraps into a value-only BlockExpr.
  private blockify(
    e: syntax.Expr | syntax.Block,
    expectedType: Type | null = null,
  ): BlockExpr {
    if (e.kind === NodeKind.Block) {
      return this.nodeBlock(e, expectedType);
    }
    const value = this.nodeExpr(e, expectedType);
    return {
      kind: IrKind.BlockExpr,
      pos: e.pos,
      type: value.type,
      qualifier: value.qualifier,
      stmts: [],
      value,
    };
  }

  private nodeBlock(
    b: syntax.Block,
    expectedType: Type | null = null,
  ): BlockExpr {
    this.nesting += 1;
    const stmts: IrStmt[] = [];
    let value: IrExpr | null = null;
    for (const [i, stmt] of b.stmtList.entries()) {
      if (i < b.stmtList.length - 1) {
        stmts.push(...this.nodeStmt(stmt));
        continue;
      }
      // The last statement supplies the block's value when it has one.
      if (
        stmt.kind === NodeKind.ExprStmt &&
        this.tvOf(stmt.x).type.kind !== TypeKind.Void
      ) {
        value = this.nodeExpr(stmt.x, expectedType);
        continue;
      }
      stmts.push(...this.nodeStmt(stmt));
      value = this.lastStmtValue(stmt, expectedType);
    }
    this.nesting -= 1;
    return {
      kind: IrKind.BlockExpr,
      pos: b.pos,
      type: value !== null ? value.type : VoidType,
      qualifier: value !== null ? value.qualifier : Qualifier.Const,
      stmts,
      value,
    };
  }

  // The value a declaration or assignment yields when it closes a block.
  private lastStmtValue(
    stmt: syntax.Stmt,
    expectedType: Type | null,
  ): IrExpr | null {
    if (stmt.kind === NodeKind.DeclStmt && stmt.target.kind === NodeKind.Name) {
      const tv = this.tvOf(stmt.init);
      if (tv.value !== null) {
        return {
          kind: IrKind.Const,
          pos: stmt.init.pos,
          type:
            tv.type.kind === TypeKind.Na && expectedType !== null
              ? expectedType
              : tv.type,
          qualifier: tv.qualifier,
          value: tv.value,
        };
      }
      const name = this.tables.defs.get(stmt.target);
      return name !== undefined ? this.read(name, stmt.pos) : null;
    }
    if (
      stmt.kind === NodeKind.AssignStmt &&
      stmt.target.kind === NodeKind.Name
    ) {
      const name = this.tables.uses.get(stmt.target);
      return name !== undefined ? this.read(name, stmt.pos) : null;
    }
    return null;
  }

  // ---- requests -------------------------------------------------------------

  // A request.* call site: the captured expression compiles into a CHILD
  // Program — its own context, frame, slots, and request list — whose
  // designated result the runtime merges onto the parent axis. The call
  // itself becomes a read of the request place.
  private nodeRequest(
    c: syntax.CallExpr,
    resolved: ResolvedCall,
    tv: TypeAndValue,
  ): IrExpr {
    const existing = this.requestMemo().get(c);
    if (existing !== undefined) {
      return this.requestRead(c, existing, tv);
    }
    const capture = this.info.captures.get(c);
    if (capture === undefined) {
      return fatal('request call reached the noder without a capture');
    }
    const argExpr = (paramName: string): syntax.Expr | null => {
      const index = resolved.native.params.findIndex(p => p.name === paramName);
      return index === -1 ? null : (resolved.args[index] ?? null);
    };
    const argValue = (paramName: string): ConstValue | null => {
      const expr = argExpr(paramName);
      return expr !== null ? this.tvOf(expr).value : null;
    };
    const captureIndex = resolved.native.params.findIndex(p => p.capture);
    const captureExpr = resolved.args[captureIndex];
    const symbolExpr = argExpr('symbol');
    const timeframeExpr = argExpr('timeframe');
    if (
      captureExpr === null ||
      captureExpr === undefined ||
      symbolExpr === null ||
      timeframeExpr === null
    ) {
      return fatal('request call matched without its required arguments');
    }

    // Parent-context pieces first.
    const symbol = this.nodeExpr(symbolExpr, this.tvOf(symbolExpr).type);
    const timeframe = this.nodeExpr(
      timeframeExpr,
      this.tvOf(timeframeExpr).type,
    );
    const calcBars = argExpr('calc_bars_count');
    const currency = argValue('currency');
    const merge: MergePolicy = {
      mode: MergeMode.Sample,
      gaps: argValue('gaps') === true,
      lookahead: argValue('lookahead') === true,
      ignoreInvalidSymbol: argValue('ignore_invalid_symbol') === true,
      currency: typeof currency === 'string' ? currency : null,
      calcBarsCount:
        calcBars !== null
          ? this.nodeExpr(calcBars, this.tvOf(calcBars).type)
          : null,
    };

    // The child context: the capture's side tables, a fresh frame and
    // request level. History-on-expression synthesis stays disabled inside
    // (nesting), exactly as in function bodies.
    const resultName: IrName = {
      name: '$result',
      storage: Storage.PerBar,
      type: capture.resultType,
      qualifier: Qualifier.Series,
      depth: {kind: DepthKind.None},
      init: null,
    };
    const savedTables = this.tables;
    this.tables = capture.tables;
    this.slots.push(0);
    this.requestLevels.push([]);
    this.nesting += 1;
    const childValue = this.nodeExpr(captureExpr, capture.resultType);
    this.nesting -= 1;
    const childRequests = this.requestLevels.pop();
    this.slots.pop();
    this.tables = savedTables;

    const child: Program = {
      version: this.version,
      // Bind-time params are compilation-global: a child references the
      // parent's ParamInput objects directly and declares none of its own.
      params: [],
      requests: childRequests ?? [],
      outputs: [],
      init: [],
      body: [
        {
          kind: IrKind.WriteName,
          pos: captureExpr.pos,
          name: resultName,
          value: childValue,
        },
      ],
    };
    resolveDepths(child);

    // In the program frame, input-qualified context expressions may use
    // ordinary aliases and pure UDFs because module.bind owns a real root
    // frame. Inside function/capture frames, only frame-free expressions are
    // safe to evaluate independently; local parameters must stay dynamic.
    const staticAtBind = (expr: IrExpr): boolean =>
      this.requestContextBindEvaluable(expr);
    const edge: RequestEdge = {
      pos: c.pos,
      symbol,
      timeframe,
      merge,
      resultName,
      resultType: capture.resultType,
      dynamic: !staticAtBind(symbol) || !staticAtBind(timeframe),
      depth: {kind: DepthKind.None},
      child,
    };
    this.requestLevels[this.requestLevels.length - 1].push(edge);
    this.requestMemo().set(c, edge);
    return this.requestRead(c, edge, tv);
  }

  private requestMemo(): Map<syntax.CallExpr, RequestEdge> {
    let memo = this.requestOf.get(this.tables);
    if (memo === undefined) {
      memo = new Map();
      this.requestOf.set(this.tables, memo);
    }
    return memo;
  }

  // A dynamic edge's offset-0 read is its EXECUTION (rt.requestFor), so
  // reads must materialize where the call appears: no alias binding, no
  // history collapse onto the place — history rides a real per-row Name.
  private requestRead(
    c: syntax.CallExpr,
    edge: RequestEdge,
    tv: TypeAndValue,
  ): HistReadExpr {
    return {
      kind: IrKind.HistRead,
      pos: c.pos,
      type: tv.type,
      qualifier: tv.qualifier,
      place: {kind: PlaceKind.Request, request: edge},
      offset: null,
    };
  }

  private requestContextBindEvaluable(expr: IrExpr): boolean {
    if (bindEvaluable(expr)) {
      return true;
    }
    if (!qualifierLE(expr.qualifier, Qualifier.Input)) {
      return false;
    }
    // A call site in the program frame can run against the provisional root
    // frame during module.bind; the checker's aggregate UDF qualifier proves
    // it contains no hidden series/request work.
    if (this.slots.length === 1) {
      return true;
    }
    const frameNames = this.functionFrameNames.at(-1);
    if (frameNames === undefined) {
      // We are inside a request capture, not a user-function frame. Only the
      // frame-free cases accepted above are independently bind-evaluable.
      return false;
    }
    return rootNameBindEvaluable(expr, frameNames);
  }

  // ---- function stencils ----------------------------------------------------

  // One IrFunc per checker instance: the body nodes once against the
  // instance's side tables, under its own frame-local slot counter (each
  // CallFunc inside selects a sub-frame of THIS func's frame). Recursion
  // cannot occur — the checker rejected cyclic call graphs.
  private funcOf(instance: FuncInstance): IrFunc {
    const existing = this.instanceFuncs.get(instance);
    if (existing !== undefined) {
      return existing;
    }
    const savedTables = this.tables;
    const savedNesting = this.nesting;
    this.tables = instance.tables;
    const paramSet = new Set(instance.params);
    const locals = [...new Set(instance.tables.defs.values())].filter(
      name => !paramSet.has(name),
    );
    this.functionFrameNames.push(new Set([...instance.params, ...locals]));
    this.nesting += 1;
    this.slots.push(0);
    const body =
      instance.template.body.kind === NodeKind.Block
        ? this.nodeBlock(instance.template.body, instance.resultType)
        : this.nodeExpr(instance.template.body, instance.resultType);
    this.slots.pop();
    this.functionFrameNames.pop();
    this.nesting = savedNesting;
    this.tables = savedTables;
    const func: IrFunc = {
      name: instance.name,
      params: instance.params,
      locals,
      resultType: instance.resultType,
      resultQualifier: instance.resultQualifier,
      body,
    };
    this.instanceFuncs.set(instance, func);
    return func;
  }

  // An omitted argument nodes the instance's default expression — checked in
  // the instance's tables — at the call site. Defaults must not reference
  // sibling params (see AGENTS.md).
  private nodeInstanceDefault(
    instance: FuncInstance,
    index: number,
    expectedType: Type,
  ): IrExpr {
    const dflt = instance.defaults.get(index);
    if (dflt === undefined) {
      return fatal(
        `no default for omitted argument ${index} of '${instance.name}'`,
      );
    }
    const saved = this.tables;
    this.tables = instance.tables;
    const expr = this.nodeExpr(dflt, expectedType);
    this.tables = saved;
    return expr;
  }

  // ---- params and outputs ---------------------------------------------------

  private ensureParam(
    c: syntax.CallExpr,
    resolved: ResolvedCall,
    bindingName: string | null,
  ): ParamInput {
    const existing = this.paramOf.get(c);
    if (existing !== undefined) {
      return existing;
    }
    const argExpr = (paramName: string): syntax.Expr | null => {
      const index = resolved.native.params.findIndex(p => p.name === paramName);
      return index === -1 ? null : (resolved.args[index] ?? null);
    };
    const argValue = (paramName: string): ConstValue | null => {
      const expr = argExpr(paramName);
      return expr !== null ? this.tvOf(expr).value : null;
    };

    let defaultValue: ParamDefault | null = null;
    const defval = argExpr('defval');
    if (defval !== null) {
      const tv = this.tvOf(defval);
      if (tv.value !== null) {
        defaultValue = {kind: ParamDefaultKind.Const, value: tv.value};
      } else {
        const series = this.tables.ambient.get(unwrapExpr(defval));
        if (series !== undefined) {
          defaultValue = {kind: ParamDefaultKind.Series, series};
        } else {
          this.errors.errorAt(
            defval.pos,
            `'${resolved.native.name}' default must be a constant or a built-in source`,
          );
        }
      }
    }

    const minval = argValue('minval');
    const maxval = argValue('maxval');
    const step = argValue('step');
    // The checker guarantees a direct, non-empty, homogeneously typed tuple.
    let options: [ConstValue, ...ConstValue[]] | null = null;
    let optionsExpr = argExpr('options');
    if (optionsExpr !== null) {
      optionsExpr = unwrapExpr(optionsExpr);
      if (optionsExpr.kind !== NodeKind.TupleExpr) {
        return fatal('non-tuple input options reached the noder');
      }
      const values = optionsExpr.elems.map(elem => this.tvOf(elem).value);
      if (
        values.length === 0 ||
        !values.every((v): v is ConstValue => v !== null)
      ) {
        return fatal('invalid input options reached the noder');
      }
      options = values as [ConstValue, ...ConstValue[]];
    }
    const constraints: ParamConstraints | null =
      options !== null
        ? {kind: ParamConstraintKind.Options, options}
        : minval !== null || maxval !== null || step !== null
          ? {kind: ParamConstraintKind.Range, minval, maxval, step}
          : null;

    // input.source's default must be a built-in source: a const number
    // would silently degrade the param to a scalar with control='source'.
    if (
      resolved.native.name === 'input.source' &&
      defaultValue !== null &&
      defaultValue.kind !== ParamDefaultKind.Series
    ) {
      this.errors.errorAt(
        c.pos,
        "'input.source' default must be a built-in source (close, hl2, …)",
      );
    }
    const title = argValue('title');
    const group = argValue('group');
    const inline = argValue('inline');
    const tooltip = argValue('tooltip');
    const confirm = argValue('confirm');
    const display = argValue('display');
    const activeExpr = argExpr('active');
    const defaultDisplay = resolved.native.inputDefaultDisplay;
    if (defaultDisplay === null) {
      return fatal(
        `param native '${resolved.native.name}' has no display default`,
      );
    }
    const localBindingName =
      bindingName !== null && this.nesting > 0 ? bindingName : null;
    const param: ParamInput = {
      // Local declarations can repeat their spelling across lexical scopes,
      // so only a program-scope declaration is a safe host-facing identity.
      name:
        bindingName !== null && this.nesting === 0
          ? bindingName
          : `input@${c.pos.line}:${c.pos.col}`,
      // Preserve Pine's inferred label for a local declaration even though
      // its unique host identity is the call site.
      title: typeof title === 'string' ? title : localBindingName,
      control:
        resolved.native.name === 'input'
          ? 'auto'
          : resolved.native.name.slice('input.'.length),
      type: this.tvOf(c).type,
      defaultValue,
      constraints,
      group: typeof group === 'string' ? group : null,
      inline: typeof inline === 'string' ? inline : null,
      tooltip: typeof tooltip === 'string' ? tooltip : null,
      confirm: confirm === true,
      display:
        typeof display === 'string'
          ? (display as ParamInput['display'])
          : defaultDisplay,
      active:
        activeExpr !== null
          ? this.nodeExpr(activeExpr, BoolType)
          : this.constExpr(c.pos, BoolType, true),
      depth: {kind: DepthKind.None},
    };
    this.params.push(param);
    this.paramOf.set(c, param);
    return param;
  }

  // indicator()/strategy(): script metadata is an emission to the host,
  // modeled as an OutputDecl with the declaration's effect name.
  private nodeDeclarationCall(resolved: ResolvedCall): void {
    this.outputs.push(this.partitionOutput(resolved).output);
  }

  private nodeOutputCall(
    c: syntax.CallExpr,
    resolved: ResolvedCall,
  ): OutputRefExpr {
    const {output, emitArgs} = this.partitionOutput(resolved);
    this.outputs.push(output);
    if (emitArgs.length > 0) {
      this.emitted.push({
        kind: IrKind.Emit,
        pos: c.pos,
        output,
        args: emitArgs,
      });
    }
    const tv = this.tvOf(c);
    return {
      kind: IrKind.OutputRef,
      pos: c.pos,
      type: tv.type,
      qualifier: Qualifier.Const,
      output,
    };
  }

  // Split a declarative call's provided args into the three buckets:
  // compile-time constants (staticArgs), bind-time exprs (bindArgs: at most
  // input-qualified, plus output refs), and per-bar channels fed by Emit.
  private partitionOutput(resolved: ResolvedCall): {
    output: OutputDecl;
    emitArgs: IrExpr[];
  } {
    const staticArgs: {name: string; value: ConstValue}[] = [];
    const bindArgs: {name: string; expr: IrExpr}[] = [];
    const channels: {
      name: string;
      type: OutputDecl['channels'][number]['type'];
    }[] = [];
    const emitArgs: IrExpr[] = [];
    resolved.args.forEach((arg, i) => {
      if (arg === null) {
        return;
      }
      const param =
        resolved.native.params[Math.min(i, resolved.native.params.length - 1)];
      const tv = this.tvOf(arg);
      if (tv.value !== null) {
        staticArgs.push({name: param.name, value: tv.value});
        return;
      }
      const expr = this.nodeExpr(arg, this.nativeExpectedType(param, tv.type));
      if (
        expr.kind === IrKind.OutputRef ||
        qualifierLE(tv.qualifier, Qualifier.Input)
      ) {
        bindArgs.push({name: param.name, expr});
        return;
      }
      channels.push({name: param.name, type: tv.type});
      emitArgs.push(expr);
    });
    return {
      output: {effect: resolved.native.name, staticArgs, bindArgs, channels},
      emitArgs,
    };
  }
}

// A static request nested in a UDF may read compilation-global input aliases
// through rt.root(), but it cannot read the UDF's own params/locals without a
// concrete call-site frame. Keep this deliberately structural: UDF calls and
// control-flow blocks remain dynamic when the request itself is inside a UDF.
function rootNameBindEvaluable(
  expr: IrExpr,
  frameNames: ReadonlySet<IrName>,
): boolean {
  if (bindEvaluable(expr)) {
    return true;
  }
  switch (expr.kind) {
    case IrKind.HistRead:
      return (
        expr.offset === null &&
        expr.place.kind === PlaceKind.Name &&
        !frameNames.has(expr.place.name) &&
        qualifierLE(expr.place.name.qualifier, Qualifier.Input)
      );
    case IrKind.Binary:
      return (
        rootNameBindEvaluable(expr.x, frameNames) &&
        rootNameBindEvaluable(expr.y, frameNames)
      );
    case IrKind.Unary:
      return rootNameBindEvaluable(expr.x, frameNames);
    case IrKind.Cond:
      return (
        rootNameBindEvaluable(expr.cond, frameNames) &&
        rootNameBindEvaluable(expr.then, frameNames) &&
        rootNameBindEvaluable(expr.else, frameNames)
      );
    case IrKind.CallNative:
      return expr.args.every(arg => rootNameBindEvaluable(arg, frameNames));
    default:
      return false;
  }
}

// A call expression possibly wrapped in parens.
function unwrapExpr(e: syntax.Expr): syntax.Expr {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) {
    x = x.x;
  }
  return x;
}

function unwrapCall(e: syntax.Expr): syntax.CallExpr | null {
  const x = unwrapExpr(e);
  return x.kind === NodeKind.CallExpr ? x : null;
}

function mapBinaryOp(op: Op): IrBinaryOp {
  const mapped = BINARY_OP_MAP[op];
  if (mapped === undefined) {
    return fatal(`unmapped binary operator reached the noder: ${op}`);
  }
  return mapped;
}
