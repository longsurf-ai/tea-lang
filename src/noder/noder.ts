// Purpose: Noder — loadPackage() parses the package's source files; buildProgram() turns checked syntax plus the checker's Info into the Tea Program (desugaring compound assigns, tuple patterns, param/output extraction, and history-on-expression).
//
// The noder consumes checked, error-free syntax and never re-checks: every
// type and qualifier comes from Info side tables, every use resolves through
// Info.uses/defs/ambient to the binder's shared ir objects. Bad nodes or
// missing table entries here mean the phase barrier was violated — fatal.

import {readFileSync} from 'node:fs';
import {newFileBase, type Pos} from '../base/pos';
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
  NaType,
  NA_VALUE,
  Qualifier,
  qualifierLE,
  TypeKind,
  VoidType,
  joinQualifiers,
  type ConstValue,
  type TypeAndValue,
} from '../ir/type';
import {Mode, NodeKind} from '../syntax/nodes';
import type * as syntax from '../syntax/nodes';
import {parse} from '../syntax/syntax';
import type {Op} from '../syntax/tokens';
import {Effect} from '../typecheck/catalog';
import type {
  FuncInstance,
  Info,
  ResolvedCall,
  SideTables,
} from '../typecheck/check';
import {resolveDepths} from './depth';

// Frontend orchestrator: one parse per file.
export function loadPackage(
  filenames: readonly string[],
  errors: Errors,
): syntax.File[] {
  return filenames.map(filename =>
    parse(newFileBase(filename), readFileSync(filename, 'utf8'), (pos, msg) =>
      errors.errorAt(pos, msg),
    ),
  );
}

// Build the Program from checked syntax ("noding"). Requires a clean check —
// compile()'s phase barrier guarantees it.
export function buildProgram(
  file: syntax.File,
  info: Info,
  errors: Errors,
): Program {
  return new Noder(info, errors).build(file);
}

const BINARY_OP_MAP: Record<string, IrBinaryOp> = {
  or: IrOp.Or,
  and: IrOp.And,
  '==': IrOp.Eq,
  '!=': IrOp.Ne,
  '<': IrOp.Lt,
  '<=': IrOp.Le,
  '>': IrOp.Gt,
  '>=': IrOp.Ge,
  '+': IrOp.Add,
  '-': IrOp.Sub,
  '*': IrOp.Mul,
  '/': IrOp.Div,
  '%': IrOp.Mod,
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
  // Frame-local slot counters: the program frame at the bottom, one counter
  // per IrFunc body being noded. Every call site mints the next slot of the
  // frame it sits in — the sub-frame selector within that frame.
  private readonly slots: number[] = [0];
  // Request edges per Program level: the parent's list at the bottom, one
  // pushed per child capture being noded (nested requests belong to the
  // child).
  private readonly requestLevels: RequestEdge[][] = [[]];
  private readonly requestOf = new Map<syntax.CallExpr, RequestEdge>();
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
    return program;
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

  private naConst(pos: Pos): IrExpr {
    return {
      kind: IrKind.Const,
      pos,
      type: NaType,
      qualifier: Qualifier.Const,
      value: NA_VALUE,
    };
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
    const rebindable = !this.info.reassigned.has(name.name);

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

    const init = this.nodeExpr(d.init);

    // `p = plot(...)` (or an alias of it) binds the name to the output
    // declaration: refs resolve at init time, never per bar.
    if (init.kind === IrKind.OutputRef && rebindable && d.mode === Mode.None) {
      this.outputRefs.set(name, init.output);
      return [];
    }

    if (
      init.kind === IrKind.HistRead &&
      init.offset === null &&
      init.place.kind !== PlaceKind.Name &&
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
        value: this.nodeExpr(d.init),
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
    const value = this.nodeExpr(a.value);
    if (a.target.kind === NodeKind.Name) {
      const name = this.tables.uses.get(a.target);
      if (name === undefined) {
        return fatal(
          `unresolved assign target reached the noder: ${a.target.value}`,
        );
      }
      const written =
        a.op === ':='
          ? value
          : ({
              kind: IrKind.Binary,
              pos: a.pos,
              type: name.type,
              qualifier: joinQualifiers(name.qualifier, value.qualifier),
              op: BINARY_OP_MAP[a.op[0]],
              x: this.read(name, a.pos),
              y: value,
            } as const);
      return [{kind: IrKind.WriteName, pos: a.pos, name, value: written}];
    }
    if (a.target.kind === NodeKind.SelectorExpr) {
      return [
        {
          kind: IrKind.WriteField,
          pos: a.pos,
          x: this.nodeExpr(a.target.x),
          field: a.target.sel.value,
          value,
        },
      ];
    }
    return fatal('invalid assignment target reached the noder');
  }

  // ---- expressions ----------------------------------------------------------

  private nodeExpr(e: syntax.Expr): IrExpr {
    const tv = this.tvOf(e);
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
        if (e.op === '+') {
          return this.nodeExpr(e.x);
        }
        const op: IrUnaryOp = e.op === '-' ? IrOp.Neg : IrOp.Not;
        return {
          kind: IrKind.Unary,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          op,
          x: this.nodeExpr(e.x),
        };
      }
      case NodeKind.BinaryExpr:
        return {
          kind: IrKind.Binary,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          op: mapBinaryOp(e.op),
          x: this.nodeExpr(e.x),
          y: this.nodeExpr(e.y),
        };
      case NodeKind.CondExpr:
        return {
          kind: IrKind.Cond,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          cond: this.nodeExpr(e.cond),
          then: this.nodeExpr(e.then),
          else: this.nodeExpr(e.else),
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
          elems: e.elems.map(elem => this.nodeExpr(elem)),
        };
      case NodeKind.ParenExpr:
        return this.nodeExpr(e.x);
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
          from: this.nodeExpr(e.from),
          to: this.nodeExpr(e.to),
          step: e.step !== null ? this.nodeExpr(e.step) : null,
          body: this.nodeBlock(e.body),
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
          body: this.nodeBlock(e.body),
        };
      }
      case NodeKind.WhileExpr:
        return {
          kind: IrKind.WhileExpr,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          cond: this.nodeExpr(e.cond),
          body: this.nodeBlock(e.body),
        };
      case NodeKind.SwitchExpr: {
        const arms: SwitchArm[] = e.arms.map(arm => ({
          pattern: arm.pattern !== null ? this.nodeExpr(arm.pattern) : null,
          body: this.blockify(arm.body),
        }));
        return {
          kind: IrKind.SwitchExpr,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          subject: e.subject !== null ? this.nodeExpr(e.subject) : null,
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
          return this.nodeExpr(provided);
        }
        const fallback = defaults?.get(field.name);
        // The checker required an argument when no default exists.
        return fallback !== undefined
          ? this.nodeExpr(fallback)
          : this.naConst(c.pos);
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
      const args = userCall.instance.params.map((_, i) => {
        const provided = userCall.args[i];
        if (provided !== null) {
          return this.nodeExpr(provided);
        }
        return this.nodeInstanceDefault(userCall.instance, i);
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
          args: provided.map(arg =>
            arg !== null ? this.nodeExpr(arg) : this.naConst(c.pos),
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
    const offset = this.nodeExpr(e.offset);
    const x = this.nodeExpr(e.x);
    if (x.kind === IrKind.HistRead && x.offset === null) {
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
          ? this.blockify(e.else)
          : this.nodeBlock(e.else);
    }
    return {
      kind: IrKind.IfExpr,
      pos: e.pos,
      type: tv.type,
      qualifier: tv.qualifier,
      cond: this.nodeExpr(e.cond),
      then: this.nodeBlock(e.then),
      else: elseBlock,
    };
  }

  // An expression in block position (switch arm bodies, else-if chains)
  // wraps into a value-only BlockExpr.
  private blockify(e: syntax.Expr | syntax.Block): BlockExpr {
    if (e.kind === NodeKind.Block) {
      return this.nodeBlock(e);
    }
    const value = this.nodeExpr(e);
    return {
      kind: IrKind.BlockExpr,
      pos: e.pos,
      type: value.type,
      qualifier: value.qualifier,
      stmts: [],
      value,
    };
  }

  private nodeBlock(b: syntax.Block): BlockExpr {
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
        value = this.nodeExpr(stmt.x);
        continue;
      }
      stmts.push(...this.nodeStmt(stmt));
      value = this.lastStmtValue(stmt);
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
  private lastStmtValue(stmt: syntax.Stmt): IrExpr | null {
    if (stmt.kind === NodeKind.DeclStmt && stmt.target.kind === NodeKind.Name) {
      const tv = this.tvOf(stmt.init);
      if (tv.value !== null) {
        return {
          kind: IrKind.Const,
          pos: stmt.init.pos,
          type: tv.type,
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
    const existing = this.requestOf.get(c);
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
    if (captureExpr == null || symbolExpr === null || timeframeExpr === null) {
      return fatal('request call matched without its required arguments');
    }

    // Parent-context pieces first.
    const symbol = this.nodeExpr(symbolExpr);
    const timeframe = this.nodeExpr(timeframeExpr);
    const calcBars = argExpr('calc_bars_count');
    const currency = argValue('currency');
    const merge: MergePolicy = {
      mode: MergeMode.Sample,
      gaps: argValue('gaps') === true,
      lookahead: argValue('lookahead') === true,
      ignoreInvalidSymbol: argValue('ignore_invalid_symbol') === true,
      currency: typeof currency === 'string' ? currency : null,
      calcBarsCount: calcBars !== null ? this.nodeExpr(calcBars) : null,
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
    const childValue = this.nodeExpr(captureExpr);
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

    const edge: RequestEdge = {
      symbol,
      timeframe,
      merge,
      resultName,
      resultType: capture.resultType,
      depth: {kind: DepthKind.None},
      child,
    };
    this.requestLevels[this.requestLevels.length - 1].push(edge);
    this.requestOf.set(c, edge);
    return this.requestRead(c, edge, tv);
  }

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
    this.nesting += 1;
    this.slots.push(0);
    const body =
      instance.template.body.kind === NodeKind.Block
        ? this.nodeBlock(instance.template.body)
        : this.nodeExpr(instance.template.body);
    this.slots.pop();
    this.nesting = savedNesting;
    this.tables = savedTables;
    const func: IrFunc = {
      name: instance.name,
      params: instance.params,
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
  private nodeInstanceDefault(instance: FuncInstance, index: number): IrExpr {
    const dflt = instance.defaults.get(index);
    if (dflt === undefined) {
      return fatal(
        `no default for omitted argument ${index} of '${instance.name}'`,
      );
    }
    const saved = this.tables;
    this.tables = instance.tables;
    const expr = this.nodeExpr(dflt);
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
        const series = this.tables.ambient.get(defval);
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
    const constraints: ParamConstraints | null =
      minval !== null || maxval !== null || step !== null
        ? {minval, maxval, step, options: null}
        : null;

    const title = argValue('title');
    const param: ParamInput = {
      name: bindingName ?? `input@${c.pos.line}:${c.pos.col}`,
      title: typeof title === 'string' ? title : null,
      type: resolved.native.result,
      defaultValue,
      constraints,
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
  // compile-time constants (staticArgs), init-time exprs (bindArgs: at most
  // simple-qualified, plus output refs), and per-bar channels fed by Emit.
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
      const expr = this.nodeExpr(arg);
      if (
        expr.kind === IrKind.OutputRef ||
        qualifierLE(tv.qualifier, Qualifier.Simple)
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

// A call expression possibly wrapped in parens.
function unwrapCall(e: syntax.Expr): syntax.CallExpr | null {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) {
    x = x.x;
  }
  return x.kind === NodeKind.CallExpr ? x : null;
}

function mapBinaryOp(op: Op): IrBinaryOp {
  const mapped = BINARY_OP_MAP[op];
  if (mapped === undefined) {
    return fatal(`unmapped binary operator reached the noder: ${op}`);
  }
  return mapped;
}
