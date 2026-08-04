// Purpose: Eager semantic checker over syntax (the types2 shape) — consumes canonical variable bindings, annotates side tables with TypeAndValue, propagates qualifiers (later-known wins), folds constants, and enforces catalog signatures, caps, and placement rules.
//
// Reassignment binding is scope-sensitive and deliberately flow-insensitive:
// a binding written anywhere in one checking context never carries fold values.

import {fatal, type Errors} from '../base/print';
import type {Pos} from '../base/pos';
import {unimplemented} from '../base/unimplemented';
import {DepthKind, type Name as IrName} from '../ir/node';
import type {SeriesInput} from '../ir/program';
import {
  assignable,
  BoolType,
  ColorType,
  FloatType,
  formatType,
  IntType,
  InvalidType,
  isNaValue,
  joinQualifiers,
  LabelType,
  LinefillType,
  LineType,
  BoxType,
  NaType,
  PolylineType,
  qualifierLE,
  Qualifier,
  StringType,
  TableType,
  TupleType,
  TypeKind,
  unifyTypes,
  VoidType,
  type ConstValue,
  type EnumMemberType,
  type EnumType,
  type Type,
  type TypeAndValue,
  type UdtField,
  type UdtType,
} from '../ir/type';
import {ASSIGN_BASE_OP, AssignOp, Mode, NodeKind} from '../syntax/nodes';
import type * as syntax from '../syntax/nodes';
import {LitKind, Op} from '../syntax/tokens';
import {
  Effect,
  isNativeRoot,
  JoinResult,
  nativeFuncs,
  nativeVar,
  TypeRef,
  type NativeFunc,
  type NativeTypeRef,
  type NativeVar,
} from './catalog';
import {isImportError, type Importer, type ResolvedLibrary} from './importer';
import {bindExpressionNames, bindFileNames, bindFunctionNames} from './binding';
import {EntryKind, Scope, type ScopeEntry} from './scope';

// ---- results ----------------------------------------------------------------

export interface ResolvedCall {
  readonly native: NativeFunc;
  // Param-aligned argument exprs; null = omitted optional (native default).
  // For a variadic final param the tail extends past params.length - 1.
  readonly args: readonly (syntax.Expr | null)[];
}

export interface ResolvedNew {
  readonly udt: UdtType;
  // Field-aligned constructor argument exprs; null = omitted (field default).
  readonly args: readonly (syntax.Expr | null)[];
}

// Per-context side tables, keyed by syntax nodes. The main script writes
// into the Info's own tables; each function instantiation gets a fresh set
// (the same body syntax carries different types per signature — Go's
// unified-IR shape), stored on its FuncInstance for the noder.
export interface SideTables {
  readonly types: Map<syntax.Expr, TypeAndValue>;
  // Use sites of script variables → the shared ir Name object.
  readonly uses: Map<syntax.Name, IrName>;
  // Declaration sites → the canonical ir Name created by the binding prepass.
  readonly defs: Map<syntax.Name, IrName>;
  // Whole-context mutability keyed by declaration identity. The binding pass
  // completes this set before semantic checking starts for these tables.
  readonly reassigned: Set<IrName>;
  readonly calls: Map<syntax.CallExpr, ResolvedCall>;
  readonly news: Map<syntax.CallExpr, ResolvedNew>;
  readonly userCalls: Map<syntax.CallExpr, ResolvedUserCall>;
  // Which ambient series a Name/Selector expression resolved to.
  readonly ambient: Map<syntax.Expr, SeriesInput>;
}

export function newSideTables(): SideTables {
  return {
    types: new Map(),
    uses: new Map(),
    defs: new Map(),
    reassigned: new Set(),
    calls: new Map(),
    news: new Map(),
    userCalls: new Map(),
    ambient: new Map(),
  };
}

// One per-signature instantiation of a user or prelude function template —
// a Go-style stencil: after checking, everything is concrete (untyped
// params adopted the argument types), so no dictionaries exist. Shared by
// every call site with the same signature; state stays per call site via
// SlotIds minted at noding.
export interface FuncInstance {
  readonly template: syntax.FuncDecl;
  // Display name: the template name, namespace-qualified for prelude
  // functions ('ta.ema').
  readonly name: string;
  readonly params: readonly IrName[];
  // Param index → default expression for omitted arguments, checked in
  // this instance's tables. Defaults node caller-side and must not
  // reference sibling params.
  readonly defaults: ReadonlyMap<number, syntax.Expr>;
  readonly tables: SideTables;
  // Annotated once the body has been checked.
  resultType: Type;
  resultQualifier: Qualifier;
  // True when the body reads ambient series or outer-scope variables
  // directly (not through params). Such instances are checked against ONE
  // context and cannot be shared into a request's child context.
  touchesContext: boolean;
}

export interface ResolvedUserCall {
  readonly instance: FuncInstance;
  // Param-aligned argument exprs; null = omitted (instance default).
  readonly args: readonly (syntax.Expr | null)[];
}

// A request.* call site's captured expression, checked in a CHILD context:
// its own side tables and its own ambient series pool (close inside the
// expression is the child symbol's close). The noder compiles these tables
// into the child Program.
export interface RequestCapture {
  readonly tables: SideTables;
  readonly resultType: Type;
}

// The checker's results (types2 Info): the noder consumes these and never
// re-checks.
export interface Info extends SideTables {
  readonly captures: Map<syntax.CallExpr, RequestCapture>;
  readonly udtDefaults: Map<UdtType, ReadonlyMap<string, syntax.Expr>>;
  // Ambient context series touched by the script, one object per host id;
  // noded Places reference these objects and the depth pass annotates them.
  readonly series: Map<string, SeriesInput>;
}

export function check(
  file: syntax.File,
  errors: Errors,
  importer: Importer,
): Info {
  const checker = new Checker(errors, importer);
  return checker.checkFile(file);
}

// The pipeline's check stage: one script per compilation for now; libraries
// arrive through the injected Importer, never by the checker's own loading.
export function checkPackage(
  files: readonly syntax.File[],
  errors: Errors,
  importer: Importer,
): Info {
  if (files.length !== 1) {
    return unimplemented('typecheck: multi-file packages', files.length);
  }
  return check(files[0], errors, importer);
}

const INVALID_TV: TypeAndValue = {
  type: InvalidType,
  qualifier: Qualifier.Const,
  value: null,
};

const VOID_TV: TypeAndValue = {
  type: VoidType,
  qualifier: Qualifier.Const,
  value: null,
};

// Type names usable in annotations.
const TYPE_NAMES: ReadonlyMap<string, Type> = new Map([
  ['int', IntType],
  ['float', FloatType],
  ['bool', BoolType],
  ['string', StringType],
  ['color', ColorType],
  ['line', LineType],
  ['label', LabelType],
  ['box', BoxType],
  ['table', TableType],
  ['polyline', PolylineType],
  ['linefill', LinefillType],
]);

// ---- checker ----------------------------------------------------------------

class Checker {
  private readonly info: Info = {
    ...newSideTables(),
    captures: new Map(),
    udtDefaults: new Map(),
    series: new Map(),
  };

  // The side-table target for the context being checked: the Info itself
  // for the main script, a FuncInstance's tables during instantiation.
  private tables: SideTables = this.info;

  // The universe scope holds implicit bindings every script sees: one
  // Library entry per builtin library. The global scope chains to it.
  private readonly universe = new Scope(null);
  private scope = new Scope(this.universe);
  private loopDepth = 0;
  private blockDepth = 0;
  // The qualifier of the enclosing control flow: writes under an `if` whose
  // condition is input-qualified produce values known no earlier than input;
  // loop bodies join series (iteration-dependent values).
  private flow: Qualifier = Qualifier.Const;

  // Function stenciling state: one instantiation per (template, signature),
  // a recursion guard (the static call graph must stay acyclic so frames
  // pre-allocate), and the instantiation root scope — non-null exactly when
  // checking inside a function, where outer-scope writes are forbidden.
  private readonly instances = new Map<
    syntax.FuncDecl,
    Map<string, FuncInstance>
  >();
  private readonly instantiating = new Set<syntax.FuncDecl>();
  private funcBoundary: Scope | null = null;
  private readonly libScopes = new Map<ResolvedLibrary, Scope>();
  // Names bound by the implicit imports — the redeclare guard's set; the
  // checker never learns where these libraries come from.
  private readonly implicitNames = new Set<string>();
  // The ambient pool reads resolve into: the Info's pool for the script's
  // own context, a fresh pool inside a request capture (child context).
  private seriesPool: Map<string, SeriesInput> = this.info.series;
  private captureDepth = 0;
  private readonly instanceStack: FuncInstance[] = [];

  constructor(
    private readonly errors: Errors,
    private readonly importer: Importer,
  ) {
    for (const library of importer.implicit()) {
      this.universe.declare(library.name, {
        kind: EntryKind.Library,
        library,
      });
      this.implicitNames.add(library.name);
    }
  }

  // The scope a library's bodies resolve against: every template of the
  // library under its plain name (rsi calls rma), exported or not; natives
  // via the ordinary catalog path.
  private libScope(library: ResolvedLibrary): Scope {
    let scope = this.libScopes.get(library);
    if (scope === undefined) {
      scope = new Scope(null);
      for (const [name, decl] of library.locals) {
        scope.declare(name, {kind: EntryKind.Func, decl, base: scope});
      }
      for (const [name, dep] of library.imports) {
        scope.declare(name, {kind: EntryKind.Library, library: dep});
      }
      this.libScopes.set(library, scope);
    }
    return scope;
  }

  checkFile(file: syntax.File): Info {
    bindFileNames(file, this.scope, this.info);
    for (const stmt of file.stmtList) {
      this.checkStmt(stmt);
    }
    return this.info;
  }

  private error(pos: Pos, msg: string): void {
    this.errors.errorAt(pos, msg);
  }

  // ---- statements -----------------------------------------------------------

  // Returns the statement's value when it can serve as a block result
  // (expression, declaration, or assignment as the last line), else null.
  private checkStmt(stmt: syntax.Stmt): TypeAndValue | null {
    switch (stmt.kind) {
      case NodeKind.ExprStmt:
        return this.checkExpr(stmt.x);
      case NodeKind.DeclStmt:
        return this.checkDecl(stmt);
      case NodeKind.AssignStmt:
        return this.checkAssign(stmt);
      case NodeKind.FuncDecl:
        this.checkFuncDecl(stmt);
        return null;
      case NodeKind.TypeDecl:
        this.checkTypeDecl(stmt);
        return null;
      case NodeKind.EnumDecl:
        this.checkEnumDecl(stmt);
        return null;
      case NodeKind.ImportStmt:
        this.checkImport(stmt);
        return null;
      case NodeKind.BreakStmt:
        if (this.loopDepth === 0) {
          this.error(stmt.pos, "'break' outside a loop");
        }
        return null;
      case NodeKind.ContinueStmt:
        if (this.loopDepth === 0) {
          this.error(stmt.pos, "'continue' outside a loop");
        }
        return null;
      case NodeKind.BadStmt:
        return null;
    }
  }

  private checkDecl(d: syntax.DeclStmt): TypeAndValue {
    const initTv = this.checkExpr(d.init);
    const declared =
      d.declType !== null ? this.resolveAnnotation(d.declType) : null;

    if (d.target.kind === NodeKind.TuplePattern) {
      this.declareTuple(d, d.target, initTv);
      return initTv;
    }

    const nameNode = d.target;
    const name = this.boundName(nameNode);
    const {type, qualifier, constValue} = this.declInfo(
      d,
      nameNode,
      name,
      initTv,
      declared,
    );
    name.type = type;
    name.qualifier = qualifier;
    this.declare(nameNode, {
      kind: EntryKind.Name,
      name,
      constDecl: d.mode === Mode.Const,
      constValue,
    });
    return initTv;
  }

  // Type, qualifier, and fold value of a single-name declaration.
  private declInfo(
    d: syntax.DeclStmt,
    nameNode: syntax.Name,
    name: IrName,
    initTv: TypeAndValue,
    declared: {type: Type; qualifier: Qualifier | null} | null,
  ): {type: Type; qualifier: Qualifier; constValue: ConstValue | null} {
    if (initTv.type.kind === TypeKind.Void) {
      this.error(d.init.pos, 'initializer has no value');
      return {type: InvalidType, qualifier: Qualifier.Const, constValue: null};
    }
    if (initTv.type.kind === TypeKind.Na && declared === null) {
      this.error(
        d.init.pos,
        `na initializer requires a type annotation (e.g. float ${nameNode.value} = na)`,
      );
      return {type: InvalidType, qualifier: Qualifier.Const, constValue: null};
    }

    let type = initTv.type;
    if (declared !== null) {
      if (!assignable(initTv.type, declared.type)) {
        this.error(
          d.init.pos,
          `cannot use ${formatType(initTv.type)} as ${formatType(declared.type)} in declaration of '${nameNode.value}'`,
        );
      }
      type = declared.type;
    }

    let qualifier: Qualifier;
    if (d.mode === Mode.Const) {
      if (initTv.qualifier !== Qualifier.Const || initTv.value === null) {
        this.error(
          d.init.pos,
          'const declaration requires a compile-time constant initializer',
        );
      }
      qualifier = Qualifier.Const;
    } else if (d.mode === Mode.Var || d.mode === Mode.Varip) {
      // Persistent storage: the value carries across bars, so reads are
      // series regardless of the initializer's qualifier.
      qualifier = Qualifier.Series;
    } else {
      qualifier = initTv.qualifier;
      if (declared !== null && declared.qualifier !== null) {
        if (!qualifierLE(initTv.qualifier, declared.qualifier)) {
          this.error(
            d.init.pos,
            `cannot use a ${initTv.qualifier} value in a declaration annotated '${declared.qualifier}'`,
          );
        }
        qualifier = declared.qualifier;
      }
      if (this.tables.reassigned.has(name)) {
        qualifier = joinQualifiers(qualifier, Qualifier.Series);
      }
    }

    // Fold values travel through names only when reassignment is impossible.
    const foldable =
      d.mode === Mode.Const ||
      (d.mode === Mode.None && !this.tables.reassigned.has(name));
    const constValue =
      foldable && initTv.qualifier === Qualifier.Const ? initTv.value : null;
    return {type, qualifier, constValue};
  }

  private declareTuple(
    d: syntax.DeclStmt,
    pattern: syntax.TuplePattern,
    initTv: TypeAndValue,
  ): void {
    let elems: readonly Type[] | null = null;
    if (initTv.type.kind === TypeKind.Tuple) {
      const tuple = initTv.type as TupleType;
      if (tuple.elems.length === pattern.elems.length) {
        elems = tuple.elems;
      } else {
        this.error(
          d.init.pos,
          `tuple declaration expects ${pattern.elems.length} values, initializer has ${tuple.elems.length}`,
        );
      }
    } else if (initTv.type.kind !== TypeKind.Invalid) {
      this.error(
        d.init.pos,
        `tuple declaration requires a tuple initializer, got ${formatType(initTv.type)}`,
      );
    }
    const qualifier =
      d.mode === Mode.Var || d.mode === Mode.Varip
        ? Qualifier.Series
        : initTv.qualifier;
    pattern.elems.forEach((elemName, i) => {
      const name = this.boundName(elemName);
      name.type = elems !== null ? elems[i] : InvalidType;
      name.qualifier =
        d.mode === Mode.None && this.tables.reassigned.has(name)
          ? joinQualifiers(qualifier, Qualifier.Series)
          : qualifier;
      this.declare(elemName, {
        kind: EntryKind.Name,
        name,
        constDecl: d.mode === Mode.Const,
        constValue: null,
      });
    });
  }

  private boundName(node: syntax.Name): IrName {
    const name = this.tables.defs.get(node);
    if (name === undefined) {
      return fatal(`unbound declaration reached checker: ${node.value}`);
    }
    return name;
  }

  private declare(nameNode: syntax.Name, entry: ScopeEntry): void {
    if (
      isNativeRoot(nameNode.value) ||
      this.implicitNames.has(nameNode.value)
    ) {
      this.discardBinding(nameNode, entry);
      this.error(nameNode.pos, `cannot redeclare built-in '${nameNode.value}'`);
      return;
    }
    if (!this.scope.declare(nameNode.value, entry)) {
      this.discardBinding(nameNode, entry);
      this.error(
        nameNode.pos,
        `'${nameNode.value}' is already declared in this scope`,
      );
      return;
    }
    if (entry.kind === EntryKind.Name) {
      if (this.boundName(nameNode) !== entry.name) {
        return fatal(`binding identity changed for '${nameNode.value}'`);
      }
    }
  }

  private discardBinding(nameNode: syntax.Name, entry: ScopeEntry): void {
    if (entry.kind !== EntryKind.Name) {
      return;
    }
    if (this.boundName(nameNode) !== entry.name) {
      return fatal(`binding identity changed for '${nameNode.value}'`);
    }
    this.tables.defs.delete(nameNode);
    this.tables.reassigned.delete(entry.name);
  }

  private checkAssign(a: syntax.AssignStmt): TypeAndValue | null {
    if (a.target.kind === NodeKind.Name) {
      return this.checkNameAssign(a, a.target);
    }
    if (a.target.kind === NodeKind.SelectorExpr) {
      return this.checkFieldAssign(a, a.target);
    }
    this.error(a.target.pos, 'invalid assignment target');
    this.checkExpr(a.value);
    return null;
  }

  private checkNameAssign(
    a: syntax.AssignStmt,
    target: syntax.Name,
  ): TypeAndValue | null {
    const entry = this.scope.lookup(target.value);
    if (entry === null) {
      this.error(
        target.pos,
        isNativeRoot(target.value)
          ? `cannot assign to built-in '${target.value}'`
          : `undeclared name '${target.value}'`,
      );
      this.checkExpr(a.value);
      return null;
    }
    if (entry.kind !== EntryKind.Name) {
      this.error(target.pos, `cannot assign to '${target.value}'`);
      this.checkExpr(a.value);
      return null;
    }
    if (entry.constDecl) {
      this.error(
        target.pos,
        `cannot reassign '${target.value}' declared with const`,
      );
    }
    if (
      this.funcBoundary !== null &&
      !this.scope.resolvesWithin(target.value, this.funcBoundary)
    ) {
      // Pine semantics: functions read the global scope but never write it.
      this.error(
        target.pos,
        `cannot modify global variable '${target.value}' inside a function`,
      );
    }
    if (
      entry.name.type.kind === TypeKind.Plot ||
      entry.name.type.kind === TypeKind.Hline
    ) {
      // Output references are compile-time ids consumed at init (fill);
      // a reassignable ref could not be resolved before the first bar.
      this.error(target.pos, 'cannot reassign a plot reference');
    }
    const name = entry.name;
    if (this.tables.uses.get(target) !== name) {
      return fatal(`assignment binding changed for '${target.value}'`);
    }

    const valueTv = this.checkExpr(a.value);
    // Compound forms type-check as the underlying binary operation on the
    // current value; the noder desugars them the same way.
    const base = ASSIGN_BASE_OP[a.op];
    const written =
      a.op === AssignOp.Define || base === undefined
        ? valueTv
        : this.binaryTv(
            base,
            {type: name.type, qualifier: name.qualifier, value: null},
            valueTv,
            a.pos,
          );
    if (
      name.type.kind !== TypeKind.Invalid &&
      !assignable(written.type, name.type)
    ) {
      this.error(
        a.value.pos,
        `cannot assign ${formatType(written.type)} to ${formatType(name.type)} variable '${target.value}'`,
      );
    }
    name.qualifier = joinQualifiers(
      joinQualifiers(name.qualifier, written.qualifier),
      this.flow,
    );
    return written;
  }

  private checkFieldAssign(
    a: syntax.AssignStmt,
    target: syntax.SelectorExpr,
  ): TypeAndValue | null {
    const baseTv = this.checkExpr(target.x);
    const valueTv = this.checkExpr(a.value);
    if (baseTv.type.kind === TypeKind.Invalid) {
      return null;
    }
    if (baseTv.type.kind !== TypeKind.Udt) {
      this.error(
        target.pos,
        `${formatType(baseTv.type)} has no field '${target.sel.value}'`,
      );
      return null;
    }
    const field = (baseTv.type as UdtType).fields.find(
      f => f.name === target.sel.value,
    );
    if (field === undefined) {
      this.error(
        target.sel.pos,
        `${formatType(baseTv.type)} has no field '${target.sel.value}'`,
      );
      return null;
    }
    if (a.op !== AssignOp.Define) {
      this.error(a.pos, 'compound assignment to a field is not supported');
      return null;
    }
    if (!assignable(valueTv.type, field.type)) {
      this.error(
        a.value.pos,
        `cannot assign ${formatType(valueTv.type)} to field '${field.name}' of type ${formatType(field.type)}`,
      );
    }
    return valueTv;
  }

  // An import declaration: resolution belongs to the injected Importer (the
  // loader's registry decides what a path means); the checker only positions
  // resolver errors and binds the namespace.
  private checkImport(stmt: syntax.ImportStmt): void {
    if (this.blockDepth > 0 || this.funcBoundary !== null) {
      this.error(stmt.pos, 'import must be at the top level of the script');
      return;
    }
    const outcome = this.importer.import(stmt.path.value);
    if (isImportError(outcome)) {
      this.error(stmt.path.pos, outcome.error);
      return;
    }
    const entry = {kind: EntryKind.Library, library: outcome} as const;
    if (stmt.alias !== null) {
      this.declare(stmt.alias, entry);
      return;
    }
    // Without an alias the library binds under its declared name; implicit
    // libraries are already bound, so this is a legal no-op for them.
    if (!this.implicitNames.has(outcome.name)) {
      if (!this.scope.declare(outcome.name, entry)) {
        this.error(
          stmt.path.pos,
          `'${outcome.name}' is already declared in this scope`,
        );
      }
    }
  }

  private checkFuncDecl(d: syntax.FuncDecl): void {
    if (this.blockDepth > 0) {
      this.error(d.pos, 'functions must be declared at the top level');
      return;
    }
    // The template is bound now; bodies are checked per concrete argument
    // signature when calls are stenciled.
    this.declare(d.name, {kind: EntryKind.Func, decl: d, base: this.scope});
  }

  private checkTypeDecl(d: syntax.TypeDecl): void {
    if (this.blockDepth > 0) {
      this.error(d.pos, 'types must be declared at the top level');
      return;
    }
    const fields: UdtField[] = [];
    const defaults = new Map<string, syntax.Expr>();
    for (const field of d.fields) {
      const type = this.resolveTypeName(field.fieldType.name);
      if (fields.some(f => f.name === field.name.value)) {
        this.error(
          field.name.pos,
          `duplicate field '${field.name.value}' in type '${d.name.value}'`,
        );
        continue;
      }
      if (field.defaultValue !== null) {
        const defTv = this.checkExpr(field.defaultValue);
        if (!assignable(defTv.type, type)) {
          this.error(
            field.defaultValue.pos,
            `cannot use ${formatType(defTv.type)} as ${formatType(type)} default for field '${field.name.value}'`,
          );
        }
        defaults.set(field.name.value, field.defaultValue);
      }
      fields.push({name: field.name.value, type, varip: false});
    }
    const udt: UdtType = {kind: TypeKind.Udt, name: d.name.value, fields};
    this.info.udtDefaults.set(udt, defaults);
    this.declare(d.name, {kind: EntryKind.Udt, type: udt});
  }

  private checkEnumDecl(d: syntax.EnumDecl): void {
    if (this.blockDepth > 0) {
      this.error(d.pos, 'enums must be declared at the top level');
      return;
    }
    const members: EnumMemberType[] = [];
    for (const member of d.members) {
      if (members.some(m => m.name === member.name.value)) {
        this.error(
          member.name.pos,
          `duplicate member '${member.name.value}' in enum '${d.name.value}'`,
        );
        continue;
      }
      let title = member.name.value;
      if (member.title !== null) {
        const titleTv = this.checkExpr(member.title);
        if (titleTv.value !== null && typeof titleTv.value === 'string') {
          title = titleTv.value;
        } else {
          this.error(
            member.title.pos,
            'enum member title must be a constant string',
          );
        }
      }
      members.push({name: member.name.value, title});
    }
    const enumType: EnumType = {
      kind: TypeKind.Enum,
      name: d.name.value,
      members,
    };
    this.declare(d.name, {kind: EntryKind.Enum, type: enumType});
  }

  // ---- annotations ----------------------------------------------------------

  private resolveAnnotation(a: syntax.TypeAnnotation): {
    type: Type;
    qualifier: Qualifier | null;
  } {
    let qualifier: Qualifier | null = null;
    if (a.qualifier !== null) {
      if (a.qualifier.value === Qualifier.Simple) {
        qualifier = Qualifier.Simple;
      } else if (a.qualifier.value === Qualifier.Series) {
        qualifier = Qualifier.Series;
      } else {
        this.error(a.qualifier.pos, `unknown qualifier '${a.qualifier.value}'`);
      }
    }
    return {type: this.resolveTypeName(a.name), qualifier};
  }

  private resolveTypeName(t: syntax.TypeName): Type {
    switch (t.kind) {
      case NodeKind.Name: {
        const builtin = TYPE_NAMES.get(t.value);
        if (builtin !== undefined) {
          return builtin;
        }
        const entry = this.scope.lookup(t.value);
        if (entry?.kind === EntryKind.Udt || entry?.kind === EntryKind.Enum) {
          return entry.type;
        }
        this.error(t.pos, `unknown type '${t.value}'`);
        return InvalidType;
      }
      case NodeKind.GenericType:
      case NodeKind.ArrayType:
        this.error(t.pos, 'collection types are not supported yet');
        return InvalidType;
      case NodeKind.SelectorExpr:
        this.error(t.pos, 'qualified type names are not supported yet');
        return InvalidType;
    }
  }

  // ---- expressions ----------------------------------------------------------

  private checkExpr(e: syntax.Expr): TypeAndValue {
    const tv = this.exprTv(e);
    this.tables.types.set(e, tv);
    return tv;
  }

  private tvOf(e: syntax.Expr): TypeAndValue {
    return this.tables.types.get(e) ?? INVALID_TV;
  }

  private exprTv(e: syntax.Expr): TypeAndValue {
    switch (e.kind) {
      case NodeKind.Name:
        return this.resolveName(e);
      case NodeKind.BasicLit:
        return this.literalTv(e);
      case NodeKind.UnaryExpr:
        return this.unaryTv(e);
      case NodeKind.BinaryExpr:
        return this.binaryTv(
          e.op,
          this.checkExpr(e.x),
          this.checkExpr(e.y),
          e.pos,
        );
      case NodeKind.CondExpr:
        return this.condTv(e);
      case NodeKind.CallExpr:
        return this.checkCall(e);
      case NodeKind.SelectorExpr:
        return this.resolveSelector(e);
      case NodeKind.HistoryExpr:
        return this.historyTv(e);
      case NodeKind.TupleExpr:
        return this.tupleTv(e);
      case NodeKind.ParenExpr:
        return this.checkExpr(e.x);
      case NodeKind.IfExpr:
        return this.ifTv(e);
      case NodeKind.ForExpr:
        return this.forTv(e);
      case NodeKind.ForInExpr:
        return this.forInTv(e);
      case NodeKind.WhileExpr:
        return this.whileTv(e);
      case NodeKind.SwitchExpr:
        return this.switchTv(e);
      case NodeKind.BadExpr:
        return INVALID_TV;
    }
  }

  private resolveName(n: syntax.Name): TypeAndValue {
    const entry = this.scope.lookup(n.value);
    if (entry !== null) {
      switch (entry.kind) {
        case EntryKind.Name: {
          if (
            this.funcBoundary !== null &&
            !this.scope.resolvesWithin(n.value, this.funcBoundary)
          ) {
            // Reading an outer-scope variable pins the instance to the
            // context it was checked in.
            const top = this.instanceStack[this.instanceStack.length - 1];
            if (top !== undefined) {
              top.touchesContext = true;
            }
          } else if (
            this.captureDepth > 0 &&
            this.funcBoundary === null &&
            !qualifierLE(entry.name.qualifier, Qualifier.Input)
          ) {
            // Only bind-time values cross contexts; per-context state must
            // be recomputed inside the expression.
            this.error(
              n.pos,
              `request expressions cannot reference script variable '${n.value}'; only bind-time (input) values cross contexts`,
            );
            return INVALID_TV;
          }
          this.tables.uses.set(n, entry.name);
          return {
            type: entry.name.type,
            qualifier: entry.name.qualifier,
            value: entry.constValue,
          };
        }
        case EntryKind.Func:
          this.error(n.pos, `'${n.value}' is a function; call it`);
          return INVALID_TV;
        case EntryKind.Udt:
        case EntryKind.Enum:
          this.error(n.pos, `'${n.value}' is a type, not a value`);
          return INVALID_TV;
        case EntryKind.Library:
          this.error(n.pos, `'${n.value}' is a library, not a value`);
          return INVALID_TV;
      }
    }
    const nv = nativeVar(n.value);
    if (nv !== null) {
      return this.nativeVarTv(nv, n);
    }
    if (nativeFuncs(n.value) !== null) {
      this.error(n.pos, `'${n.value}' is a function; call it`);
      return INVALID_TV;
    }
    this.error(n.pos, `undeclared name '${n.value}'`);
    return INVALID_TV;
  }

  // Ambient (non-const) native variables become entries in the shared series
  // pool: one SeriesInput object per host id, shared by every use.
  private nativeVarTv(nv: NativeVar, node: syntax.Expr): TypeAndValue {
    if (nv.qualifier !== Qualifier.Const) {
      let series = this.seriesPool.get(nv.name);
      if (series === undefined) {
        series = {
          id: nv.name,
          type: nv.type,
          qualifier: nv.qualifier,
          depth: {kind: DepthKind.None},
        };
        this.seriesPool.set(nv.name, series);
      }
      this.tables.ambient.set(node, series);
      // An ambient read inside a function body pins that instance to the
      // context it was checked in.
      const top = this.instanceStack[this.instanceStack.length - 1];
      if (top !== undefined) {
        top.touchesContext = true;
      }
    }
    return {type: nv.type, qualifier: nv.qualifier, value: nv.value};
  }

  private resolveSelector(s: syntax.SelectorExpr): TypeAndValue {
    const path = dottedPath(s);
    if (path !== null && this.scope.lookup(path.root) === null) {
      const nv = nativeVar(path.path);
      if (nv !== null) {
        return this.nativeVarTv(nv, s);
      }
      if (nativeFuncs(path.path) !== null) {
        this.error(s.pos, `'${path.path}' is a function; call it`);
        return INVALID_TV;
      }
      this.error(s.pos, `undeclared name '${path.path}'`);
      return INVALID_TV;
    }
    if (s.x.kind === NodeKind.Name) {
      const entry = this.scope.lookup(s.x.value);
      if (entry?.kind === EntryKind.Enum) {
        const member = entry.type.members.find(m => m.name === s.sel.value);
        if (member === undefined) {
          this.error(
            s.sel.pos,
            `enum '${entry.type.name}' has no member '${s.sel.value}'`,
          );
          return INVALID_TV;
        }
        return {
          type: entry.type,
          qualifier: Qualifier.Const,
          value: member.name,
        };
      }
      if (entry?.kind === EntryKind.Udt) {
        this.error(s.pos, `'${s.x.value}' is a type, not a value`);
        return INVALID_TV;
      }
      if (entry?.kind === EntryKind.Func) {
        this.error(s.pos, `'${s.x.value}' is a function, not a value`);
        return INVALID_TV;
      }
    }
    const baseTv = this.checkExpr(s.x);
    if (baseTv.type.kind === TypeKind.Invalid) {
      return INVALID_TV;
    }
    if (baseTv.type.kind === TypeKind.Udt) {
      const field = (baseTv.type as UdtType).fields.find(
        f => f.name === s.sel.value,
      );
      if (field === undefined) {
        this.error(
          s.sel.pos,
          `${formatType(baseTv.type)} has no field '${s.sel.value}'`,
        );
        return INVALID_TV;
      }
      return {type: field.type, qualifier: baseTv.qualifier, value: null};
    }
    this.error(
      s.sel.pos,
      `${formatType(baseTv.type)} has no field '${s.sel.value}'`,
    );
    return INVALID_TV;
  }

  private literalTv(lit: syntax.BasicLit): TypeAndValue {
    if (lit.bad) {
      return INVALID_TV;
    }
    switch (lit.litKind) {
      case LitKind.Int:
        return {
          type: IntType,
          qualifier: Qualifier.Const,
          value: Number(lit.value),
        };
      case LitKind.Float:
        return {
          type: FloatType,
          qualifier: Qualifier.Const,
          value: Number(lit.value),
        };
      case LitKind.String:
        return {
          type: StringType,
          qualifier: Qualifier.Const,
          value: unquoteString(lit.value),
        };
      case LitKind.Color:
        return {
          type: ColorType,
          qualifier: Qualifier.Const,
          value: lit.value.toUpperCase(),
        };
      case LitKind.Path:
        return INVALID_TV; // import paths never reach expression position
    }
  }

  private unaryTv(e: syntax.UnaryExpr): TypeAndValue {
    const tv = this.checkExpr(e.x);
    if (tv.type.kind === TypeKind.Invalid) {
      return INVALID_TV;
    }
    if (e.op === Op.Not) {
      if (tv.type.kind !== TypeKind.Bool) {
        this.error(
          e.pos,
          `'not' requires a bool operand, got ${formatType(tv.type)}`,
        );
        return INVALID_TV;
      }
      const value =
        tv.value !== null && typeof tv.value === 'boolean' ? !tv.value : null;
      return {type: BoolType, qualifier: tv.qualifier, value};
    }
    if (e.op === Op.Minus || e.op === Op.Plus) {
      if (!isNumericType(tv.type)) {
        this.error(
          e.pos,
          `unary '${e.op}' requires a numeric operand, got ${formatType(tv.type)}`,
        );
        return INVALID_TV;
      }
      if (e.op === Op.Plus) {
        return tv;
      }
      const value =
        tv.value !== null && typeof tv.value === 'number' ? -tv.value : null;
      return {type: tv.type, qualifier: tv.qualifier, value};
    }
    this.error(e.pos, `invalid unary operator '${e.op}'`);
    return INVALID_TV;
  }

  private binaryTv(
    op: Op,
    x: TypeAndValue,
    y: TypeAndValue,
    pos: Pos,
  ): TypeAndValue {
    if (x.type.kind === TypeKind.Invalid || y.type.kind === TypeKind.Invalid) {
      return INVALID_TV;
    }
    const qualifier = joinQualifiers(x.qualifier, y.qualifier);

    if (op === Op.And || op === Op.Or) {
      if (x.type.kind !== TypeKind.Bool || y.type.kind !== TypeKind.Bool) {
        this.error(
          pos,
          `'${op}' requires bool operands (got ${formatType(x.type)} and ${formatType(y.type)})`,
        );
        return INVALID_TV;
      }
      return {type: BoolType, qualifier, value: foldBinary(op, x, y, BoolType)};
    }

    if (op === Op.EqEq || op === Op.NotEq) {
      if (unifyTypes(x.type, y.type) === null) {
        this.error(
          pos,
          `cannot compare ${formatType(x.type)} with ${formatType(y.type)}`,
        );
        return INVALID_TV;
      }
      return {type: BoolType, qualifier, value: foldBinary(op, x, y, BoolType)};
    }

    if (op === Op.Lt || op === Op.Le || op === Op.Gt || op === Op.Ge) {
      if (!isNumericType(x.type) || !isNumericType(y.type)) {
        this.error(
          pos,
          `operator '${op}' requires numeric operands (got ${formatType(x.type)} and ${formatType(y.type)})`,
        );
        return INVALID_TV;
      }
      return {type: BoolType, qualifier, value: foldBinary(op, x, y, BoolType)};
    }

    // Arithmetic; '+' additionally concatenates strings.
    if (
      op === Op.Plus &&
      x.type.kind === TypeKind.String &&
      y.type.kind === TypeKind.String
    ) {
      return {
        type: StringType,
        qualifier,
        value: foldBinary(op, x, y, StringType),
      };
    }
    if (!isNumericType(x.type) || !isNumericType(y.type)) {
      this.error(
        pos,
        `operator '${op}' requires numeric operands (got ${formatType(x.type)} and ${formatType(y.type)})`,
      );
      return INVALID_TV;
    }
    const type = numericResult(x.type, y.type);
    return {type, qualifier, value: foldBinary(op, x, y, type)};
  }

  private condTv(e: syntax.CondExpr): TypeAndValue {
    const condTv = this.checkExpr(e.cond);
    const thenTv = this.checkExpr(e.then);
    const elseTv = this.checkExpr(e.else);
    if (
      condTv.type.kind !== TypeKind.Bool &&
      condTv.type.kind !== TypeKind.Invalid
    ) {
      this.error(
        e.cond.pos,
        `ternary condition must be bool, got ${formatType(condTv.type)}`,
      );
    }
    const type = unifyTypes(thenTv.type, elseTv.type);
    if (type === null) {
      this.error(
        e.pos,
        `ternary branches have mismatched types (${formatType(thenTv.type)} vs ${formatType(elseTv.type)})`,
      );
      return INVALID_TV;
    }
    const qualifier = joinQualifiers(
      condTv.qualifier,
      joinQualifiers(thenTv.qualifier, elseTv.qualifier),
    );
    if (condTv.value !== null && typeof condTv.value === 'boolean') {
      const branch = condTv.value ? thenTv : elseTv;
      return {type, qualifier: branch.qualifier, value: branch.value};
    }
    return {type, qualifier, value: null};
  }

  private historyTv(e: syntax.HistoryExpr): TypeAndValue {
    const xTv = this.checkExpr(e.x);
    const offsetTv = this.checkExpr(e.offset);
    if (xTv.type.kind === TypeKind.Void) {
      this.error(e.x.pos, 'expression has no value');
      return INVALID_TV;
    }
    if (
      offsetTv.type.kind !== TypeKind.Invalid &&
      !assignable(offsetTv.type, IntType)
    ) {
      this.error(
        e.offset.pos,
        `history offset must be an int, got ${formatType(offsetTv.type)}`,
      );
    }
    if (xTv.type.kind === TypeKind.Invalid) {
      return INVALID_TV;
    }
    // Every history read is a read through the time machine: series, no fold.
    return {type: xTv.type, qualifier: Qualifier.Series, value: null};
  }

  private tupleTv(e: syntax.TupleExpr): TypeAndValue {
    const tvs = e.elems.map(elem => this.checkExpr(elem));
    let qualifier: Qualifier = Qualifier.Const;
    for (const tv of tvs) {
      if (tv.type.kind === TypeKind.Void) {
        this.error(e.pos, 'tuple element has no value');
        return INVALID_TV;
      }
      qualifier = joinQualifiers(qualifier, tv.qualifier);
    }
    return {
      type: {kind: TypeKind.Tuple, elems: tvs.map(tv => tv.type)},
      qualifier,
      value: null,
    };
  }

  private ifTv(e: syntax.IfExpr): TypeAndValue {
    const condTv = this.checkExpr(e.cond);
    if (
      condTv.type.kind !== TypeKind.Bool &&
      condTv.type.kind !== TypeKind.Invalid
    ) {
      this.error(
        e.cond.pos,
        `'if' condition must be bool, got ${formatType(condTv.type)}`,
      );
    }
    const savedFlow = this.flow;
    this.flow = joinQualifiers(savedFlow, condTv.qualifier);
    const thenTv = this.checkBlock(e.then);
    let elseType: Type | null = null;
    if (e.else !== null) {
      const elseTv =
        e.else.kind === NodeKind.IfExpr
          ? this.checkExpr(e.else)
          : this.checkBlock(e.else);
      elseType = elseTv.type;
    }
    this.flow = savedFlow;
    // Mismatched branch types are legal in statement position; the structure
    // then simply has no value, and value-position consumers report that.
    const type =
      elseType === null ? thenTv.type : unifyOrVoid(thenTv.type, elseType);
    return {type, qualifier: Qualifier.Series, value: null};
  }

  private forTv(e: syntax.ForExpr): TypeAndValue {
    const fromTv = this.checkExpr(e.from);
    const toTv = this.checkExpr(e.to);
    const stepTv = e.step !== null ? this.checkExpr(e.step) : null;
    for (const [tv, node] of [
      [fromTv, e.from],
      [toTv, e.to],
      ...(stepTv !== null && e.step !== null
        ? [[stepTv, e.step] as const]
        : []),
    ] as const) {
      if (tv.type.kind !== TypeKind.Invalid && !isNumericType(tv.type)) {
        this.error(
          node.pos,
          `'for' bounds must be numeric, got ${formatType(tv.type)}`,
        );
      }
    }
    const anyFloat = [fromTv, toTv, stepTv].some(
      tv => tv !== null && tv.type.kind === TypeKind.Float,
    );
    const indexType = anyFloat ? FloatType : IntType;

    const savedScope = this.scope;
    this.scope = new Scope(savedScope);
    const indexName = this.boundName(e.index);
    indexName.type = indexType;
    indexName.qualifier = Qualifier.Series;
    this.declare(e.index, {
      kind: EntryKind.Name,
      name: indexName,
      constDecl: false,
      constValue: null,
    });
    const bodyTv = this.checkLoopBody(e.body);
    this.scope = savedScope;
    return {type: bodyTv.type, qualifier: Qualifier.Series, value: null};
  }

  private forInTv(e: syntax.ForInExpr): TypeAndValue {
    const xTv = this.checkExpr(e.x);
    let elemType: Type = InvalidType;
    if (xTv.type.kind === TypeKind.Array) {
      elemType = xTv.type.elem;
    } else if (xTv.type.kind !== TypeKind.Invalid) {
      this.error(
        e.x.pos,
        `for-in requires an array, got ${formatType(xTv.type)}`,
      );
    }
    const savedScope = this.scope;
    this.scope = new Scope(savedScope);
    const declareTarget = (nameNode: syntax.Name, type: Type): void => {
      const name = this.boundName(nameNode);
      name.type = type;
      name.qualifier = Qualifier.Series;
      this.declare(nameNode, {
        kind: EntryKind.Name,
        name,
        constDecl: false,
        constValue: null,
      });
    };
    if (e.target.kind === NodeKind.Name) {
      declareTarget(e.target, elemType);
    } else if (e.target.elems.length === 2) {
      declareTarget(e.target.elems[0], IntType);
      declareTarget(e.target.elems[1], elemType);
    } else {
      this.error(e.target.pos, 'for-in tuple pattern takes [index, value]');
    }
    const bodyTv = this.checkLoopBody(e.body);
    this.scope = savedScope;
    return {type: bodyTv.type, qualifier: Qualifier.Series, value: null};
  }

  private whileTv(e: syntax.WhileExpr): TypeAndValue {
    const condTv = this.checkExpr(e.cond);
    if (
      condTv.type.kind !== TypeKind.Bool &&
      condTv.type.kind !== TypeKind.Invalid
    ) {
      this.error(
        e.cond.pos,
        `'while' condition must be bool, got ${formatType(condTv.type)}`,
      );
    }
    const bodyTv = this.checkLoopBody(e.body);
    return {type: bodyTv.type, qualifier: Qualifier.Series, value: null};
  }

  // Loop bodies run under series flow: iteration-dependent writes are
  // per-bar values regardless of how early the bounds are known.
  private checkLoopBody(body: syntax.Block): TypeAndValue {
    const savedFlow = this.flow;
    this.flow = joinQualifiers(savedFlow, Qualifier.Series);
    this.loopDepth += 1;
    const tv = this.checkBlock(body);
    this.loopDepth -= 1;
    this.flow = savedFlow;
    return tv;
  }

  private switchTv(e: syntax.SwitchExpr): TypeAndValue {
    const subjectTv = e.subject !== null ? this.checkExpr(e.subject) : null;
    const savedFlow = this.flow;
    if (subjectTv !== null) {
      this.flow = joinQualifiers(savedFlow, subjectTv.qualifier);
    }
    let type: Type | null = null;
    for (const arm of e.arms) {
      if (arm.pattern !== null) {
        const patternTv = this.checkExpr(arm.pattern);
        if (subjectTv === null) {
          if (
            patternTv.type.kind !== TypeKind.Bool &&
            patternTv.type.kind !== TypeKind.Invalid
          ) {
            this.error(
              arm.pattern.pos,
              `switch condition must be bool, got ${formatType(patternTv.type)}`,
            );
          }
          this.flow = joinQualifiers(this.flow, patternTv.qualifier);
        } else if (unifyTypes(subjectTv.type, patternTv.type) === null) {
          this.error(
            arm.pattern.pos,
            `switch case type ${formatType(patternTv.type)} does not match subject type ${formatType(subjectTv.type)}`,
          );
        }
      }
      const armTv =
        arm.body.kind === NodeKind.Block
          ? this.checkBlock(arm.body)
          : this.checkExpr(arm.body);
      type = type === null ? armTv.type : unifyOrVoid(type, armTv.type);
    }
    this.flow = savedFlow;
    return {type: type ?? VoidType, qualifier: Qualifier.Series, value: null};
  }

  private checkBlock(b: syntax.Block): TypeAndValue {
    const savedScope = this.scope;
    this.scope = new Scope(savedScope);
    this.blockDepth += 1;
    let last: TypeAndValue | null = null;
    for (const [i, stmt] of b.stmtList.entries()) {
      const tv = this.checkStmt(stmt);
      if (i === b.stmtList.length - 1) {
        last = tv;
      }
    }
    this.blockDepth -= 1;
    this.scope = savedScope;
    return last ?? VOID_TV;
  }

  // ---- calls ----------------------------------------------------------------

  private checkCall(c: syntax.CallExpr): TypeAndValue {
    // Argument values are checked exactly once, up front; overload matching
    // reads their recorded TypeAndValue.
    let seenNamed = false;
    for (const arg of c.args) {
      if (arg.name !== null) {
        seenNamed = true;
      } else if (seenNamed) {
        this.error(arg.pos, 'positional argument after named argument');
      }
      this.checkExpr(arg.value);
    }
    if (c.typeArgs !== null) {
      this.error(c.pos, 'generic type arguments are not supported yet');
      return INVALID_TV;
    }

    const fun = c.fun;
    if (fun.kind === NodeKind.Name) {
      const entry = this.scope.lookup(fun.value);
      if (entry !== null) {
        if (entry.kind === EntryKind.Func) {
          return this.checkUserCall(c, entry.decl, fun.value, entry.base);
        }
        if (entry.kind === EntryKind.Udt) {
          this.error(
            c.pos,
            `'${fun.value}' is a type; construct it with '${fun.value}.new(...)'`,
          );
        } else {
          this.error(fun.pos, `'${fun.value}' is not a function`);
        }
        return INVALID_TV;
      }
      return this.resolveNativeCall(c, fun.value, fun.pos);
    }
    if (fun.kind === NodeKind.SelectorExpr) {
      if (fun.x.kind === NodeKind.Name && fun.sel.value === 'new') {
        const entry = this.scope.lookup(fun.x.value);
        if (entry?.kind === EntryKind.Udt) {
          return this.checkNew(c, entry.type);
        }
      }
      if (fun.x.kind === NodeKind.Name) {
        const rootEntry = this.scope.lookup(fun.x.value);
        if (rootEntry?.kind === EntryKind.Library) {
          const written = `${fun.x.value}.${fun.sel.value}`;
          const template = rootEntry.library.exports.get(fun.sel.value);
          if (template === undefined) {
            this.error(fun.pos, `unknown function '${written}'`);
            return INVALID_TV;
          }
          return this.checkUserCall(
            c,
            template,
            written,
            this.libScope(rootEntry.library),
          );
        }
      }
      const path = dottedPath(fun);
      if (path !== null && this.scope.lookup(path.root) === null) {
        return this.resolveNativeCall(c, path.path, fun.pos);
      }
      this.error(fun.sel.pos, 'method calls are not supported yet');
      return INVALID_TV;
    }
    this.error(fun.pos, 'expression is not callable');
    return INVALID_TV;
  }

  // ---- user-function stenciling ---------------------------------------------

  // A call to a user or prelude template: align arguments, memoize one
  // instantiation per concrete signature, and type the call from the
  // instance. Instantiations are real functions sharing one checked body per
  // signature; call-site state separates later via SlotIds.
  private checkUserCall(
    c: syntax.CallExpr,
    template: syntax.FuncDecl,
    displayName: string,
    base: Scope,
  ): TypeAndValue {
    const params = template.params;
    const aligned: (syntax.Expr | null)[] = Array<syntax.Expr | null>(
      params.length,
    ).fill(null);
    let position = 0;
    for (const arg of c.args) {
      if (arg.name === null) {
        if (position >= params.length) {
          this.error(arg.pos, `too many arguments in call to '${displayName}'`);
          return INVALID_TV;
        }
        aligned[position] = arg.value;
        position += 1;
        continue;
      }
      const index = params.findIndex(p => p.name.value === arg.name!.value);
      if (index === -1) {
        this.error(
          arg.pos,
          `unknown argument '${arg.name.value}' in call to '${displayName}'`,
        );
        return INVALID_TV;
      }
      if (aligned[index] !== null) {
        this.error(arg.pos, `duplicate argument '${arg.name.value}'`);
        return INVALID_TV;
      }
      aligned[index] = arg.value;
    }
    for (const [i, p] of params.entries()) {
      if (aligned[i] === null && p.defaultValue === null) {
        this.error(
          c.pos,
          `missing argument '${p.name.value}' in call to '${displayName}'`,
        );
        return INVALID_TV;
      }
    }
    if (this.instantiating.has(template)) {
      // The static call graph must stay acyclic: frames pre-allocate along
      // it at bind time.
      this.error(c.pos, `recursive call to '${displayName}'`);
      return INVALID_TV;
    }

    const argTvs = aligned.map(e => (e !== null ? this.tvOf(e) : null));
    if (argTvs.some(tv => tv !== null && tv.type.kind === TypeKind.Invalid)) {
      return INVALID_TV;
    }
    const sigKey = argTvs
      .map(tv =>
        tv === null ? 'default' : `${formatType(tv.type)}|${tv.qualifier}`,
      )
      .join(',');
    let bySig = this.instances.get(template);
    if (bySig === undefined) {
      bySig = new Map();
      this.instances.set(template, bySig);
    }
    let instance = bySig.get(sigKey);
    if (instance === undefined) {
      instance = this.instantiate(template, displayName, base, aligned, argTvs);
      bySig.set(sigKey, instance);
    }
    const top = this.instanceStack[this.instanceStack.length - 1];
    if (top !== undefined && instance.touchesContext) {
      top.touchesContext = true;
    }
    if (this.captureDepth > 0 && instance.touchesContext) {
      this.error(
        c.pos,
        `'${displayName}' reads the script's context directly and cannot be used in a request expression; pass its inputs as parameters`,
      );
      return INVALID_TV;
    }
    this.tables.userCalls.set(c, {instance, args: aligned});
    return {
      type: instance.resultType,
      qualifier: instance.resultQualifier,
      value: null,
    };
  }

  // Stencil the template for one concrete signature: fresh side tables and a
  // scope rooted at the template's base, params adopting the argument types
  // and qualifiers (capped by annotations), body checked once.
  private instantiate(
    template: syntax.FuncDecl,
    displayName: string,
    base: Scope,
    aligned: readonly (syntax.Expr | null)[],
    argTvs: readonly (TypeAndValue | null)[],
  ): FuncInstance {
    const saved = {
      scope: this.scope,
      tables: this.tables,
      flow: this.flow,
      loopDepth: this.loopDepth,
      blockDepth: this.blockDepth,
      boundary: this.funcBoundary,
    };
    const tables = newSideTables();
    bindFunctionNames(template, aligned, base, tables);
    const scope = new Scope(base);
    this.scope = scope;
    this.tables = tables;
    this.flow = Qualifier.Const;
    this.loopDepth = 0;
    this.blockDepth = 0;
    this.funcBoundary = scope;
    this.instantiating.add(template);

    const irParams: IrName[] = [];
    const defaults = new Map<number, syntax.Expr>();
    template.params.forEach((p, i) => {
      const annotated =
        p.paramType !== null ? this.resolveAnnotation(p.paramType) : null;
      let tv = argTvs[i];
      if (tv === null) {
        const dflt = p.defaultValue;
        if (dflt === null) {
          // checkUserCall already rejected calls missing a required param.
          return fatal(
            `instantiating '${displayName}' without argument '${p.name.value}'`,
          );
        }
        defaults.set(i, dflt);
        tv = this.checkExpr(dflt);
      } else {
        const argExpr = aligned[i];
        if (annotated !== null && argExpr !== null) {
          if (!assignable(tv.type, annotated.type)) {
            this.error(
              argExpr.pos,
              `argument '${p.name.value}' to '${displayName}': cannot use ${formatType(tv.type)} as ${formatType(annotated.type)}`,
            );
          }
          if (
            annotated.qualifier !== null &&
            !qualifierLE(tv.qualifier, annotated.qualifier)
          ) {
            this.error(
              argExpr.pos,
              `argument '${p.name.value}' to '${displayName}' accepts at most ${annotated.qualifier}, got ${tv.qualifier}`,
            );
          }
        }
      }
      const name = this.boundName(p.name);
      name.type = annotated !== null ? annotated.type : tv.type;
      name.qualifier = this.tables.reassigned.has(name)
        ? joinQualifiers(tv.qualifier, Qualifier.Series)
        : tv.qualifier;
      irParams.push(name);
      this.declare(p.name, {
        kind: EntryKind.Name,
        name,
        constDecl: false,
        constValue: null,
      });
    });

    const instance: FuncInstance = {
      template,
      name: displayName,
      params: irParams,
      defaults,
      tables,
      resultType: InvalidType,
      resultQualifier: Qualifier.Const,
      touchesContext: false,
    };
    this.instanceStack.push(instance);
    const bodyTv =
      template.body.kind === NodeKind.Block
        ? this.checkBlock(template.body)
        : this.checkExpr(template.body);
    this.instanceStack.pop();
    instance.resultType = bodyTv.type;
    instance.resultQualifier = bodyTv.qualifier;

    this.instantiating.delete(template);
    this.scope = saved.scope;
    this.tables = saved.tables;
    this.flow = saved.flow;
    this.loopDepth = saved.loopDepth;
    this.blockDepth = saved.blockDepth;
    this.funcBoundary = saved.boundary;
    return instance;
  }

  private resolveNativeCall(
    c: syntax.CallExpr,
    name: string,
    pos: Pos,
  ): TypeAndValue {
    const candidates = nativeFuncs(name);
    if (candidates === null) {
      this.error(
        pos,
        nativeVar(name) !== null
          ? `'${name}' is not a function`
          : `unknown function '${name}'`,
      );
      return INVALID_TV;
    }
    let firstReason: {pos: Pos; msg: string} | null = null;
    for (const candidate of candidates) {
      const outcome = this.matchOverload(c, candidate);
      if (outcome.ok) {
        this.tables.calls.set(c, {native: candidate, args: outcome.args});
        this.checkPlacement(candidate, c.pos);
        if (candidate.effect === Effect.Request) {
          return this.checkRequest(c, candidate, outcome.args);
        }
        return this.callResultTv(candidate, outcome.args);
      }
      if (firstReason === null) {
        firstReason = outcome.reason;
      }
    }
    if (candidates.length === 1 && firstReason !== null) {
      this.error(firstReason.pos, firstReason.msg);
    } else {
      this.error(pos, `no matching overload for '${name}'`);
    }
    return INVALID_TV;
  }

  private matchOverload(
    c: syntax.CallExpr,
    native: NativeFunc,
  ):
    | {ok: true; args: readonly (syntax.Expr | null)[]}
    | {ok: false; reason: {pos: Pos; msg: string}} {
    const fail = (
      pos: Pos,
      msg: string,
    ): {ok: false; reason: {pos: Pos; msg: string}} => ({
      ok: false,
      reason: {pos, msg},
    });

    const params = native.params;
    const variadic =
      params.length > 0 && params[params.length - 1].variadic
        ? params[params.length - 1]
        : null;
    const fixedCount = variadic === null ? params.length : params.length - 1;
    const fixed: (syntax.Expr | null)[] = Array(fixedCount).fill(null);
    const tail: syntax.Expr[] = [];
    let position = 0;

    for (const arg of c.args) {
      if (arg.name === null) {
        if (position < fixedCount) {
          fixed[position] = arg.value;
          position += 1;
        } else if (variadic !== null) {
          tail.push(arg.value);
        } else {
          return fail(
            arg.pos,
            `too many arguments in call to '${native.name}'`,
          );
        }
        continue;
      }
      const index = params.findIndex(p => p.name === arg.name!.value);
      if (index === -1) {
        return fail(
          arg.pos,
          `unknown argument '${arg.name.value}' in call to '${native.name}'`,
        );
      }
      if (params[index].variadic) {
        return fail(
          arg.pos,
          `argument '${arg.name.value}' cannot be passed by name`,
        );
      }
      if (fixed[index] !== null) {
        return fail(arg.pos, `duplicate argument '${arg.name.value}'`);
      }
      fixed[index] = arg.value;
    }

    for (const [i, param] of params.entries()) {
      if (!param.required) {
        continue;
      }
      const missing = param.variadic ? tail.length === 0 : fixed[i] === null;
      if (missing) {
        return fail(
          c.pos,
          `missing argument '${param.name}' in call to '${native.name}'`,
        );
      }
    }

    const aligned = [...fixed, ...tail];
    for (const [i, expr] of aligned.entries()) {
      if (expr === null) {
        continue;
      }
      const param = params[Math.min(i, params.length - 1)];
      const tv = this.tvOf(expr);
      if (tv.type.kind === TypeKind.Invalid) {
        continue;
      }
      if (!refAssignable(tv.type, param.type)) {
        return fail(
          expr.pos,
          `argument '${param.name}' to '${native.name}': cannot use ${formatType(tv.type)} as ${formatRef(param.type)}`,
        );
      }
      if (!qualifierLE(tv.qualifier, param.qualifierCap)) {
        return fail(
          expr.pos,
          `argument '${param.name}' to '${native.name}' accepts at most ${param.qualifierCap}, got ${tv.qualifier}`,
        );
      }
      if (param.constLiteral && tv.value === null) {
        return fail(
          expr.pos,
          `argument '${param.name}' to '${native.name}' must be a constant literal`,
        );
      }
    }
    return {ok: true, args: aligned};
  }

  // A request call: the captured expression re-checks in a CHILD context —
  // fresh side tables and a fresh ambient pool, so `close` inside it is the
  // child symbol's close. The call's result takes the capture's type and is
  // always series (merged per parent bar).
  private checkRequest(
    c: syntax.CallExpr,
    native: NativeFunc,
    args: readonly (syntax.Expr | null)[],
  ): TypeAndValue {
    const captureIndex = native.params.findIndex(p => p.capture);
    const expr = args[captureIndex];
    if (expr === null || expr === undefined) {
      return fatal(`request native '${native.name}' matched without a capture`);
    }
    const savedTables = this.tables;
    const savedPool = this.seriesPool;
    const tables = newSideTables();
    bindExpressionNames(expr, this.scope, tables);
    this.tables = tables;
    this.seriesPool = new Map();
    this.captureDepth += 1;
    const captureTv = this.checkExpr(expr);
    this.captureDepth -= 1;
    this.seriesPool = savedPool;
    this.tables = savedTables;
    if (captureTv.type.kind === TypeKind.Void) {
      this.error(expr.pos, 'request expression has no value');
      return INVALID_TV;
    }
    this.info.captures.set(c, {tables, resultType: captureTv.type});
    return {type: captureTv.type, qualifier: Qualifier.Series, value: null};
  }

  private checkPlacement(native: NativeFunc, pos: Pos): void {
    const topLevelOnly =
      native.effect === Effect.Param ||
      native.effect === Effect.Output ||
      native.effect === Effect.Declaration;
    if (
      topLevelOnly &&
      (this.blockDepth > 0 ||
        this.funcBoundary !== null ||
        this.captureDepth > 0)
    ) {
      this.error(
        pos,
        `'${native.name}' can only be called at the top level of the script`,
      );
    }
  }

  private callResultTv(
    native: NativeFunc,
    args: readonly (syntax.Expr | null)[],
  ): TypeAndValue {
    const tvs = args
      .filter((a): a is syntax.Expr => a !== null)
      .map(a => this.tvOf(a));
    const qualifier =
      native.resultQualifier === JoinResult
        ? tvs.reduce<Qualifier>(
            (q, tv) => joinQualifiers(q, tv.qualifier),
            Qualifier.Const,
          )
        : native.resultQualifier;
    let value: ConstValue | null = null;
    if (qualifier === Qualifier.Const && native.effect === Effect.None) {
      value = foldNativeCall(native.name, tvs);
    }
    return {type: native.result, qualifier, value};
  }

  private checkNew(c: syntax.CallExpr, udt: UdtType): TypeAndValue {
    const fields = udt.fields;
    const aligned: (syntax.Expr | null)[] = Array(fields.length).fill(null);
    let position = 0;
    for (const arg of c.args) {
      if (arg.name === null) {
        if (position >= fields.length) {
          this.error(
            arg.pos,
            `too many arguments in call to '${udt.name}.new'`,
          );
          return INVALID_TV;
        }
        aligned[position] = arg.value;
        position += 1;
        continue;
      }
      const index = fields.findIndex(f => f.name === arg.name!.value);
      if (index === -1) {
        this.error(arg.pos, `'${udt.name}' has no field '${arg.name.value}'`);
        return INVALID_TV;
      }
      if (aligned[index] !== null) {
        this.error(arg.pos, `duplicate argument '${arg.name.value}'`);
        return INVALID_TV;
      }
      aligned[index] = arg.value;
    }
    const defaults = this.info.udtDefaults.get(udt);
    let qualifier: Qualifier = Qualifier.Const;
    for (const [i, field] of fields.entries()) {
      const expr = aligned[i];
      if (expr === null) {
        if (defaults === undefined || !defaults.has(field.name)) {
          this.error(
            c.pos,
            `missing argument '${field.name}' in call to '${udt.name}.new'`,
          );
        }
        continue;
      }
      const tv = this.tvOf(expr);
      if (
        tv.type.kind !== TypeKind.Invalid &&
        !assignable(tv.type, field.type)
      ) {
        this.error(
          expr.pos,
          `cannot use ${formatType(tv.type)} as ${formatType(field.type)} for field '${field.name}'`,
        );
      }
      qualifier = joinQualifiers(qualifier, tv.qualifier);
    }
    this.tables.news.set(c, {udt, args: aligned});
    return {type: udt, qualifier, value: null};
  }
}

// ---- pure helpers -----------------------------------------------------------

function isNumericType(t: Type): boolean {
  return (
    t.kind === TypeKind.Int ||
    t.kind === TypeKind.Float ||
    t.kind === TypeKind.Na
  );
}

function numericResult(a: Type, b: Type): Type {
  if (a.kind === TypeKind.Float || b.kind === TypeKind.Float) {
    return FloatType;
  }
  if (a.kind === TypeKind.Int || b.kind === TypeKind.Int) {
    return IntType;
  }
  return NaType;
}

// Branch-type join for statement-position structures: mismatched or void
// branches make the whole structure valueless instead of an error.
function unifyOrVoid(a: Type, b: Type): Type {
  if (a.kind === TypeKind.Void || b.kind === TypeKind.Void) {
    return VoidType;
  }
  return unifyTypes(a, b) ?? VoidType;
}

function refAssignable(from: Type, to: NativeTypeRef): boolean {
  if (to === TypeRef.Num) {
    return assignable(from, FloatType);
  }
  if (to === TypeRef.Any) {
    return from.kind !== TypeKind.Void;
  }
  return assignable(from, to);
}

function formatRef(ref: NativeTypeRef): string {
  if (ref === TypeRef.Num) {
    return 'a numeric value';
  }
  if (ref === TypeRef.Any) {
    return 'a value';
  }
  return formatType(ref);
}

// The scanner keeps quotes and escapes raw in the lexeme.
function unquoteString(lit: string): string {
  if (lit.length < 2) {
    return '';
  }
  const quote = lit[0];
  const end = lit[lit.length - 1] === quote ? lit.length - 1 : lit.length;
  let out = '';
  for (let i = 1; i < end; i += 1) {
    const ch = lit[i];
    if (ch !== '\\' || i + 1 >= end) {
      out += ch;
      continue;
    }
    i += 1;
    const escaped = lit[i];
    out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
  }
  return out;
}

function foldBinary(
  op: Op,
  x: TypeAndValue,
  y: TypeAndValue,
  resultType: Type,
): ConstValue | null {
  const a = x.value;
  const b = y.value;
  if (a === null || b === null || isNaValue(a) || isNaValue(b)) {
    return null;
  }
  if (op === Op.And || op === Op.Or) {
    if (typeof a !== 'boolean' || typeof b !== 'boolean') {
      return null;
    }
    return op === Op.And ? a && b : a || b;
  }
  if (op === Op.EqEq) {
    return a === b;
  }
  if (op === Op.NotEq) {
    return a !== b;
  }
  if (typeof a === 'string' && typeof b === 'string' && op === Op.Plus) {
    return a + b;
  }
  if (typeof a !== 'number' || typeof b !== 'number') {
    return null;
  }
  switch (op) {
    case Op.Lt:
      return a < b;
    case Op.Le:
      return a <= b;
    case Op.Gt:
      return a > b;
    case Op.Ge:
      return a >= b;
    case Op.Plus:
      return a + b;
    case Op.Minus:
      return a - b;
    case Op.Star:
      return a * b;
    case Op.Slash:
      if (b === 0) {
        return null;
      }
      // Pine integer division truncates toward zero.
      return resultType.kind === TypeKind.Int ? Math.trunc(a / b) : a / b;
    case Op.Percent:
      return b === 0 ? null : a % b;
    default:
      return null;
  }
}

// Value folders for pure numeric natives; keyed by catalog name. Applied only
// when every provided argument folded to a number.
const NATIVE_FOLDERS: Record<string, (xs: readonly number[]) => number> = {
  'math.abs': xs => Math.abs(xs[0]),
  'math.sign': xs => Math.sign(xs[0]),
  'math.floor': xs => Math.floor(xs[0]),
  'math.ceil': xs => Math.ceil(xs[0]),
  'math.round': xs =>
    xs.length > 1
      ? Math.round(xs[0] * 10 ** xs[1]) / 10 ** xs[1]
      : Math.round(xs[0]),
  'math.sqrt': xs => Math.sqrt(xs[0]),
  'math.pow': xs => xs[0] ** xs[1],
  'math.log': xs => Math.log(xs[0]),
  'math.log10': xs => Math.log10(xs[0]),
  'math.exp': xs => Math.exp(xs[0]),
  'math.max': xs => Math.max(...xs),
  'math.min': xs => Math.min(...xs),
  'math.avg': xs => xs.reduce((s, x) => s + x, 0) / xs.length,
  int: xs => Math.trunc(xs[0]),
  float: xs => xs[0],
};

function foldNativeCall(
  name: string,
  tvs: readonly TypeAndValue[],
): ConstValue | null {
  const folder = NATIVE_FOLDERS[name];
  if (folder === undefined) {
    return null;
  }
  const values: number[] = [];
  for (const tv of tvs) {
    if (tv.value === null || typeof tv.value !== 'number') {
      return null;
    }
    values.push(tv.value);
  }
  return folder(values);
}

// A chain of plain Names (`math.max`, `syminfo.tickerid`) usable as a catalog
// path; null when any link is not a bare name.
function dottedPath(
  e: syntax.SelectorExpr,
): {root: string; path: string} | null {
  const parts: string[] = [e.sel.value];
  let x: syntax.Expr = e.x;
  while (x.kind === NodeKind.SelectorExpr) {
    parts.unshift(x.sel.value);
    x = x.x;
  }
  if (x.kind !== NodeKind.Name) {
    return null;
  }
  parts.unshift(x.value);
  return {root: parts[0], path: parts.join('.')};
}
