// Purpose: Variable binding prepass — creates canonical semantic VariableObjects and resolves whole-context reassignment facts by lexical identity before checking.

import {fatal} from '../base/print';
import {Storage, InvalidType, Qualifier} from '../ir/type';
import {Mode, NodeKind} from '../syntax/nodes';
import type * as syntax from '../syntax/nodes';
import {ObjectKind, type Object, type VariableObject} from './object';
import {Scope} from './scope';

export interface BindingTables {
  readonly defs: Map<syntax.Name, Object>;
  readonly uses: Map<syntax.Name | syntax.ThisExpr, Object>;
  readonly reassigned: Set<VariableObject>;
}

// @agent invariant: Text names are lookup keys only. Every declaration and
// reassignment fact uses the canonical semantic VariableObject, so shadowed
// bindings can never affect one another.
export function bindFileNames(
  file: syntax.File,
  base: Scope,
  tables: BindingTables,
): void {
  new NameBinder(base, tables).bindStmts(file.stmtList);
}

export function bindFunctionNames(
  decl: syntax.FuncDecl | syntax.MethodDecl,
  args: readonly (syntax.Expr | null)[],
  base: Scope,
  tables: BindingTables,
  invalidDefaults: ReadonlySet<number> = new Set(),
): void {
  new NameBinder(base, tables).bindFunc(decl, args, invalidDefaults);
}

export function bindExpressionNames(
  expr: syntax.Expr,
  base: Scope,
  tables: BindingTables,
): void {
  new NameBinder(base, tables).bindExpr(expr);
}

class NameBinder {
  private scope: Scope;

  constructor(
    base: Scope,
    private readonly tables: BindingTables,
  ) {
    // Binding must not populate the semantic scope before source-order
    // checking. The temporary child holds only canonical variable objects.
    // This prepass needs lexical lookup but does not own the semantic scope
    // tree recorded by the checker.
    this.scope = new Scope(base, false);
  }

  bindFunc(
    decl: syntax.FuncDecl | syntax.MethodDecl,
    args: readonly (syntax.Expr | null)[],
    invalidDefaults: ReadonlySet<number>,
  ): void {
    decl.params.forEach((param, i) => {
      if (
        param.defaultValue !== null &&
        !invalidDefaults.has(i) &&
        (decl.kind === NodeKind.MethodDecl || args[i] === null)
      ) {
        this.bindExpr(param.defaultValue);
      }
      this.declare(param.name, Storage.PerBar, false);
    });
    if (decl.body.kind === NodeKind.Block) {
      this.bindBlock(decl.body);
      return;
    }
    this.bindExpr(decl.body);
  }

  bindStmts(stmts: readonly syntax.Stmt[]): void {
    for (const stmt of stmts) {
      this.bindStmt(stmt);
    }
  }

  bindExpr(expr: syntax.Expr): void {
    switch (expr.kind) {
      case NodeKind.Name:
      case NodeKind.BasicLit:
      case NodeKind.ThisExpr:
      case NodeKind.BadExpr:
        return;
      case NodeKind.UnaryExpr:
      case NodeKind.ParenExpr:
        this.bindExpr(expr.x);
        return;
      case NodeKind.SelectorExpr:
        this.bindExpr(expr.x);
        return;
      case NodeKind.BinaryExpr:
        this.bindExpr(expr.x);
        this.bindExpr(expr.y);
        return;
      case NodeKind.CondExpr:
        this.bindExpr(expr.cond);
        this.bindExpr(expr.then);
        this.bindExpr(expr.else);
        return;
      case NodeKind.CallExpr:
        for (const arg of expr.args) {
          this.bindExpr(arg.value);
        }
        return;
      case NodeKind.HistoryExpr:
        this.bindExpr(expr.x);
        this.bindExpr(expr.offset);
        return;
      case NodeKind.TupleExpr:
        for (const elem of expr.elems) {
          this.bindExpr(elem);
        }
        return;
      case NodeKind.IfExpr:
        this.bindExpr(expr.cond);
        this.bindBlock(expr.then);
        if (expr.else === null) {
          return;
        }
        if (expr.else.kind === NodeKind.IfExpr) {
          this.bindExpr(expr.else);
          return;
        }
        this.bindBlock(expr.else);
        return;
      case NodeKind.ForExpr: {
        this.bindExpr(expr.from);
        this.bindExpr(expr.to);
        if (expr.step !== null) {
          this.bindExpr(expr.step);
        }
        const saved = this.scope;
        this.scope = new Scope(saved);
        this.declare(expr.index, Storage.PerBar, false);
        this.bindBlock(expr.body);
        this.scope = saved;
        return;
      }
      case NodeKind.ForInExpr: {
        this.bindExpr(expr.x);
        const saved = this.scope;
        this.scope = new Scope(saved);
        if (expr.target.kind === NodeKind.Name) {
          this.declare(expr.target, Storage.PerBar, false);
        } else if (expr.target.elems.length === 2) {
          for (const elem of expr.target.elems) {
            this.declare(elem, Storage.PerBar, false);
          }
        }
        this.bindBlock(expr.body);
        this.scope = saved;
        return;
      }
      case NodeKind.WhileExpr:
        this.bindExpr(expr.cond);
        this.bindBlock(expr.body);
        return;
      case NodeKind.SwitchExpr:
        if (expr.subject !== null) {
          this.bindExpr(expr.subject);
        }
        for (const arm of expr.arms) {
          if (arm.pattern !== null) {
            this.bindExpr(arm.pattern);
          }
          if (arm.body.kind === NodeKind.Block) {
            this.bindBlock(arm.body);
          } else {
            this.bindExpr(arm.body);
          }
        }
        return;
    }
  }

  private bindStmt(stmt: syntax.Stmt): void {
    switch (stmt.kind) {
      case NodeKind.ExprStmt:
        this.bindExpr(stmt.x);
        return;
      case NodeKind.EmitStmt:
        this.bindExpr(stmt.name);
        this.bindExpr(stmt.value);
        return;
      case NodeKind.ReturnStmt:
        if (stmt.value !== null) this.bindExpr(stmt.value);
        return;
      case NodeKind.DeclStmt:
        this.bindExpr(stmt.init);
        if (stmt.target.kind === NodeKind.Name) {
          this.declare(
            stmt.target,
            declarationStorage(stmt.mode),
            stmt.mode === Mode.Const,
          );
          return;
        }
        for (const elem of stmt.target.elems) {
          this.declare(
            elem,
            declarationStorage(stmt.mode),
            stmt.mode === Mode.Const,
          );
        }
        return;
      case NodeKind.AssignStmt: {
        const target = unwrapParens(stmt.target);
        if (target.kind === NodeKind.Name) {
          const entry = this.scope.lookup(target.value);
          if (entry?.kind === ObjectKind.Variable) {
            this.tables.uses.set(target, entry);
            this.tables.reassigned.add(entry);
          }
        }
        this.bindExpr(stmt.target);
        this.bindExpr(stmt.value);
        return;
      }
      case NodeKind.FuncDecl:
        // Templates own fresh binding tables per concrete instantiation.
        return;
      case NodeKind.InterfaceDecl:
        // Interfaces contain signatures only; there are no value names or
        // executable defaults for the lexical binder to visit.
        return;
      case NodeKind.StructDecl:
        for (const member of stmt.members) {
          if (
            member.kind === NodeKind.FieldDecl &&
            member.defaultValue !== null
          ) {
            this.bindExpr(member.defaultValue);
          }
        }
        return;
      case NodeKind.TypeAliasDecl:
        return;
      case NodeKind.EnumDecl:
        for (const member of stmt.members) {
          if (member.title !== null) {
            this.bindExpr(member.title);
          }
        }
        return;
      case NodeKind.ImportStmt:
      case NodeKind.BreakStmt:
      case NodeKind.ContinueStmt:
      case NodeKind.BadStmt:
        return;
    }
  }

  private bindBlock(block: syntax.Block): void {
    const saved = this.scope;
    this.scope = new Scope(saved);
    this.bindStmts(block.stmtList);
    this.scope = saved;
  }

  private declare(
    node: syntax.Name,
    storage: Storage,
    constDecl: boolean,
  ): void {
    if (this.tables.defs.has(node)) {
      return fatal(`declaration '${node.value}' bound more than once`);
    }
    const object: VariableObject = {
      kind: ObjectKind.Variable,
      name: node.value,
      storage,
      type: InvalidType,
      qualifier: Qualifier.Const,
      constDecl,
      packageGlobal: null,
      constValue: null,
    };
    this.tables.defs.set(node, object);
    this.scope.declare(object);
  }
}

function unwrapParens(expr: syntax.Expr): syntax.Expr {
  let current = expr;
  while (current.kind === NodeKind.ParenExpr) {
    current = current.x;
  }
  return current;
}

function declarationStorage(mode: syntax.DeclMode): Storage {
  if (mode === Mode.Var) {
    return Storage.Var;
  }
  if (mode === Mode.Varip) {
    return Storage.Varip;
  }
  return Storage.PerBar;
}
