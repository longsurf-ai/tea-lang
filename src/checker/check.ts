// Purpose: Eager semantic checker over syntax — builds Package/Scope/Object declarations and per-context Info facts, propagates qualifiers, folds constants, and enforces catalog contracts.
//
// Reassignment binding is scope-sensitive and deliberately flow-insensitive:
// a binding written anywhere in one checking context never carries fold values.

import {applyTransparency, rgbColor} from '../base/color';
import {fatal, type Errors} from '../base/print';
import type {Pos} from '../base/pos';
import {unimplemented} from '../base/unimplemented';
import {
  assignable,
  BoolType,
  ColorType,
  FloatType,
  formatType,
  isAggregateType,
  isMapKeyType,
  isStorableType,
  IntType,
  InvalidType,
  isNaValue,
  joinQualifiers,
  NaType,
  qualifierLE,
  NA_VALUE,
  Qualifier,
  StringType,
  Storage,
  TupleType,
  TypeKind,
  typesEqual,
  unifyTypes,
  VoidType,
  type ConstValue,
  type EnumMemberType,
  type EnumType,
  type Type,
  type TypeAndValue,
  type UserType,
} from '../ir/type';
import {ASSIGN_BASE_OP, AssignOp, Mode, NodeKind} from '../syntax/nodes';
import type * as syntax from '../syntax/nodes';
import {LitKind, Op, RESERVED_KEYWORDS} from '../syntax/tokens';
import {
  Effect,
  FirstArgumentResult,
  isNativeRoot,
  JoinResult,
  nativeFuncs,
  nativeVar,
  TypeRef,
  type NativeFunc,
  type GenericTypeRef,
  type NativeResult,
  type NativeTypeRef,
  type NativeVar,
} from './catalog';
import {isImportError, type Importer, type SourcePackage} from './importer';
import {bindExpressionNames, bindFileNames, bindFunctionNames} from './binding';
import {
  CallKind,
  SelectionKind,
  newInfo,
  type CheckedDefaultExpression,
  type CheckedExpression,
  type CheckedWritebackTarget,
  type FunctionInstance,
  type Info,
  type NativeCall,
  type ResolvedMethodReceiver,
  type ResolvedNativeReceiver,
  type SemanticDependency,
} from './info';
import {
  ObjectKind,
  type BuiltinObject,
  type EnumMemberObject,
  type EnumObject,
  type FieldObject,
  type FunctionObject,
  type MethodObject,
  type Object,
  type PackageNameObject,
  type UserTypeObject,
  type VariableObject,
} from './object';
import type {CheckedPackage, Package} from './package';
import {Scope} from './scope';
import {
  BUILTIN_ANNOTATION_TYPES,
  COLLECTION_TYPE_CATALOG,
  METHOD_RESULT_TYPES,
} from './type-catalog';

export type {CallResolution, FunctionInstance, Info} from './info';
export type {CheckedPackage, Package} from './package';

// ---- results ----------------------------------------------------------------

// The pipeline's check stage: one script per compilation for now; libraries
// arrive through the injected Importer
export function checkPackage(
  files: readonly syntax.File[],
  errors: Errors,
  importer: Importer,
): CheckedPackage {
  if (files.length !== 1) {
    return unimplemented('typecheck: multi-file packages', files.length);
  }
  // TODO(sean): support multiple files
  const checker = new Checker(files, errors, importer);
  return checker.checkPackage();
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

const INPUT_SOURCE_DEFAULTS = new Set([
  'open',
  'high',
  'low',
  'close',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
]);

// ---- checker ----------------------------------------------------------------

type PackagePhase = 'checking' | 'checked' | 'failed';

type PackageMemberResult =
  | {readonly matched: false}
  | {
      readonly matched: true;
      readonly object: Object | null;
    };

// All declaration-owned state travels with its semantic package. The checker
// itself remains one compilation-wide session so function stenciling and
// transitive semantic dependencies are shared across package boundaries.
interface PackageState {
  readonly pkg: Package;
  readonly info: Info;
  readonly imports: Package[];
  readonly exports: Map<string, Object>;
  readonly functionDecls: Map<syntax.FuncDecl, FunctionObject>;
  readonly userTypeDecls: Map<syntax.UserTypeDecl, UserTypeObject>;
  readonly finalizedUserTypes: Set<UserTypeObject>;
  readonly enumDecls: Map<syntax.EnumDecl, EnumObject>;
  readonly finalizedEnums: Set<EnumObject>;
  dependencyFailed: boolean;
  phase: PackagePhase;
}

class Checker {
  // The universe scope holds implicit bindings every script sees: one
  // Library entry per builtin library. The global scope chains to it.
  private readonly universe = new Scope(null);
  private readonly rootState: PackageState;
  private currentPackage: PackageState;
  private info: Info;
  private scope: Scope;
  private loopDepth = 0;
  private blockDepth = 0;
  // The qualifier of the enclosing control flow: writes under an `if` whose
  // condition is input-qualified produce values known no earlier than input;
  // loop bodies join series (iteration-dependent values).
  private flowQualifier: Qualifier = Qualifier.Const;

  // Function stenciling state: one semantic instantiation per template and
  // signature, a recursion guard (the static call
  // graph must stay acyclic so frames pre-allocate), and the instantiation
  // root scope — non-null exactly when checking inside a function, where
  // outer-scope writes are forbidden.
  private readonly instances = new Map<FunctionObject, FunctionInstance[]>();
  private readonly instantiating = new Set<FunctionObject>();
  private funcBoundary: Scope | null = null;
  private readonly packageStates = new Map<string, PackageState>();
  private readonly stateByPackage = new Map<Package, PackageState>();
  private readonly userTypeObjectOf = new Map<UserType, UserTypeObject>();
  // Names bound by the implicit imports — the redeclare guard's set; the
  // checker never learns where these libraries come from.
  private readonly implicitNames = new Set<string>();
  private readonly builtins = new Map<string, BuiltinObject>();
  private captureDepth = 0;
  private readonly instanceStack: FunctionInstance[] = [];
  // A method body can be checked once for declaration validation and again for
  // call-specific qualifiers. Owner diagnostics remain single-shot while each
  // concrete instance still gets its own Info.
  private activeMethod: MethodObject | null = null;
  private methodErrorAttempts = 0;
  private readonly reportedMethodDiagnostics = new Map<
    MethodObject,
    Set<string>
  >();
  private readonly invalidInstances = new WeakSet<FunctionInstance>();
  private readonly dependencyCollectors: Set<SemanticDependency>[] = [];
  // Input calls are program-global even when written in a local scope. These
  // sets describe the only local-looking names module.bind can read without
  // the function/capture execution frame that contained the call.
  private readonly inputBindings = new Set<VariableObject>();
  private readonly rootBindNames = new Set<VariableObject>();
  constructor(
    files: readonly syntax.File[],
    private readonly errors: Errors,
    private readonly importer: Importer,
  ) {
    const scope = new Scope(this.universe);
    this.rootState = this.newPackageState(
      files[0]?.pos.base.filename ?? '',
      'main',
      files,
      scope,
    );
    this.currentPackage = this.rootState;
    this.info = this.rootState.info;
    this.scope = scope;

    for (const source of importer.implicit()) {
      const before = errors.count;
      const pkg = this.libraryPackage(source);
      if (errors.count !== before) {
        return fatal(
          `builtin library '${source.path}' failed semantic checking`,
        );
      }
      if (
        !this.universe.declare({
          kind: ObjectKind.PackageName,
          name: pkg.name,
          pkg,
        })
      ) {
        return fatal(`duplicate implicit package name '${pkg.name}'`);
      }
      this.addPackageImport(this.rootState, pkg);
      this.implicitNames.add(pkg.name);
    }
  }

  private newPackageState(
    path: string,
    name: string,
    files: readonly syntax.File[],
    scope: Scope,
  ): PackageState {
    const imports: Package[] = [];
    const exports = new Map<string, Object>();
    const pkg: Package = {path, name, files, scope, imports, exports};
    const state: PackageState = {
      pkg,
      info: newInfo(),
      imports,
      exports,
      functionDecls: new Map(),
      userTypeDecls: new Map(),
      finalizedUserTypes: new Set(),
      enumDecls: new Map(),
      finalizedEnums: new Set(),
      dependencyFailed: false,
      phase: 'checking',
    };
    this.stateByPackage.set(pkg, state);
    return state;
  }

  // Elaborate source into the same semantic Package/Scope/Object graph used
  // by the entry package. Loader syntax never becomes an import API directly.
  private libraryPackage(source: SourcePackage): Package {
    const existing = this.packageStates.get(source.path);
    if (existing !== undefined) {
      if (existing.phase === 'checking') {
        return fatal(
          `source import cycle survived loader resolution at '${source.path}'`,
        );
      }
      return existing.pkg;
    }
    if (source.files.length !== 1) {
      return unimplemented(
        'typecheck: multi-file imported packages',
        source.files.length,
      );
    }

    const before = this.errors.count;
    const file = source.files[0];
    const headers = file.stmtList.filter(isLibraryDeclaration);
    let name = packageFallbackName(source.path);
    if (headers.length === 0) {
      this.error(
        file.pos,
        `library '${source.path}' has no library() declaration`,
      );
    } else {
      name = libraryDeclarationName(headers[0]) ?? name;
      if (!isSourcePackageName(name)) {
        this.error(
          headers[0].pos,
          `library name '${name}' is not a valid source identifier`,
        );
      }
      if (file.stmtList[0] !== headers[0]) {
        this.error(
          headers[0].pos,
          'library() declaration must be the first statement in a library package',
        );
      }
      for (const duplicate of headers.slice(1)) {
        this.error(duplicate.pos, 'duplicate library() declaration');
      }
    }

    const scope = new Scope(null);
    const state = this.newPackageState(source.path, name, source.files, scope);
    this.packageStates.set(source.path, state);
    this.withPackage(state, () => this.checkLibraryFile(file, headers));
    state.phase =
      !state.dependencyFailed && this.errors.count === before
        ? 'checked'
        : 'failed';
    return state.pkg;
  }

  checkPackage(): CheckedPackage {
    const file = this.rootState.pkg.files[0];
    this.withPackage(this.rootState, () => {
      this.checkImports(file);
      this.predeclareNominalTypes(file);
      this.predeclareFunctions(file);
      this.resolveUserTypeMembers(file);
      this.rejectDirectUserTypeCycles([
        ...this.currentPackage.userTypeDecls.values(),
      ]);
      bindFileNames(file, this.scope, this.info);
      this.info.scopes.set(file, this.scope);
      for (const stmt of file.stmtList) {
        if (stmt.kind !== NodeKind.ImportStmt) {
          this.checkStmt(stmt);
        }
      }
      this.validateMethodDeclarations([
        ...this.currentPackage.userTypeDecls.values(),
      ]);
    });
    this.rootState.phase = this.errors.count === 0 ? 'checked' : 'failed';
    return {pkg: this.rootState.pkg, info: this.rootState.info};
  }

  private checkLibraryFile(
    file: syntax.File,
    headers: readonly syntax.ExprStmt[],
  ): void {
    this.checkImports(file);
    this.predeclareNominalTypes(file);
    this.predeclareFunctions(file);
    this.resolveUserTypeMembers(file);
    const owners = [...this.currentPackage.userTypeDecls.values()];
    this.rejectDirectUserTypeCycles(owners);
    bindFileNames(file, this.scope, this.info);
    this.info.scopes.set(file, this.scope);

    const header = headers[0] ?? null;
    for (const stmt of file.stmtList) {
      if (stmt === header) {
        this.checkExpr(stmt.x);
        continue;
      }
      if (stmt.kind === NodeKind.ImportStmt || isLibraryDeclaration(stmt)) {
        continue;
      }
      if (
        stmt.kind === NodeKind.FuncDecl ||
        stmt.kind === NodeKind.UserTypeDecl ||
        stmt.kind === NodeKind.TypeAliasDecl ||
        stmt.kind === NodeKind.EnumDecl
      ) {
        this.checkStmt(stmt);
        continue;
      }
      if (
        stmt.kind === NodeKind.DeclStmt &&
        stmt.mode === Mode.Const &&
        stmt.target.kind === NodeKind.Name
      ) {
        this.checkDecl(stmt);
        continue;
      }
      if (stmt.kind !== NodeKind.BadStmt) {
        this.error(
          stmt.pos,
          'library packages allow only imports, declarations, and single-name const values at the top level',
        );
      }
    }
    this.validateMethodDeclarations(owners);
  }

  private checkImports(file: syntax.File): void {
    for (const stmt of file.stmtList) {
      if (stmt.kind === NodeKind.ImportStmt) {
        this.checkImport(stmt);
      }
    }
  }

  private withPackage(state: PackageState, fn: () => void): void {
    if (
      this.instanceStack.length !== 0 ||
      this.dependencyCollectors.length !== 0 ||
      this.funcBoundary !== null
    ) {
      return fatal('package elaboration entered from a function context');
    }
    const saved = {
      package: this.currentPackage,
      info: this.info,
      scope: this.scope,
      loopDepth: this.loopDepth,
      blockDepth: this.blockDepth,
      flowQualifier: this.flowQualifier,
      captureDepth: this.captureDepth,
      activeMethod: this.activeMethod,
    };
    this.currentPackage = state;
    this.info = state.info;
    this.scope = state.pkg.scope;
    this.loopDepth = 0;
    this.blockDepth = 0;
    this.flowQualifier = Qualifier.Const;
    this.captureDepth = 0;
    this.activeMethod = null;
    fn();
    this.currentPackage = saved.package;
    this.info = saved.info;
    this.scope = saved.scope;
    this.loopDepth = saved.loopDepth;
    this.blockDepth = saved.blockDepth;
    this.flowQualifier = saved.flowQualifier;
    this.captureDepth = saved.captureDepth;
    this.activeMethod = saved.activeMethod;
  }

  private addPackageImport(state: PackageState, pkg: Package): void {
    if (!state.imports.includes(pkg)) {
      state.imports.push(pkg);
    }
  }

  private stateOf(pkg: Package): PackageState {
    return (
      this.stateByPackage.get(pkg) ??
      fatal(`semantic package '${pkg.path}' has no checker state`)
    );
  }

  private predeclareNominalTypes(file: syntax.File): void {
    for (const stmt of file.stmtList) {
      if (stmt.kind === NodeKind.UserTypeDecl) {
        this.predeclareUserType(stmt);
      } else if (stmt.kind === NodeKind.EnumDecl) {
        this.predeclareEnum(stmt);
      }
    }
  }

  private predeclareFunctions(file: syntax.File): void {
    for (const stmt of file.stmtList) {
      if (stmt.kind === NodeKind.FuncDecl) {
        this.declareFunction(stmt);
      }
    }
  }

  private predeclareUserType(decl: syntax.UserTypeDecl): void {
    const fields: FieldObject[] = [];
    const methods: MethodObject[] = [];
    const type: UserType = {
      kind: TypeKind.UserType,
      name: decl.name.value,
      fields,
    };
    const object: UserTypeObject = {
      kind: ObjectKind.UserType,
      pkg: this.currentPackage.pkg,
      exported: decl.exported,
      name: decl.name.value,
      type,
      fields,
      methods,
    };
    if (!this.declare(decl.name, object)) {
      return;
    }
    this.currentPackage.userTypeDecls.set(decl, object);
    this.userTypeObjectOf.set(type, object);
    if (decl.exported) {
      this.currentPackage.exports.set(object.name, object);
    }
  }

  private predeclareEnum(decl: syntax.EnumDecl): void {
    const memberTypes: EnumMemberType[] = [];
    const memberObjects: EnumMemberObject[] = [];
    const type: EnumType = {
      kind: TypeKind.Enum,
      name: decl.name.value,
      members: memberTypes,
    };
    const object: EnumObject = {
      kind: ObjectKind.Enum,
      pkg: this.currentPackage.pkg,
      exported: decl.exported,
      name: decl.name.value,
      type,
      members: memberObjects,
    };
    memberObjects.push(
      ...decl.members.map(member => ({
        kind: ObjectKind.EnumMember,
        name: member.name.value,
        decl: member,
        owner: object,
      })),
    );
    if (!this.declare(decl.name, object)) {
      return;
    }
    this.currentPackage.enumDecls.set(decl, object);
    for (const member of memberObjects) {
      this.info.defs.set(member.decl.name, member);
    }
    if (decl.exported) {
      this.currentPackage.exports.set(object.name, object);
    }
  }

  private resolveUserTypeMembers(file: syntax.File): void {
    for (const stmt of file.stmtList) {
      if (stmt.kind !== NodeKind.UserTypeDecl) {
        continue;
      }
      const owner = this.currentPackage.userTypeDecls.get(stmt);
      if (owner === undefined) {
        continue;
      }
      const fields = owner.fields as FieldObject[];
      const methods = owner.methods as MethodObject[];
      const memberNames = new Set<string>();
      for (const member of stmt.members) {
        const memberName = member.name.value;
        if (memberNames.has(memberName)) {
          this.error(
            member.name.pos,
            `duplicate member '${memberName}' in type '${stmt.name.value}'`,
          );
          continue;
        }
        memberNames.add(memberName);
        if (member.kind === NodeKind.MethodDecl) {
          const seenParams = new Set<string>();
          const paramNames = new Set(
            member.params.map(param => param.name.value),
          );
          const invalidDefaults = new Set<number>();
          const declaredParams = member.params.map(param => {
            if (seenParams.has(param.name.value)) {
              this.error(
                param.name.pos,
                `duplicate parameter '${param.name.value}' in method '${memberName}'`,
              );
            }
            seenParams.add(param.name.value);
            return this.resolveAnnotation(param.paramType);
          });
          for (const [index, param] of member.params.entries()) {
            if (param.defaultValue === null) {
              continue;
            }
            this.checkMethodDefaultReferences(
              param.defaultValue,
              paramNames,
              () => invalidDefaults.add(index),
            );
          }
          const method: MethodObject = {
            kind: ObjectKind.Function,
            pkg: owner.pkg,
            exported: owner.exported,
            name: memberName,
            displayName: `${owner.name}.${memberName}`,
            decl: member,
            base: this.scope,
            receiver: {owner, mode: member.receiverMode},
            declaredParams,
            invalidDefaults,
            declaredResult: this.resolveMethodResult(member.result),
          };
          methods.push(method);
          if (!this.scope.declareMethod(method)) {
            return fatal(
              `duplicate method '${memberName}' survived member checking`,
            );
          }
          this.info.defs.set(member.name, method);
          continue;
        }
        const field = member;
        if (field.fieldType.qualifier !== null) {
          this.error(
            field.fieldType.qualifier.pos,
            `field-level '${field.fieldType.qualifier.value}' is not supported; persistence belongs to the containing variable`,
          );
        }
        const object: FieldObject = {
          kind: ObjectKind.Field,
          owner,
          index: fields.length,
          name: field.name.value,
          type: this.resolveTypeName(field.fieldType.name),
          decl: field,
          defaultValue: null,
        };
        fields.push(object);
        this.info.defs.set(field.name, object);
      }
    }
  }

  private checkMethodDefaultReferences(
    expr: syntax.Expr,
    paramNames: ReadonlySet<string>,
    invalidate: () => void,
  ): void {
    const visitBlock = (block: syntax.Block): void => {
      for (const stmt of block.stmtList) {
        visitStmt(stmt);
      }
    };
    const visitStmt = (stmt: syntax.Stmt): void => {
      switch (stmt.kind) {
        case NodeKind.ExprStmt:
          visitExpr(stmt.x);
          return;
        case NodeKind.DeclStmt:
          visitExpr(stmt.init);
          return;
        case NodeKind.AssignStmt:
          visitExpr(stmt.target);
          visitExpr(stmt.value);
          return;
        case NodeKind.FuncDecl:
          for (const param of stmt.params) {
            if (param.defaultValue !== null) {
              visitExpr(param.defaultValue);
            }
          }
          if (stmt.body.kind === NodeKind.Block) {
            visitBlock(stmt.body);
          } else {
            visitExpr(stmt.body);
          }
          return;
        case NodeKind.UserTypeDecl:
          for (const member of stmt.members) {
            if (member.kind === NodeKind.FieldDecl) {
              if (member.defaultValue !== null) {
                visitExpr(member.defaultValue);
              }
              continue;
            }
            for (const param of member.params) {
              if (param.defaultValue !== null) {
                visitExpr(param.defaultValue);
              }
            }
            if (member.body.kind === NodeKind.Block) {
              visitBlock(member.body);
            } else {
              visitExpr(member.body);
            }
          }
          return;
        case NodeKind.EnumDecl:
          for (const member of stmt.members) {
            if (member.title !== null) {
              visitExpr(member.title);
            }
          }
          return;
        case NodeKind.TypeAliasDecl:
        case NodeKind.ImportStmt:
        case NodeKind.BreakStmt:
        case NodeKind.ContinueStmt:
        case NodeKind.BadStmt:
          return;
      }
    };
    const visitExpr = (current: syntax.Expr): void => {
      switch (current.kind) {
        case NodeKind.Name:
          if (paramNames.has(current.value)) {
            invalidate();
            this.error(
              current.pos,
              `method parameter default cannot reference method parameter '${current.value}'`,
            );
          }
          return;
        case NodeKind.ThisExpr:
          invalidate();
          this.error(
            current.pos,
            "method parameter default cannot reference 'this'",
          );
          return;
        case NodeKind.BasicLit:
        case NodeKind.BadExpr:
          return;
        case NodeKind.UnaryExpr:
        case NodeKind.ParenExpr:
          visitExpr(current.x);
          return;
        case NodeKind.SelectorExpr:
          visitExpr(current.x);
          return;
        case NodeKind.BinaryExpr:
          visitExpr(current.x);
          visitExpr(current.y);
          return;
        case NodeKind.CondExpr:
          visitExpr(current.cond);
          visitExpr(current.then);
          visitExpr(current.else);
          return;
        case NodeKind.CallExpr:
          visitExpr(current.fun);
          for (const arg of current.args) {
            visitExpr(arg.value);
          }
          return;
        case NodeKind.HistoryExpr:
          visitExpr(current.x);
          visitExpr(current.offset);
          return;
        case NodeKind.TupleExpr:
          for (const elem of current.elems) {
            visitExpr(elem);
          }
          return;
        case NodeKind.IfExpr:
          visitExpr(current.cond);
          visitBlock(current.then);
          if (current.else === null) {
            return;
          }
          if (current.else.kind === NodeKind.IfExpr) {
            visitExpr(current.else);
          } else {
            visitBlock(current.else);
          }
          return;
        case NodeKind.ForExpr:
          visitExpr(current.from);
          visitExpr(current.to);
          if (current.step !== null) {
            visitExpr(current.step);
          }
          visitBlock(current.body);
          return;
        case NodeKind.ForInExpr:
          visitExpr(current.x);
          visitBlock(current.body);
          return;
        case NodeKind.WhileExpr:
          visitExpr(current.cond);
          visitBlock(current.body);
          return;
        case NodeKind.SwitchExpr:
          if (current.subject !== null) {
            visitExpr(current.subject);
          }
          for (const arm of current.arms) {
            if (arm.pattern !== null) {
              visitExpr(arm.pattern);
            }
            if (arm.body.kind === NodeKind.Block) {
              visitBlock(arm.body);
            } else {
              visitExpr(arm.body);
            }
          }
          return;
      }
    };
    visitExpr(expr);
  }

  private rejectDirectUserTypeCycles(owners: readonly UserTypeObject[]): void {
    const visiting = new Set<UserTypeObject>();
    const visited = new Set<UserTypeObject>();
    const visit = (owner: UserTypeObject): void => {
      if (visited.has(owner)) {
        return;
      }
      visiting.add(owner);
      for (const field of owner.fields) {
        if (field.type.kind !== TypeKind.UserType) {
          continue;
        }
        const target = this.userTypeObjectOf.get(field.type);
        if (target === undefined) {
          continue;
        }
        if (visiting.has(target)) {
          this.error(
            field.decl.pos,
            `type '${owner.name}' has an infinite value layout through field '${field.name}'`,
          );
          continue;
        }
        visit(target);
      }
      visiting.delete(owner);
      visited.add(owner);
    };
    for (const owner of owners) {
      visit(owner);
    }
  }

  private error(pos: Pos, msg: string): void {
    if (this.activeMethod !== null) {
      this.methodErrorAttempts += 1;
      let diagnostics = this.reportedMethodDiagnostics.get(this.activeMethod);
      if (diagnostics === undefined) {
        diagnostics = new Set();
        this.reportedMethodDiagnostics.set(this.activeMethod, diagnostics);
      }
      const key = `${pos.base.filename}:${pos.line}:${pos.col}:${msg}`;
      if (diagnostics.has(key)) {
        return;
      }
      diagnostics.add(key);
    }
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
      case NodeKind.UserTypeDecl:
        this.checkUserTypeDecl(stmt);
        return null;
      case NodeKind.TypeAliasDecl:
        this.checkTypeAliasDecl(stmt);
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
    name.constValue = constValue;
    this.declare(nameNode, name);
    const init = unwrapParens(d.init);
    const resolved =
      init.kind === NodeKind.CallExpr ? this.info.calls.get(init) : undefined;
    if (
      d.mode === Mode.None &&
      !this.info.reassigned.has(name) &&
      resolved?.kind === CallKind.Native &&
      resolved.native.effect === Effect.Param
    ) {
      this.inputBindings.add(name);
    }
    if (
      this.blockDepth === 0 &&
      this.funcBoundary === null &&
      this.captureDepth === 0 &&
      qualifierLE(name.qualifier, Qualifier.Input)
    ) {
      this.rootBindNames.add(name);
    }
    return initTv;
  }

  // Type, qualifier, and fold value of a single-name declaration.
  private declInfo(
    d: syntax.DeclStmt,
    nameNode: syntax.Name,
    name: VariableObject,
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
    if (initTv.type.kind === TypeKind.Tuple) {
      this.error(
        d.init.pos,
        'tuple values are transport-only and must be destructured at declaration',
      );
      return {type: InvalidType, qualifier: Qualifier.Const, constValue: null};
    }

    let type: Type = initTv.type;
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
      if (this.info.reassigned.has(name)) {
        qualifier = joinQualifiers(qualifier, Qualifier.Series);
      }
    }

    // Fold values travel through names only when reassignment is impossible.
    const foldable =
      d.mode === Mode.Const ||
      (d.mode === Mode.None && !this.info.reassigned.has(name));
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
        d.mode === Mode.None && this.info.reassigned.has(name)
          ? joinQualifiers(qualifier, Qualifier.Series)
          : qualifier;
      this.declare(elemName, name);
    });
  }

  private boundName(node: syntax.Name): VariableObject {
    const object = this.info.defs.get(node);
    if (object?.kind !== ObjectKind.Variable) {
      return fatal(`unbound declaration reached checker: ${node.value}`);
    }
    return object;
  }

  private declare(nameNode: syntax.Name, object: Object): boolean {
    if (
      isNativeRoot(nameNode.value) ||
      (this.currentPackage === this.rootState &&
        this.implicitNames.has(nameNode.value))
    ) {
      this.discardBinding(nameNode, object);
      this.error(nameNode.pos, `cannot redeclare built-in '${nameNode.value}'`);
      return false;
    }
    if (!this.scope.declare(object)) {
      this.discardBinding(nameNode, object);
      this.error(
        nameNode.pos,
        `'${nameNode.value}' is already declared in this scope`,
      );
      return false;
    }
    const existing = this.info.defs.get(nameNode);
    if (existing === undefined) {
      this.info.defs.set(nameNode, object);
      return true;
    }
    if (existing !== object) {
      fatal(`binding identity changed for '${nameNode.value}'`);
    }
    return true;
  }

  private discardBinding(nameNode: syntax.Name, object: Object): void {
    if (object.kind !== ObjectKind.Variable) {
      return;
    }
    if (this.boundName(nameNode) !== object) {
      return fatal(`binding identity changed for '${nameNode.value}'`);
    }
    this.info.defs.delete(nameNode);
    this.info.reassigned.delete(object);
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
    if (entry.kind !== ObjectKind.Variable) {
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
      entry.type.kind === TypeKind.Plot ||
      entry.type.kind === TypeKind.Hline
    ) {
      // Output references are compile-time ids consumed at bind (fill);
      // a reassignable ref could not be resolved before the first bar.
      this.error(target.pos, 'cannot reassign a plot reference');
    }
    const name = entry;
    if (this.info.uses.get(target) !== name) {
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
      this.flowQualifier,
    );
    return written;
  }

  private checkFieldAssign(
    a: syntax.AssignStmt,
    target: syntax.SelectorExpr,
  ): TypeAndValue | null {
    const targetTv = this.checkExpr(target);
    const valueTv = this.checkExpr(a.value);
    if (targetTv.type.kind === TypeKind.Invalid) {
      return null;
    }
    if (a.op !== AssignOp.Define) {
      this.error(a.pos, 'compound assignment to a field is not supported');
      return null;
    }
    const writeback = this.checkedWritebackTarget(target);
    if (writeback === null) {
      return null;
    }
    if (!assignable(valueTv.type, targetTv.type)) {
      this.error(
        a.value.pos,
        `cannot assign ${formatType(valueTv.type)} to field '${target.sel.value}' of type ${formatType(targetTv.type)}`,
      );
    }
    writeback.root.qualifier = joinQualifiers(
      joinQualifiers(writeback.root.qualifier, valueTv.qualifier),
      this.flowQualifier,
    );
    this.info.updates.set(a, writeback);
    return valueTv;
  }

  private checkedWritebackTarget(
    receiver: syntax.Expr,
  ): CheckedWritebackTarget | null {
    const checked: CheckedExpression = {
      expr: receiver,
      info: this.info,
      tv: this.tvOf(receiver),
    };
    if (checked.tv.type.kind === TypeKind.Invalid) {
      return null;
    }
    const fields: FieldObject[] = [];
    let current = unwrapParens(receiver);
    while (current.kind === NodeKind.SelectorExpr) {
      const selection = this.info.selections.get(current);
      if (selection?.kind !== SelectionKind.Field) {
        this.error(receiver.pos, 'mutation requires a current rooted value');
        return null;
      }
      fields.push(selection.field);
      current = unwrapParens(current.x);
    }
    if (current.kind !== NodeKind.Name && current.kind !== NodeKind.ThisExpr) {
      this.error(receiver.pos, 'mutation requires a current rooted value');
      return null;
    }
    const object = this.info.uses.get(current);
    if (object?.kind !== ObjectKind.Variable) {
      this.error(receiver.pos, 'mutation requires a variable root');
      return null;
    }
    if (object.constDecl) {
      this.error(
        receiver.pos,
        current.kind === NodeKind.ThisExpr
          ? "cannot mutate 'this' in a const method"
          : `cannot mutate '${object.name}' declared with const`,
      );
      return null;
    }
    if (
      current.kind === NodeKind.Name &&
      this.funcBoundary !== null &&
      !this.scope.resolvesWithin(current.value, this.funcBoundary)
    ) {
      this.error(
        receiver.pos,
        `cannot modify global variable '${object.name}' inside a function`,
      );
      return null;
    }
    return {receiver: checked, root: object, fields: fields.reverse()};
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
    const imported = this.libraryPackage(outcome);
    if (this.stateOf(imported).phase === 'failed') {
      this.currentPackage.dependencyFailed = true;
    }
    const name = stmt.alias?.value ?? imported.name;
    const object: PackageNameObject = {
      kind: ObjectKind.PackageName,
      name,
      pkg: imported,
    };
    if (stmt.alias !== null) {
      if (this.declare(stmt.alias, object)) {
        this.addPackageImport(this.currentPackage, imported);
      }
      return;
    }
    // Without an alias the library binds under its declared name; implicit
    // libraries are already bound, so this is a legal no-op for them.
    const existing = this.scope.lookup(name);
    if (
      this.currentPackage === this.rootState &&
      this.implicitNames.has(name) &&
      existing?.kind === ObjectKind.PackageName &&
      existing.pkg === imported
    ) {
      this.addPackageImport(this.currentPackage, imported);
      return;
    }
    if (
      isNativeRoot(name) ||
      (this.currentPackage === this.rootState && this.implicitNames.has(name))
    ) {
      this.error(stmt.path.pos, `cannot redeclare built-in '${name}'`);
      return;
    }
    if (!this.scope.declare(object)) {
      this.error(stmt.path.pos, `'${name}' is already declared in this scope`);
      return;
    }
    this.addPackageImport(this.currentPackage, imported);
  }

  private checkFuncDecl(d: syntax.FuncDecl): void {
    if (this.blockDepth > 0) {
      this.error(d.pos, 'functions must be declared at the top level');
      return;
    }
    if (this.currentPackage.functionDecls.has(d)) {
      return;
    }
    this.declareFunction(d);
  }

  private declareFunction(d: syntax.FuncDecl): void {
    const seenParams = new Set<string>();
    const declaredParams = d.params.map(param => {
      if (seenParams.has(param.name.value)) {
        this.error(
          param.name.pos,
          `duplicate parameter '${param.name.value}' in function '${d.name.value}'`,
        );
      }
      seenParams.add(param.name.value);
      return param.paramType === null
        ? null
        : this.resolveAnnotation(param.paramType);
    });
    // The semantic template and written annotations are bound now; its body
    // remains polymorphic and is checked per concrete call signature.
    const object: FunctionObject = {
      kind: ObjectKind.Function,
      pkg: this.currentPackage.pkg,
      exported: d.exported,
      name: d.name.value,
      displayName: d.name.value,
      decl: d,
      base: this.scope,
      receiver: null,
      declaredParams,
    };
    this.currentPackage.functionDecls.set(d, object);
    if (this.declare(d.name, object) && d.exported) {
      this.currentPackage.exports.set(object.name, object);
    }
  }

  private checkUserTypeDecl(d: syntax.UserTypeDecl): void {
    if (this.blockDepth > 0) {
      this.error(d.pos, 'types must be declared at the top level');
      return;
    }
    const owner = this.currentPackage.userTypeDecls.get(d);
    if (owner === undefined) {
      return;
    }
    if (this.currentPackage.finalizedUserTypes.has(owner)) {
      return fatal(`user type '${owner.name}' finalized more than once`);
    }
    for (const field of owner.fields) {
      if (field.decl.defaultValue !== null) {
        const checked = this.checkDefaultExpression(field.decl.defaultValue);
        if (!assignable(checked.tv.type, field.type)) {
          this.error(
            field.decl.defaultValue.pos,
            `cannot use ${formatType(checked.tv.type)} as ${formatType(field.type)} default for field '${field.name}'`,
          );
        }
        field.defaultValue = checked;
      }
    }
    this.currentPackage.finalizedUserTypes.add(owner);
  }

  private validateMethodDeclarations(owners: readonly UserTypeObject[]): void {
    // These instances are checker-only: no syntax CallExpr owns them, so the
    // noder cannot project them into a Program. They establish declaration
    // correctness even when a method is never called.
    for (const owner of owners) {
      for (const method of owner.methods) {
        const receiverQualifier =
          method.receiver.mode === 'mutable'
            ? Qualifier.Series
            : Qualifier.Const;
        const signature: FunctionInstance['signature'] =
          method.declaredParams.map(param => ({
            type: param.type,
            qualifier: param.qualifier ?? Qualifier.Const,
          }));
        let variants = this.instances.get(method);
        if (variants === undefined) {
          variants = [];
          this.instances.set(method, variants);
        }
        const existing = variants.find(
          candidate =>
            !this.invalidInstances.has(candidate) &&
            candidate.receiver?.qualifier === receiverQualifier &&
            functionSignaturesEqual(candidate.signature, signature),
        );
        if (existing !== undefined) {
          continue;
        }
        const argTvs: TypeAndValue[] = signature.map(param => ({
          type: param?.type ?? InvalidType,
          qualifier: param?.qualifier ?? Qualifier.Const,
          value: null,
        }));
        const instance = this.instantiate(
          method,
          method.displayName,
          signature,
          Array<syntax.Expr | null>(method.decl.params.length).fill(null),
          argTvs,
          receiverQualifier,
        );
        variants.push(instance);
      }
    }
  }

  private checkTypeAliasDecl(d: syntax.TypeAliasDecl): void {
    if (this.blockDepth > 0) {
      this.error(d.pos, 'types must be declared at the top level');
      return;
    }
    this.error(d.pos, 'type aliases are not supported yet');
  }

  private checkEnumDecl(d: syntax.EnumDecl): void {
    if (this.blockDepth > 0) {
      this.error(d.pos, 'enums must be declared at the top level');
      return;
    }
    const owner = this.currentPackage.enumDecls.get(d);
    if (owner === undefined) {
      return;
    }
    if (this.currentPackage.finalizedEnums.has(owner)) {
      return fatal(`enum '${owner.name}' finalized more than once`);
    }
    const members = owner.type.members as EnumMemberType[];
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
    this.currentPackage.finalizedEnums.add(owner);
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

  private resolveMethodResult(a: syntax.TypeAnnotation): Type {
    if (a.qualifier !== null) {
      this.error(a.qualifier.pos, 'method result qualifiers are not supported');
    }
    if (a.name.kind === NodeKind.Name) {
      const result = METHOD_RESULT_TYPES.get(a.name.value);
      if (result !== undefined) {
        return result;
      }
    }
    return this.resolveTypeName(a.name);
  }

  private resolveTypeName(t: syntax.TypeName): Type {
    switch (t.kind) {
      case NodeKind.Name: {
        const builtin = BUILTIN_ANNOTATION_TYPES.get(t.value);
        if (builtin !== undefined) {
          return builtin;
        }
        const entry = this.scope.lookup(t.value);
        if (
          entry?.kind === ObjectKind.UserType ||
          entry?.kind === ObjectKind.Enum
        ) {
          this.info.uses.set(t, entry);
          return entry.type;
        }
        this.error(t.pos, `unknown type '${t.value}'`);
        return InvalidType;
      }
      case NodeKind.GenericType: {
        if (t.name.kind !== NodeKind.Name) {
          this.error(
            t.name.pos,
            'qualified collection types are not supported',
          );
          return InvalidType;
        }
        const collection = COLLECTION_TYPE_CATALOG.get(t.name.value);
        if (collection === undefined) {
          this.error(t.name.pos, `unknown generic type '${t.name.value}'`);
          return InvalidType;
        }
        const expected = collection.typeParams.length;
        if (t.args.length !== expected) {
          this.error(
            t.pos,
            `generic type '${t.name.value}' expects ${expected} type argument${expected === 1 ? '' : 's'}, got ${t.args.length}`,
          );
          return InvalidType;
        }
        const args = t.args.map(arg => this.resolveTypeName(arg));
        if (args.some(arg => arg.kind === TypeKind.Invalid)) {
          return InvalidType;
        }
        collection.typeParams.forEach((param, index) => {
          if (param.constraint === 'map-key' && !isMapKeyType(args[index])) {
            this.error(
              t.args[index].pos,
              `${formatType(args[index])} is not a valid map key type`,
            );
          }
          if (param.constraint === 'storable' && !isStorableType(args[index])) {
            this.error(
              t.args[index].pos,
              `${formatType(args[index])} cannot be stored in a collection`,
            );
          }
        });
        if (collection.name === 'map') {
          return {kind: TypeKind.Map, key: args[0], value: args[1]};
        }
        return collection.name === 'array'
          ? {kind: TypeKind.Array, elem: args[0]}
          : {kind: TypeKind.Matrix, elem: args[0]};
      }
      case NodeKind.ArrayType: {
        const elem = this.resolveTypeName(t.elem);
        if (elem.kind !== TypeKind.Invalid && !isStorableType(elem)) {
          this.error(
            t.elem.pos,
            `${formatType(elem)} cannot be stored in a collection`,
          );
        }
        return {kind: TypeKind.Array, elem};
      }
      case NodeKind.SelectorExpr: {
        if (t.x.kind === NodeKind.Name) {
          const member = this.packageMember(t.x, t.sel);
          if (member.matched) {
            if (
              member.object?.kind === ObjectKind.UserType ||
              member.object?.kind === ObjectKind.Enum
            ) {
              return member.object.type;
            }
            this.error(t.pos, `unknown type '${t.x.value}.${t.sel.value}'`);
            return InvalidType;
          }
        }
        this.error(t.pos, 'qualified type name must be package.Type');
        return InvalidType;
      }
    }
  }

  private packageMember(
    packageName: syntax.Name,
    memberName: syntax.Name,
  ): PackageMemberResult {
    const binding = this.scope.lookup(packageName.value);
    if (binding?.kind !== ObjectKind.PackageName) {
      return {matched: false};
    }
    this.info.uses.set(packageName, binding);
    const object = binding.pkg.exports.get(memberName.value) ?? null;
    if (object !== null) {
      this.info.uses.set(memberName, object);
    }
    return {matched: true, object};
  }

  // ---- expressions ----------------------------------------------------------

  private checkExpr(e: syntax.Expr): TypeAndValue {
    const tv = this.exprTv(e);
    this.info.types.set(e, tv);
    return tv;
  }

  private tvOf(e: syntax.Expr): TypeAndValue {
    return this.info.types.get(e) ?? INVALID_TV;
  }

  private exprTv(e: syntax.Expr): TypeAndValue {
    switch (e.kind) {
      case NodeKind.Name:
        return this.resolveName(e);
      case NodeKind.ThisExpr:
        return this.rejectBareThis(e);
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

  private rejectBareThis(e: syntax.ThisExpr): TypeAndValue {
    const instance = this.instanceStack[this.instanceStack.length - 1];
    if (instance?.receiver === null || instance === undefined) {
      this.error(e.pos, "'this' is available only inside a method");
    } else {
      this.error(
        e.pos,
        "bare 'this' cannot be used as a value; select a field or method",
      );
    }
    return INVALID_TV;
  }

  private checkSelectorBase(e: syntax.Expr): TypeAndValue {
    if (e.kind === NodeKind.ThisExpr) {
      const instance = this.instanceStack[this.instanceStack.length - 1];
      const receiver = instance?.receiver;
      if (receiver === null || receiver === undefined) {
        this.error(e.pos, "'this' is available only inside a method");
        this.info.types.set(e, INVALID_TV);
        return INVALID_TV;
      }
      const tv: TypeAndValue = {
        type: receiver.type,
        qualifier: receiver.qualifier,
        value: null,
      };
      this.info.uses.set(e, receiver);
      this.info.types.set(e, tv);
      return tv;
    }
    if (e.kind === NodeKind.ParenExpr) {
      const tv = this.checkSelectorBase(e.x);
      this.info.types.set(e, tv);
      return tv;
    }
    return this.checkExpr(e);
  }

  private resolveName(n: syntax.Name): TypeAndValue {
    const entry = this.scope.lookup(n.value);
    if (entry !== null) {
      switch (entry.kind) {
        case ObjectKind.Variable: {
          if (
            this.funcBoundary !== null &&
            !this.scope.resolvesWithin(n.value, this.funcBoundary)
          ) {
            // Reading an outer-scope variable pins the instance to the
            // context it was checked in.
            this.recordFunctionDependency(entry);
          } else if (this.captureDepth > 0 && this.funcBoundary === null) {
            const allowed = this.requestVariableAllowed(entry);
            if (!allowed.ok && !allowed.computed) {
              // Per-context state must be recomputed inside the expression.
              this.error(
                n.pos,
                `request expressions cannot reference script variable '${n.value}'; only direct input bindings cross contexts`,
              );
              return INVALID_TV;
            }
            if (!allowed.ok) {
              // A computed input alias is a root-frame value, not a
              // compilation-global ParamInput. The child Program therefore
              // has no valid place from which to read it.
              this.error(
                n.pos,
                `request expressions cannot capture computed script variable '${n.value}'; pass a direct input binding or recompute it inside the expression`,
              );
              return INVALID_TV;
            }
          }
          this.recordExpressionDependency(entry);
          this.info.uses.set(n, entry);
          return {
            type: entry.type,
            qualifier: entry.qualifier,
            value: entry.constValue,
          };
        }
        case ObjectKind.Function:
          this.error(n.pos, `'${n.value}' is a function; call it`);
          return INVALID_TV;
        case ObjectKind.UserType:
        case ObjectKind.Enum:
          this.error(n.pos, `'${n.value}' is a type, not a value`);
          return INVALID_TV;
        case ObjectKind.PackageName:
          this.error(n.pos, `'${n.value}' is a package, not a value`);
          return INVALID_TV;
        case ObjectKind.Field:
        case ObjectKind.EnumMember:
        case ObjectKind.Builtin:
          return fatal(`invalid lexical object '${entry.name}'`);
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

  // Native variables resolve to semantic builtin objects. Noding projects a
  // non-const builtin into one SeriesInput per Program context.
  private nativeVarTv(nv: NativeVar, node: syntax.Expr): TypeAndValue {
    let builtin = this.builtins.get(nv.name);
    if (builtin === undefined) {
      builtin = {
        kind: ObjectKind.Builtin,
        name: nv.name,
        hostId: nv.name,
        type: nv.type,
        qualifier: nv.qualifier,
        value: nv.value,
      };
      this.builtins.set(nv.name, builtin);
    }
    if (node.kind === NodeKind.Name) {
      this.info.uses.set(node, builtin);
    } else if (node.kind === NodeKind.SelectorExpr) {
      this.info.selections.set(node, {
        kind: SelectionKind.Builtin,
        builtin,
      });
    }
    if (nv.qualifier !== Qualifier.Const) {
      this.recordFunctionDependency(builtin);
    }
    return {type: nv.type, qualifier: nv.qualifier, value: nv.value};
  }

  private recordExpressionDependency(dependency: SemanticDependency): void {
    for (const collector of this.dependencyCollectors) {
      collector.add(dependency);
    }
  }

  private recordFunctionDependency(dependency: SemanticDependency): void {
    this.recordExpressionDependency(dependency);
    const top = this.instanceStack[this.instanceStack.length - 1];
    top?.dependencies.add(dependency);
  }

  private recordTransitiveDependencies(
    dependencies: ReadonlySet<SemanticDependency>,
  ): void {
    for (const dependency of dependencies) {
      this.recordFunctionDependency(dependency);
    }
  }

  private checkDefaultExpression(expr: syntax.Expr): CheckedDefaultExpression {
    const info = this.info;
    const dependencies = new Set<SemanticDependency>();
    this.dependencyCollectors.push(dependencies);
    const tv = this.checkExpr(expr);
    this.dependencyCollectors.pop();
    if (this.info !== info) {
      return fatal('default expression changed the active semantic context');
    }
    return {expr, info, tv, dependencies};
  }

  private requestVariableAllowed(
    object: VariableObject,
  ): {readonly ok: true} | {readonly ok: false; readonly computed: boolean} {
    if (!qualifierLE(object.qualifier, Qualifier.Input)) {
      return {ok: false, computed: false};
    }
    if (object.constValue === null && !this.inputBindings.has(object)) {
      return {ok: false, computed: true};
    }
    return {ok: true};
  }

  private checkRequestDependencies(
    call: syntax.CallExpr,
    displayName: string,
    dependencies: ReadonlySet<SemanticDependency>,
  ): boolean {
    for (const dependency of dependencies) {
      if (dependency.kind === ObjectKind.Builtin) {
        continue;
      }
      const allowed = this.requestVariableAllowed(dependency);
      if (allowed.ok) {
        continue;
      }
      this.error(
        call.pos,
        allowed.computed
          ? `'${displayName}' captures computed script variable '${dependency.name}' and cannot be used in a request expression`
          : `'${displayName}' reads script variable '${dependency.name}' and cannot be used in a request expression`,
      );
      return false;
    }
    return true;
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
    if (s.x.kind === NodeKind.SelectorExpr && s.x.x.kind === NodeKind.Name) {
      const qualified = this.packageMember(s.x.x, s.x.sel);
      if (qualified.matched) {
        const written = `${s.x.x.value}.${s.x.sel.value}`;
        if (qualified.object?.kind === ObjectKind.Enum) {
          return this.enumMemberTv(qualified.object, s.sel, written);
        }
        this.error(s.x.pos, `unknown enum '${written}'`);
        return INVALID_TV;
      }
    }
    if (s.x.kind === NodeKind.Name) {
      const entry = this.scope.lookup(s.x.value);
      if (entry?.kind === ObjectKind.Enum) {
        this.info.uses.set(s.x, entry);
        return this.enumMemberTv(entry, s.sel, entry.name);
      }
      if (entry?.kind === ObjectKind.UserType) {
        this.error(s.pos, `'${s.x.value}' is a type, not a value`);
        return INVALID_TV;
      }
      if (entry?.kind === ObjectKind.Function) {
        this.error(s.pos, `'${s.x.value}' is a function, not a value`);
        return INVALID_TV;
      }
    }
    const baseTv = this.checkSelectorBase(s.x);
    if (baseTv.type.kind === TypeKind.Invalid) {
      return INVALID_TV;
    }
    if (baseTv.type.kind === TypeKind.UserType) {
      const field = baseTv.type.fields.find(
        object => object.name === s.sel.value,
      ) as FieldObject | undefined;
      if (field === undefined) {
        this.error(
          s.sel.pos,
          `${formatType(baseTv.type)} has no field '${s.sel.value}'`,
        );
        return INVALID_TV;
      }
      this.info.selections.set(s, {kind: SelectionKind.Field, field});
      return {
        type: field.type,
        qualifier: baseTv.qualifier,
        value: null,
      };
    }
    this.error(
      s.sel.pos,
      `${formatType(baseTv.type)} has no field '${s.sel.value}'`,
    );
    return INVALID_TV;
  }

  private enumMemberTv(
    owner: EnumObject,
    memberName: syntax.Name,
    displayName: string,
  ): TypeAndValue {
    if (!this.stateOf(owner.pkg).finalizedEnums.has(owner)) {
      this.error(
        memberName.pos,
        `enum '${displayName}' cannot be used before it is declared`,
      );
      return INVALID_TV;
    }
    const member = owner.type.members.find(m => m.name === memberName.value);
    const memberObject = owner.members.find(
      object => object.name === memberName.value,
    );
    if (member === undefined) {
      this.error(
        memberName.pos,
        `enum '${displayName}' has no member '${memberName.value}'`,
      );
      return INVALID_TV;
    }
    if (memberObject !== undefined) {
      this.info.uses.set(memberName, memberObject);
    }
    return {
      type: owner.type,
      qualifier: Qualifier.Const,
      value: member.name,
    };
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
          value: canonicalConst(Number(lit.value)),
        };
      case LitKind.Float:
        return {
          type: FloatType,
          qualifier: Qualifier.Const,
          value: canonicalConst(Number(lit.value)),
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
        tv.value === null
          ? null
          : isNaValue(tv.value)
            ? NA_VALUE
            : typeof tv.value === 'number'
              ? canonicalConst(-tv.value)
              : null;
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

    if (
      (op === Op.EqEq ||
        op === Op.NotEq ||
        op === Op.Lt ||
        op === Op.Le ||
        op === Op.Gt ||
        op === Op.Ge) &&
      (x.type.kind === TypeKind.Na || y.type.kind === TypeKind.Na)
    ) {
      this.error(
        pos,
        'cannot use bare na in a comparison; use na(...) to test missing values',
      );
      return INVALID_TV;
    }

    if (op === Op.EqEq || op === Op.NotEq) {
      if (
        isAggregateType(x.type) ||
        isAggregateType(y.type) ||
        x.type.kind === TypeKind.Tuple ||
        y.type.kind === TypeKind.Tuple
      ) {
        this.error(
          pos,
          `aggregate equality is not defined (${formatType(x.type)} and ${formatType(y.type)})`,
        );
        return INVALID_TV;
      }
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
    if (
      qualifier === Qualifier.Const &&
      condTv.value !== null &&
      typeof condTv.value === 'boolean' &&
      thenTv.value !== null &&
      elseTv.value !== null
    ) {
      const branch = condTv.value ? thenTv : elseTv;
      return {type, qualifier, value: branch.value};
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
    if (xTv.type.kind === TypeKind.Tuple) {
      this.error(
        e.x.pos,
        'tuple values are transport-only and cannot be read through history',
      );
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
    e.elems.forEach((elem, i) => {
      if (tvs[i].type.kind === TypeKind.Na) {
        this.error(elem.pos, 'na tuple element requires a concrete type');
      }
    });
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
    const savedFlowQualifier = this.flowQualifier;
    this.flowQualifier = joinQualifiers(savedFlowQualifier, condTv.qualifier);
    const thenTv = this.checkBlock(e.then);
    let elseType: Type | null = null;
    if (e.else !== null) {
      const elseTv =
        e.else.kind === NodeKind.IfExpr
          ? this.checkExpr(e.else)
          : this.checkBlock(e.else);
      elseType = elseTv.type;
    }
    this.flowQualifier = savedFlowQualifier;
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
    this.info.scopes.set(e, this.scope);
    const indexName = this.boundName(e.index);
    indexName.type = indexType;
    indexName.qualifier = Qualifier.Series;
    this.declare(e.index, indexName);
    const bodyTv = this.checkLoopBody(e.body);
    this.scope = savedScope;
    return {type: bodyTv.type, qualifier: Qualifier.Series, value: null};
  }

  private forInTv(e: syntax.ForInExpr): TypeAndValue {
    const xTv = this.checkExpr(e.x);
    let elemType: Type = InvalidType;
    let keyType: Type = IntType;
    let map = false;
    if (xTv.type.kind === TypeKind.Array) {
      elemType = xTv.type.elem;
    } else if (xTv.type.kind === TypeKind.Map) {
      map = true;
      keyType = xTv.type.key;
      elemType = xTv.type.value;
    } else if (xTv.type.kind !== TypeKind.Invalid) {
      this.error(
        e.x.pos,
        `for-in requires an array or map, got ${formatType(xTv.type)}`,
      );
    }
    const savedScope = this.scope;
    this.scope = new Scope(savedScope);
    this.info.scopes.set(e, this.scope);
    const declareTarget = (nameNode: syntax.Name, type: Type): void => {
      const name = this.boundName(nameNode);
      name.type = type;
      name.qualifier = Qualifier.Series;
      this.declare(nameNode, name);
    };
    if (e.target.kind === NodeKind.Name) {
      if (map) {
        this.error(
          e.target.pos,
          'map iteration requires a [key, value] target',
        );
        declareTarget(e.target, InvalidType);
      } else {
        declareTarget(e.target, elemType);
      }
    } else if (e.target.elems.length === 2) {
      declareTarget(e.target.elems[0], keyType);
      declareTarget(e.target.elems[1], elemType);
    } else {
      this.error(e.target.pos, 'for-in tuple pattern takes two values');
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
    const savedFlowQualifier = this.flowQualifier;
    this.flowQualifier = joinQualifiers(savedFlowQualifier, Qualifier.Series);
    this.loopDepth += 1;
    const tv = this.checkBlock(body);
    this.loopDepth -= 1;
    this.flowQualifier = savedFlowQualifier;
    return tv;
  }

  private switchTv(e: syntax.SwitchExpr): TypeAndValue {
    const subjectTv = e.subject !== null ? this.checkExpr(e.subject) : null;
    const savedFlowQualifier = this.flowQualifier;
    if (subjectTv !== null) {
      this.flowQualifier = joinQualifiers(
        savedFlowQualifier,
        subjectTv.qualifier,
      );
    }
    let type: Type | null = null;
    let sawDefault = false;
    for (const [index, arm] of e.arms.entries()) {
      if (arm.pattern === null) {
        if (sawDefault) {
          this.error(arm.pos, 'switch may contain only one default arm');
        }
        sawDefault = true;
        if (index !== e.arms.length - 1) {
          this.error(arm.pos, 'switch default arm must be last');
        }
      }
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
          this.flowQualifier = joinQualifiers(
            this.flowQualifier,
            patternTv.qualifier,
          );
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
    this.flowQualifier = savedFlowQualifier;
    return {type: type ?? VoidType, qualifier: Qualifier.Series, value: null};
  }

  private checkBlock(b: syntax.Block): TypeAndValue {
    const savedScope = this.scope;
    this.scope = new Scope(savedScope);
    this.info.scopes.set(b, this.scope);
    this.blockDepth += 1;
    let last: TypeAndValue | null = null;
    let qualifier: Qualifier = Qualifier.Const;
    for (const [i, stmt] of b.stmtList.entries()) {
      const tv = this.checkStmt(stmt);
      if (tv !== null) {
        // A block's result may be consumed at bind time. Its qualifier must
        // therefore account for every evaluated statement, not only the last
        // value: otherwise a UDF could hide series/request work before an
        // input-qualified return and execute it from module.bind.
        qualifier = joinQualifiers(qualifier, tv.qualifier);
      }
      if (i === b.stmtList.length - 1) {
        last = tv;
      }
    }
    this.blockDepth -= 1;
    this.scope = savedScope;
    const result = last ?? VOID_TV;
    return {...result, qualifier};
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
    const fun = c.fun;
    if (fun.kind === NodeKind.Name) {
      const entry = this.scope.lookup(fun.value);
      if (entry !== null) {
        if (entry.kind === ObjectKind.Function) {
          if (c.typeArgs !== null) {
            this.error(c.pos, 'user functions do not accept type arguments');
            return INVALID_TV;
          }
          this.info.uses.set(fun, entry);
          return this.checkUserCall(c, entry);
        }
        if (entry.kind === ObjectKind.UserType) {
          this.info.uses.set(fun, entry);
          this.error(
            c.pos,
            `'${fun.value}' is a type; construct it with '${fun.value}.new(...)'`,
          );
        } else {
          this.error(fun.pos, `'${fun.value}' is not a function`);
        }
        return INVALID_TV;
      }
      return this.resolveNativeCall(c, fun.value, fun.pos, null);
    }
    if (fun.kind === NodeKind.SelectorExpr) {
      if (fun.x.kind === NodeKind.Name && fun.sel.value === 'new') {
        const entry = this.scope.lookup(fun.x.value);
        if (entry?.kind === ObjectKind.UserType) {
          this.info.uses.set(fun.x, entry);
          if (c.typeArgs !== null) {
            this.error(c.pos, 'constructors do not accept type arguments');
            return INVALID_TV;
          }
          return this.checkNew(c, entry);
        }
      }
      if (
        fun.sel.value === 'new' &&
        fun.x.kind === NodeKind.SelectorExpr &&
        fun.x.x.kind === NodeKind.Name
      ) {
        const qualified = this.packageMember(fun.x.x, fun.x.sel);
        if (qualified.matched) {
          const written = `${fun.x.x.value}.${fun.x.sel.value}.new`;
          if (qualified.object?.kind !== ObjectKind.UserType) {
            this.error(fun.pos, `unknown constructor '${written}'`);
            return INVALID_TV;
          }
          if (c.typeArgs !== null) {
            this.error(c.pos, 'constructors do not accept type arguments');
            return INVALID_TV;
          }
          return this.checkNew(c, qualified.object);
        }
      }
      if (fun.x.kind === NodeKind.Name) {
        const qualified = this.packageMember(fun.x, fun.sel);
        if (qualified.matched) {
          const written = `${fun.x.value}.${fun.sel.value}`;
          const template = qualified.object;
          if (template?.kind !== ObjectKind.Function) {
            this.error(fun.pos, `unknown function '${written}'`);
            return INVALID_TV;
          }
          if (c.typeArgs !== null) {
            this.error(c.pos, 'user functions do not accept type arguments');
            return INVALID_TV;
          }
          return this.checkUserCall(c, template, written);
        }
      }
      const path = dottedPath(fun);
      if (path !== null && this.scope.lookup(path.root) === null) {
        return this.resolveNativeCall(c, path.path, fun.pos, null);
      }
      const receiverTv = this.checkSelectorBase(fun.x);
      if (receiverTv.type.kind === TypeKind.Invalid) {
        return INVALID_TV;
      }
      const receiver: CheckedExpression = {
        expr: fun.x,
        info: this.info,
        tv: receiverTv,
      };
      const namespace = collectionNamespace(receiverTv.type);
      if (
        namespace !== null &&
        nativeFuncs(`${namespace}.${fun.sel.value}`) !== null
      ) {
        return this.resolveNativeCall(
          c,
          `${namespace}.${fun.sel.value}`,
          fun.sel.pos,
          receiver,
        );
      }
      if (c.typeArgs !== null) {
        this.error(c.pos, 'user methods do not accept type arguments');
        return INVALID_TV;
      }
      const owner =
        receiverTv.type.kind === TypeKind.UserType
          ? this.userTypeObjectOf.get(receiverTv.type)
          : undefined;
      const methods =
        owner?.methods.filter(method => method.name === fun.sel.value) ?? [];
      if (methods.length === 0) {
        this.error(
          fun.sel.pos,
          `${formatType(receiverTv.type)} has no method '${fun.sel.value}'`,
        );
        return INVALID_TV;
      }
      if (methods.length > 1) {
        return fatal(
          `duplicate method '${fun.sel.value}' survived declaration checking`,
        );
      }
      this.info.uses.set(fun.sel, methods[0]);
      return this.checkUserCall(
        c,
        methods[0],
        methods[0].displayName,
        receiver,
      );
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
    template: FunctionObject,
    displayName = template.displayName,
    receiver: CheckedExpression | null = null,
  ): TypeAndValue {
    const decl = template.decl;
    const params = decl.params;
    const aligned: (syntax.Expr | null)[] = Array<syntax.Expr | null>(
      params.length,
    ).fill(null);
    const argumentEvaluationOrder: number[] = [];
    let position = 0;
    if (receiver !== null && template.receiver === null) {
      return fatal(`non-method '${displayName}' received a method receiver`);
    }
    if (receiver === null && template.receiver !== null) {
      return fatal(`method '${displayName}' checked without its receiver`);
    }
    for (const arg of c.args) {
      if (arg.name === null) {
        if (position >= params.length) {
          this.error(arg.pos, `too many arguments in call to '${displayName}'`);
          return INVALID_TV;
        }
        aligned[position] = arg.value;
        argumentEvaluationOrder.push(position);
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
      argumentEvaluationOrder.push(index);
    }
    for (const [i, p] of params.entries()) {
      if (aligned[i] === null && p.defaultValue === null) {
        this.error(
          c.pos,
          `missing argument '${p.name.value}' in call to '${displayName}'`,
        );
        return INVALID_TV;
      }
      if (
        aligned[i] === null &&
        template.receiver !== null &&
        template.invalidDefaults.has(i)
      ) {
        // The declaration-owner scan already emitted the stable diagnostic.
        // Do not publish a CallResolution that could lower the poisoned
        // default in a caller context.
        return INVALID_TV;
      }
    }
    for (const [index, arg] of aligned.entries()) {
      if (arg === null) {
        argumentEvaluationOrder.push(index);
      }
    }
    if (this.instantiating.has(template)) {
      // The static call graph must stay acyclic: frames pre-allocate along
      // it at bind time.
      this.error(c.pos, `recursive call to '${displayName}'`);
      return INVALID_TV;
    }

    let resolvedReceiver: ResolvedMethodReceiver | null = null;
    let receiverQualifier: Qualifier | null = null;
    if (template.receiver !== null) {
      if (receiver === null) {
        return fatal(`method '${displayName}' lost its receiver`);
      }
      if (
        !this.stateOf(template.receiver.owner.pkg).finalizedUserTypes.has(
          template.receiver.owner,
        )
      ) {
        this.error(
          c.pos,
          `method '${displayName}' cannot be used before type '${template.receiver.owner.name}' is declared`,
        );
        return INVALID_TV;
      }
      if (template.receiver.mode === 'mutable') {
        const writeback = this.checkedWritebackTarget(receiver.expr);
        if (writeback === null) {
          return INVALID_TV;
        }
        this.info.reassigned.add(writeback.root);
        writeback.root.constValue = null;
        writeback.root.qualifier = joinQualifiers(
          writeback.root.qualifier,
          Qualifier.Series,
        );
        receiverQualifier = Qualifier.Series;
        resolvedReceiver = {mode: 'mutable', value: receiver, writeback};
      } else {
        receiverQualifier = receiver.tv.qualifier;
        resolvedReceiver = {mode: 'const', value: receiver};
      }
    }

    const argTvs = aligned.map(e => (e !== null ? this.tvOf(e) : null));
    if (argTvs.some(tv => tv !== null && tv.type.kind === TypeKind.Invalid)) {
      return INVALID_TV;
    }
    const signature = argTvs.map(tv =>
      tv === null ? null : {type: tv.type, qualifier: tv.qualifier},
    );
    let variants = this.instances.get(template);
    if (variants === undefined) {
      variants = [];
      this.instances.set(template, variants);
    }
    let instance = variants.find(
      candidate =>
        !this.invalidInstances.has(candidate) &&
        functionSignaturesEqual(candidate.signature, signature) &&
        (candidate.receiver?.qualifier ?? null) === receiverQualifier,
    );
    if (instance === undefined) {
      instance = this.instantiate(
        template,
        displayName,
        signature,
        aligned,
        argTvs,
        receiverQualifier,
      );
      variants.push(instance);
    }
    const dependencies = new Set(instance.dependencies);
    for (const [i, arg] of aligned.entries()) {
      if (arg === null) {
        const dflt = instance.defaults.get(i);
        if (dflt !== undefined) {
          for (const dependency of dflt.dependencies) {
            dependencies.add(dependency);
          }
        }
      }
    }
    this.recordTransitiveDependencies(dependencies);
    if (
      this.captureDepth > 0 &&
      !this.checkRequestDependencies(c, displayName, dependencies)
    ) {
      return INVALID_TV;
    }
    this.info.calls.set(c, {
      kind: CallKind.Function,
      instance,
      args: aligned,
      argumentEvaluationOrder,
      receiver: resolvedReceiver,
    });
    const result: TypeAndValue = {
      type: instance.resultType,
      qualifier:
        resolvedReceiver?.mode === 'const'
          ? joinQualifiers(
              instance.resultQualifier,
              resolvedReceiver.value.tv.qualifier,
            )
          : instance.resultQualifier,
      value: null,
    };
    return resolvedReceiver?.mode === 'mutable'
      ? {...result, qualifier: Qualifier.Series}
      : result;
  }

  // Stencil the template for one concrete signature: a fresh Info and a
  // scope rooted at the template's base, params adopting the argument types
  // and qualifiers (capped by annotations), body checked once.
  private instantiate(
    template: FunctionObject,
    displayName: string,
    signature: FunctionInstance['signature'],
    aligned: readonly (syntax.Expr | null)[],
    argTvs: readonly (TypeAndValue | null)[],
    receiverQualifier: Qualifier | null,
  ): FunctionInstance {
    const decl = template.decl;
    const saved = {
      package: this.currentPackage,
      scope: this.scope,
      info: this.info,
      flowQualifier: this.flowQualifier,
      loopDepth: this.loopDepth,
      blockDepth: this.blockDepth,
      boundary: this.funcBoundary,
    };
    const info = newInfo();
    bindFunctionNames(
      decl,
      aligned,
      template.base,
      info,
      template.receiver === null ? undefined : template.invalidDefaults,
    );
    const scope = new Scope(template.base);
    this.currentPackage = this.stateOf(template.pkg);
    this.scope = scope;
    this.info = info;
    info.scopes.set(decl, scope);
    this.flowQualifier = Qualifier.Const;
    this.loopDepth = 0;
    this.blockDepth = 0;
    this.funcBoundary = scope;
    this.instantiating.add(template);
    const savedActiveMethod = this.activeMethod;
    const errorAttemptsBefore = this.methodErrorAttempts;
    this.activeMethod = template.receiver === null ? null : template;

    const receiverObject: VariableObject | null =
      template.receiver === null
        ? null
        : {
            kind: ObjectKind.Variable,
            name: 'this',
            storage: Storage.PerBar,
            constDecl: template.receiver.mode === 'const',
            type: template.receiver.owner.type,
            qualifier:
              receiverQualifier ??
              fatal(`method '${displayName}' lost its receiver qualifier`),
            constValue: null,
          };
    const params: VariableObject[] = [];
    const defaults = new Map<number, CheckedDefaultExpression>();
    decl.params.forEach((p, i) => {
      const annotated = template.declaredParams[i];
      let declaredDefault: CheckedDefaultExpression | null = null;
      if (
        template.receiver !== null &&
        p.defaultValue !== null &&
        !template.invalidDefaults.has(i)
      ) {
        const declaredAnnotation =
          annotated ??
          fatal(`method '${displayName}' lost parameter annotation ${i}`);
        declaredDefault = this.checkDefaultExpression(p.defaultValue);
        defaults.set(i, declaredDefault);
        if (!assignable(declaredDefault.tv.type, declaredAnnotation.type)) {
          this.error(
            p.defaultValue.pos,
            `default for parameter '${p.name.value}' in '${displayName}': cannot use ${formatType(declaredDefault.tv.type)} as ${formatType(declaredAnnotation.type)}`,
          );
        }
        if (
          declaredAnnotation.qualifier !== null &&
          !qualifierLE(
            declaredDefault.tv.qualifier,
            declaredAnnotation.qualifier,
          )
        ) {
          this.error(
            p.defaultValue.pos,
            `default for parameter '${p.name.value}' in '${displayName}' accepts at most ${declaredAnnotation.qualifier}, got ${declaredDefault.tv.qualifier}`,
          );
        }
      }
      let tv = argTvs[i];
      if (tv === null) {
        const dflt = p.defaultValue;
        if (dflt === null) {
          // checkUserCall already rejected calls missing a required param.
          return fatal(
            `instantiating '${displayName}' without argument '${p.name.value}'`,
          );
        }
        const checked = declaredDefault ?? this.checkDefaultExpression(dflt);
        tv = checked.tv;
        defaults.set(i, checked);
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
      if (annotated === null && tv.type.kind === TypeKind.Na) {
        const source = aligned[i] ?? p.defaultValue;
        this.error(
          source?.pos ?? p.pos,
          `argument '${p.name.value}' to '${displayName}' needs a concrete type annotation for na`,
        );
      }
      const name = this.boundName(p.name);
      name.type = annotated !== null ? annotated.type : tv.type;
      name.qualifier = this.info.reassigned.has(name)
        ? joinQualifiers(tv.qualifier, Qualifier.Series)
        : tv.qualifier;
      params.push(name);
      this.declare(p.name, name);
    });

    const instance: FunctionInstance = {
      template,
      name: displayName,
      signature,
      receiver: receiverObject,
      params,
      defaults,
      info,
      dependencies: new Set(),
      resultType: InvalidType,
      resultQualifier: Qualifier.Const,
    };
    this.instanceStack.push(instance);
    const bodyTv =
      decl.body.kind === NodeKind.Block
        ? this.checkBlock(decl.body)
        : this.checkExpr(decl.body);
    this.instanceStack.pop();
    if (template.receiver === null) {
      if (bodyTv.type.kind === TypeKind.Na) {
        this.error(
          decl.body.pos,
          `function '${displayName}' cannot infer a result type from na`,
        );
      }
      instance.resultType = bodyTv.type;
    } else {
      if (
        bodyTv.type.kind !== TypeKind.Invalid &&
        template.declaredResult.kind !== TypeKind.Invalid &&
        !assignable(bodyTv.type, template.declaredResult)
      ) {
        this.error(
          decl.body.pos,
          `method '${displayName}' returns ${formatType(bodyTv.type)}, want ${formatType(template.declaredResult)}`,
        );
      }
      instance.resultType = template.declaredResult;
    }
    instance.resultQualifier = bodyTv.qualifier;

    if (this.methodErrorAttempts > errorAttemptsBefore) {
      this.invalidInstances.add(instance);
    }

    this.instantiating.delete(template);
    this.activeMethod = savedActiveMethod;
    this.currentPackage = saved.package;
    this.scope = saved.scope;
    this.info = saved.info;
    this.flowQualifier = saved.flowQualifier;
    this.loopDepth = saved.loopDepth;
    this.blockDepth = saved.blockDepth;
    this.funcBoundary = saved.boundary;
    return instance;
  }

  private resolveNativeCall(
    c: syntax.CallExpr,
    name: string,
    pos: Pos,
    methodReceiver: CheckedExpression | null,
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
    if (
      (methodReceiver !== null &&
        methodReceiver.tv.type.kind === TypeKind.Invalid) ||
      c.args.some(arg => this.tvOf(arg.value).type.kind === TypeKind.Invalid)
    ) {
      return INVALID_TV;
    }
    const explicitTypes =
      c.typeArgs === null
        ? null
        : c.typeArgs.map(typeArg => this.resolveTypeName(typeArg));
    if (
      explicitTypes !== null &&
      explicitTypes.some(type => type.kind === TypeKind.Invalid)
    ) {
      return INVALID_TV;
    }
    let firstReason: {pos: Pos; msg: string} | null = null;
    for (const candidate of candidates) {
      const outcome = this.matchOverload(
        c,
        candidate,
        explicitTypes,
        methodReceiver?.expr ?? null,
      );
      if (outcome.ok) {
        this.checkPlacement(candidate, c.pos);
        if (candidate.effect === Effect.Param) {
          this.checkInputContract(
            c,
            candidate,
            outcome.args,
            outcome.resultType,
          );
        }
        if (candidate.effect === Effect.Request) {
          return this.checkRequest(
            c,
            candidate,
            outcome.args,
            outcome.argumentEvaluationOrder,
          );
        }
        let receiver: ResolvedNativeReceiver | null = null;
        const receiverExpr =
          candidate.params[0]?.name === 'self' ? outcome.args[0] : null;
        if (receiverExpr !== null && receiverExpr !== undefined) {
          const checked: CheckedExpression = {
            expr: receiverExpr,
            info: this.info,
            tv: this.tvOf(receiverExpr),
          };
          if (candidate.params[0].mode === 'inout') {
            const writeback = this.checkedWritebackTarget(receiverExpr);
            if (writeback === null) {
              return INVALID_TV;
            }
            this.info.reassigned.add(writeback.root);
            writeback.root.constValue = null;
            writeback.root.qualifier = joinQualifiers(
              writeback.root.qualifier,
              Qualifier.Series,
            );
            receiver = {mode: 'inout', value: checked, writeback};
          } else {
            receiver = {mode: 'value', value: checked};
          }
        }
        const resolved: NativeCall = {
          kind: CallKind.Native,
          native: candidate,
          args: outcome.args,
          argTypes: outcome.argTypes,
          argumentEvaluationOrder: outcome.argumentEvaluationOrder,
          resultType: outcome.resultType,
          receiver,
        };
        this.info.calls.set(c, resolved);
        const result = this.callResultTv(
          candidate,
          outcome.args,
          outcome.resultType,
        );
        return receiver?.mode === 'inout'
          ? {...result, qualifier: Qualifier.Series, value: null}
          : result;
      }
      if (firstReason === null) {
        firstReason = outcome.reason;
      }
    }
    if (
      firstReason !== null &&
      (candidates.length === 1 ||
        candidates.every(candidate => candidate.effect === Effect.Param) ||
        candidates.every(candidate => candidate.typeParams.length > 0))
    ) {
      this.error(firstReason.pos, firstReason.msg);
    } else {
      this.error(pos, `no matching overload for '${name}'`);
    }
    return INVALID_TV;
  }

  private matchOverload(
    c: syntax.CallExpr,
    native: NativeFunc,
    explicitTypes: readonly Type[] | null,
    methodReceiver: syntax.Expr | null,
  ):
    | {
        ok: true;
        args: readonly (syntax.Expr | null)[];
        argTypes: readonly Type[];
        argumentEvaluationOrder: readonly number[];
        resultType: Type;
      }
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
    const argumentEvaluationOrder: number[] = [];
    let position = 0;
    if (methodReceiver !== null) {
      if (fixedCount === 0 || params[0].name !== 'self') {
        return fail(c.pos, `'${native.name}' is not a method`);
      }
      fixed[0] = methodReceiver;
      argumentEvaluationOrder.push(0);
      position = 1;
    }

    for (const arg of c.args) {
      if (arg.name === null) {
        if (position < fixedCount) {
          fixed[position] = arg.value;
          argumentEvaluationOrder.push(position);
          position += 1;
        } else if (variadic !== null) {
          tail.push(arg.value);
          argumentEvaluationOrder.push(fixedCount + tail.length - 1);
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
      argumentEvaluationOrder.push(index);
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
    if (explicitTypes !== null && native.typeParams.length === 0) {
      return fail(c.pos, `'${native.name}' does not accept type arguments`);
    }
    if (
      explicitTypes !== null &&
      explicitTypes.length !== native.typeParams.length
    ) {
      return fail(
        c.pos,
        `'${native.name}' expects ${native.typeParams.length} type argument${native.typeParams.length === 1 ? '' : 's'}, got ${explicitTypes.length}`,
      );
    }
    const inferred = new Map<string, InferredNativeType>();
    if (explicitTypes !== null) {
      native.typeParams.forEach((param, index) => {
        inferred.set(param.name, {type: explicitTypes[index], locked: true});
      });
    }
    for (const [i, expr] of aligned.entries()) {
      if (expr === null) {
        continue;
      }
      const param = params[Math.min(i, params.length - 1)];
      const reason = inferNativeType(
        this.tvOf(expr).type,
        param.type,
        inferred,
      );
      if (reason !== null) {
        return fail(
          expr.pos,
          `argument '${param.name}' to '${native.name}': ${reason}`,
        );
      }
    }
    for (const param of native.typeParams) {
      const binding = inferred.get(param.name);
      if (binding === undefined) {
        return fail(
          c.pos,
          `cannot infer type argument '${param.name}' for '${native.name}'; provide it explicitly`,
        );
      }
      if (
        (param.constraint === 'storable' && !isStorableType(binding.type)) ||
        (param.constraint === 'map-key' && !isMapKeyType(binding.type))
      ) {
        return fail(
          c.pos,
          `${formatType(binding.type)} does not satisfy ${param.constraint} constraint for '${param.name}'`,
        );
      }
    }
    const argTypes: Type[] = [];
    for (const [i, expr] of aligned.entries()) {
      const param = params[Math.min(i, params.length - 1)];
      const actual = expr === null ? null : this.tvOf(expr).type;
      const instantiated = instantiateNativeParamType(
        param.type,
        inferred,
        actual,
      );
      argTypes.push(instantiated ?? InvalidType);
      if (expr === null) {
        continue;
      }
      const tv = this.tvOf(expr);
      if (tv.type.kind === TypeKind.Invalid) {
        continue;
      }
      const accepted = isGenericTypeRef(param.type)
        ? instantiated !== null && assignable(tv.type, instantiated)
        : refAssignable(tv.type, param.type);
      if (!accepted) {
        const expected =
          typeof param.type === 'string'
            ? formatRef(param.type)
            : instantiated === null
              ? formatRef(param.type)
              : formatType(instantiated);
        return fail(
          expr.pos,
          `argument '${param.name}' to '${native.name}': cannot use ${formatType(tv.type)} as ${expected}`,
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
      if (!param.acceptsNa && tv.value !== null && isNaValue(tv.value)) {
        return fail(
          expr.pos,
          `argument '${param.name}' to '${native.name}' cannot be na`,
        );
      }
      // Known numeric domains fail loudly when the value is known at
      // compile time; runtime (series) values clamp instead.
      const range = CONST_ARG_RANGES[native.name]?.[param.name];
      if (
        range !== undefined &&
        typeof tv.value === 'number' &&
        (tv.value < range[0] || tv.value > range[1])
      ) {
        return fail(
          expr.pos,
          `argument '${param.name}' to '${native.name}' must be between ${range[0]} and ${range[1]}, got ${tv.value}`,
        );
      }
    }
    const resultType = instantiateNativeResult(
      native.result,
      inferred,
      argTypes,
    );
    if (resultType === null) {
      return fail(c.pos, `cannot instantiate result type of '${native.name}'`);
    }
    return {
      ok: true,
      args: aligned,
      argTypes,
      argumentEvaluationOrder,
      resultType,
    };
  }

  // A request call owns a child semantic context. The same call syntax may be
  // checked by multiple function instances, so the capture belongs to this
  // active Info's CallResolution rather than a root-global syntax map.
  private checkRequest(
    c: syntax.CallExpr,
    native: NativeFunc,
    args: readonly (syntax.Expr | null)[],
    argumentEvaluationOrder: readonly number[],
  ): TypeAndValue {
    const captureIndex = native.params.findIndex(p => p.capture);
    const expr = args[captureIndex];
    if (expr === null || expr === undefined) {
      return fatal(`request native '${native.name}' matched without a capture`);
    }
    const parentInfo = this.info;
    const info = newInfo();
    bindExpressionNames(expr, this.scope, info);
    this.info = info;
    this.captureDepth += 1;
    const captureTv = this.checkExpr(expr);
    this.captureDepth -= 1;
    this.info = parentInfo;
    if (captureTv.type.kind === TypeKind.Void) {
      this.error(expr.pos, 'request expression has no value');
      return INVALID_TV;
    }
    if (captureTv.type.kind === TypeKind.Na) {
      this.error(
        expr.pos,
        'request expression na requires a concrete type (for example float(na))',
      );
      return INVALID_TV;
    }
    parentInfo.calls.set(c, {
      kind: CallKind.Request,
      native,
      args,
      argumentEvaluationOrder,
      capture: info,
      resultType: captureTv.type,
    });
    return {type: captureTv.type, qualifier: Qualifier.Series, value: null};
  }

  private checkPlacement(native: NativeFunc, pos: Pos): void {
    if (native.effect === Effect.Param) {
      if (this.instanceStack.some(instance => instance.template.exported)) {
        this.error(
          pos,
          `'${native.name}' cannot be called from an exported function`,
        );
      }
      if (
        this.captureDepth > 0 &&
        native.resultQualifier === Qualifier.Series
      ) {
        this.error(
          pos,
          `'${native.name}' cannot declare a source input inside a request expression`,
        );
      }
      return;
    }
    if (
      (native.effect === Effect.Output ||
        native.effect === Effect.Declaration) &&
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

  // input.* has dependent contracts that cannot be expressed by one static
  // parameter type: options adopt defval's exact type, enum identity is
  // nominal, and source defaults are a closed host vocabulary.
  private checkInputContract(
    c: syntax.CallExpr,
    native: NativeFunc,
    args: readonly (syntax.Expr | null)[],
    resultType: Type,
  ): void {
    const arg = (name: string): syntax.Expr | null => {
      const index = native.params.findIndex(param => param.name === name);
      return index === -1 ? null : (args[index] ?? null);
    };
    const value = (name: string): ConstValue | null => {
      const expr = arg(name);
      return expr === null ? null : this.tvOf(expr).value;
    };

    const displayExpr = arg('display');
    if (displayExpr !== null) {
      const display = this.tvOf(displayExpr).value;
      if (
        display !== 'all' &&
        display !== 'none' &&
        display !== 'data_window' &&
        display !== 'status_line'
      ) {
        this.error(
          displayExpr.pos,
          `'${native.name}' display must be display.all, display.none, display.data_window, or display.status_line`,
        );
      }
    }

    const activeExpr = arg('active');
    if (
      activeExpr !== null &&
      this.inputActiveNeedsUnavailableFrame(activeExpr)
    ) {
      this.error(
        activeExpr.pos,
        `'${native.name}' active cannot depend on local execution state because the input is program-global`,
      );
    }

    const defvalExpr = arg('defval');
    const optionsExpr = arg('options');
    if (defvalExpr !== null && optionsExpr !== null) {
      const tuple = unwrapParens(optionsExpr);
      if (tuple.kind !== NodeKind.TupleExpr) {
        this.error(
          optionsExpr.pos,
          `'${native.name}' options must be a direct tuple literal`,
        );
      } else if (tuple.elems.length === 0) {
        this.error(optionsExpr.pos, `'${native.name}' options cannot be empty`);
      } else {
        const defvalTv = this.tvOf(defvalExpr);
        const optionType =
          native.result === FirstArgumentResult ? defvalTv.type : resultType;
        const optionValues: ConstValue[] = [];
        for (const elem of tuple.elems) {
          const elemTv = this.tvOf(elem);
          if (!assignable(elemTv.type, optionType)) {
            this.error(
              elem.pos,
              `'${native.name}' option must have type ${formatType(optionType)}, got ${formatType(elemTv.type)}`,
            );
          }
          if (elemTv.value === null || isNaValue(elemTv.value)) {
            this.error(
              elem.pos,
              `'${native.name}' options must contain concrete constants`,
            );
            continue;
          }
          if (
            optionValues.some(option => constValuesEqual(option, elemTv.value!))
          ) {
            this.error(
              elem.pos,
              `'${native.name}' options cannot repeat a value`,
            );
          }
          optionValues.push(elemTv.value);
        }
        if (
          defvalTv.value !== null &&
          !isNaValue(defvalTv.value) &&
          optionValues.length > 0 &&
          !optionValues.some(option =>
            constValuesEqual(option, defvalTv.value!),
          )
        ) {
          this.error(
            defvalExpr.pos,
            `'${native.name}' default must be one of its options`,
          );
        }
      }
    }

    const minval = value('minval');
    const maxval = value('maxval');
    const step = value('step');
    const defval = value('defval');
    if (
      typeof minval === 'number' &&
      typeof maxval === 'number' &&
      minval > maxval
    ) {
      this.error(c.pos, `'${native.name}' minval cannot exceed maxval`);
    }
    if (typeof step === 'number' && step <= 0) {
      const stepExpr = arg('step');
      this.error(
        stepExpr?.pos ?? c.pos,
        `'${native.name}' step must be greater than zero`,
      );
    }
    if (
      typeof defval === 'number' &&
      typeof minval === 'number' &&
      defval < minval
    ) {
      this.error(
        defvalExpr?.pos ?? c.pos,
        `'${native.name}' default must be at least minval`,
      );
    }
    if (
      typeof defval === 'number' &&
      typeof maxval === 'number' &&
      defval > maxval
    ) {
      this.error(
        defvalExpr?.pos ?? c.pos,
        `'${native.name}' default must be at most maxval`,
      );
    }

    if (
      native.name === 'input.source' ||
      (native.name === 'input' && native.resultQualifier === Qualifier.Series)
    ) {
      if (defvalExpr === null) {
        return;
      }
      const sourceExpr = unwrapParens(defvalExpr);
      let object: Object | undefined;
      if (sourceExpr.kind === NodeKind.Name) {
        object = this.info.uses.get(sourceExpr);
      } else if (sourceExpr.kind === NodeKind.SelectorExpr) {
        const selection = this.info.selections.get(sourceExpr);
        if (selection?.kind === SelectionKind.Builtin) {
          object = selection.builtin;
        }
      }
      if (
        object?.kind !== ObjectKind.Builtin ||
        !INPUT_SOURCE_DEFAULTS.has(object.hostId)
      ) {
        this.error(
          defvalExpr.pos,
          `'${native.name}' source default must be a built-in source: open, high, low, close, hl2, hlc3, ohlc4, or hlcc4`,
        );
      }
    }
  }

  private inputActiveNeedsUnavailableFrame(expr: syntax.Expr): boolean {
    if (this.tvOf(expr).value !== null) {
      return false;
    }
    switch (expr.kind) {
      case NodeKind.Name: {
        const object = this.info.uses.get(expr);
        return (
          object?.kind === ObjectKind.Variable &&
          !this.inputBindings.has(object) &&
          !this.rootBindNames.has(object)
        );
      }
      case NodeKind.BasicLit:
      case NodeKind.BadExpr:
        return false;
      case NodeKind.ThisExpr:
        return true;
      case NodeKind.UnaryExpr:
      case NodeKind.ParenExpr:
        return this.inputActiveNeedsUnavailableFrame(expr.x);
      case NodeKind.BinaryExpr:
        return (
          this.inputActiveNeedsUnavailableFrame(expr.x) ||
          this.inputActiveNeedsUnavailableFrame(expr.y)
        );
      case NodeKind.CondExpr:
        return (
          this.inputActiveNeedsUnavailableFrame(expr.cond) ||
          this.inputActiveNeedsUnavailableFrame(expr.then) ||
          this.inputActiveNeedsUnavailableFrame(expr.else)
        );
      case NodeKind.CallExpr:
        if (
          this.info.calls.get(expr)?.kind === CallKind.Function &&
          (this.funcBoundary !== null || this.captureDepth > 0)
        ) {
          return true;
        }
        return (
          this.inputActiveNeedsUnavailableFrame(expr.fun) ||
          expr.args.some(arg =>
            this.inputActiveNeedsUnavailableFrame(arg.value),
          )
        );
      case NodeKind.SelectorExpr:
        return this.inputActiveNeedsUnavailableFrame(expr.x);
      case NodeKind.HistoryExpr:
        return (
          this.inputActiveNeedsUnavailableFrame(expr.x) ||
          this.inputActiveNeedsUnavailableFrame(expr.offset)
        );
      case NodeKind.TupleExpr:
        return expr.elems.some(elem =>
          this.inputActiveNeedsUnavailableFrame(elem),
        );
      case NodeKind.IfExpr:
      case NodeKind.ForExpr:
      case NodeKind.ForInExpr:
      case NodeKind.WhileExpr:
      case NodeKind.SwitchExpr:
        // These are series-qualified today and cannot match active's input
        // cap. Keep the ownership check fail-closed if that changes.
        return true;
    }
  }

  private callResultTv(
    native: NativeFunc,
    args: readonly (syntax.Expr | null)[],
    resultType: Type,
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
    return {type: resultType, qualifier, value};
  }

  private checkNew(c: syntax.CallExpr, userType: UserTypeObject): TypeAndValue {
    if (!this.stateOf(userType.pkg).finalizedUserTypes.has(userType)) {
      this.error(
        c.pos,
        `constructor '${userType.name}.new' cannot be used before type '${userType.name}' is declared`,
      );
      return INVALID_TV;
    }
    const fields = userType.fields;
    const aligned: (syntax.Expr | null)[] = Array(fields.length).fill(null);
    const argumentEvaluationOrder: number[] = [];
    let position = 0;
    for (const arg of c.args) {
      if (arg.name === null) {
        if (position >= fields.length) {
          this.error(
            arg.pos,
            `too many arguments in call to '${userType.name}.new'`,
          );
          return INVALID_TV;
        }
        aligned[position] = arg.value;
        argumentEvaluationOrder.push(position);
        position += 1;
        continue;
      }
      const index = fields.findIndex(field => field.name === arg.name!.value);
      if (index === -1) {
        this.error(
          arg.pos,
          `'${userType.name}' has no field '${arg.name.value}'`,
        );
        return INVALID_TV;
      }
      if (aligned[index] !== null) {
        this.error(arg.pos, `duplicate argument '${arg.name.value}'`);
        return INVALID_TV;
      }
      aligned[index] = arg.value;
      argumentEvaluationOrder.push(index);
    }
    const args: {
      field: FieldObject;
      value: CheckedExpression;
      supplied: boolean;
    }[] = [];
    const defaultDependencies = new Set<SemanticDependency>();
    let qualifier: Qualifier = Qualifier.Const;
    for (const [i, field] of fields.entries()) {
      const expr = aligned[i];
      const value =
        expr !== null
          ? {expr, info: this.info, tv: this.tvOf(expr)}
          : field.defaultValue;
      if (value === null) {
        this.error(
          c.pos,
          `missing argument '${field.name}' in call to '${userType.name}.new'`,
        );
        continue;
      }
      if (expr === null && field.defaultValue !== null) {
        for (const dependency of field.defaultValue.dependencies) {
          defaultDependencies.add(dependency);
        }
      }
      const tv = value.tv;
      if (
        tv.type.kind !== TypeKind.Invalid &&
        !assignable(tv.type, field.type)
      ) {
        this.error(
          value.expr.pos,
          `cannot use ${formatType(tv.type)} as ${formatType(field.type)} for field '${field.name}'`,
        );
      }
      qualifier = joinQualifiers(qualifier, tv.qualifier);
      args.push({field, value, supplied: expr !== null});
    }
    for (const arg of args) {
      if (!arg.supplied) {
        argumentEvaluationOrder.push(arg.field.index);
      }
    }
    this.recordTransitiveDependencies(defaultDependencies);
    if (
      this.captureDepth > 0 &&
      !this.checkRequestDependencies(
        c,
        `${userType.name}.new`,
        defaultDependencies,
      )
    ) {
      return INVALID_TV;
    }
    this.info.calls.set(c, {
      kind: CallKind.Constructor,
      type: userType,
      args,
      argumentEvaluationOrder,
    });
    return {type: userType.type, qualifier, value: null};
  }
}

// ---- pure helpers -----------------------------------------------------------

function isLibraryDeclaration(stmt: syntax.Stmt): stmt is syntax.ExprStmt {
  return (
    stmt.kind === NodeKind.ExprStmt &&
    stmt.x.kind === NodeKind.CallExpr &&
    stmt.x.fun.kind === NodeKind.Name &&
    stmt.x.fun.value === 'library'
  );
}

function libraryDeclarationName(stmt: syntax.ExprStmt): string | null {
  if (stmt.x.kind !== NodeKind.CallExpr) {
    return null;
  }
  const title = stmt.x.args[0]?.value;
  return title?.kind === NodeKind.BasicLit && title.litKind === LitKind.String
    ? unquoteString(title.value)
    : null;
}

function packageFallbackName(path: string): string {
  const parts = path.split('/').filter(part => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

function isSourcePackageName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !RESERVED_KEYWORDS.some(keyword => keyword === name)
  );
}

interface InferredNativeType {
  readonly type: Type;
  readonly locked: boolean;
}

function isGenericTypeRef(ref: NativeTypeRef): ref is GenericTypeRef {
  return (
    typeof ref === 'object' &&
    (ref.kind === 'type-param' ||
      ref.kind === 'array' ||
      ref.kind === 'matrix' ||
      ref.kind === 'map')
  );
}

function inferNativeType(
  actual: Type,
  ref: NativeTypeRef,
  inferred: Map<string, InferredNativeType>,
  invariant = false,
): string | null {
  if (!isGenericTypeRef(ref)) {
    return null;
  }
  if (ref.kind === 'type-param') {
    if (actual.kind === TypeKind.Invalid || actual.kind === TypeKind.Na) {
      return null;
    }
    const current = inferred.get(ref.name);
    if (current === undefined) {
      inferred.set(ref.name, {type: actual, locked: invariant});
      return null;
    }
    if (current.locked || invariant) {
      const accepted = invariant
        ? typesEqual(actual, current.type)
        : assignable(actual, current.type);
      if (accepted) {
        if (invariant && !current.locked) {
          inferred.set(ref.name, {type: current.type, locked: true});
        }
        return null;
      }
      return `cannot use ${formatType(actual)} as ${formatType(current.type)}`;
    }
    const unified = unifyTypes(current.type, actual);
    if (unified === null) {
      return `cannot infer one type from ${formatType(current.type)} and ${formatType(actual)}`;
    }
    inferred.set(ref.name, {type: unified, locked: false});
    return null;
  }
  if (ref.kind === 'array') {
    if (actual.kind !== TypeKind.Array) {
      return `cannot use ${formatType(actual)} as an array`;
    }
    return inferNativeType(actual.elem, ref.element, inferred, true);
  }
  if (ref.kind === 'matrix') {
    if (actual.kind !== TypeKind.Matrix) {
      return `cannot use ${formatType(actual)} as a matrix`;
    }
    return inferNativeType(actual.elem, ref.element, inferred, true);
  }
  if (actual.kind !== TypeKind.Map) {
    return `cannot use ${formatType(actual)} as a map`;
  }
  return (
    inferNativeType(actual.key, ref.key, inferred, true) ??
    inferNativeType(actual.value, ref.value, inferred, true)
  );
}

function instantiateNativeParamType(
  ref: NativeTypeRef,
  inferred: ReadonlyMap<string, InferredNativeType>,
  actual: Type | null,
): Type | null {
  if (isGenericTypeRef(ref)) {
    return instantiateGenericType(ref, inferred);
  }
  if (typeof ref === 'object') {
    return ref;
  }
  // NativeCall publishes concrete contextual argument types so noding never
  // has to repeat catalog policy. A bare `na` (or an omitted polymorphic
  // optional) has no useful source type; the established default numeric
  // domain for Num/Any/Nullable is float.
  if (actual === null || actual.kind === TypeKind.Na) {
    if (
      ref === TypeRef.Num ||
      ref === TypeRef.Any ||
      ref === TypeRef.Nullable ||
      ref === TypeRef.StringConvertible
    ) {
      return FloatType;
    }
  }
  return actual;
}

function instantiateGenericType(
  ref: GenericTypeRef,
  inferred: ReadonlyMap<string, InferredNativeType>,
): Type | null {
  if (ref.kind === 'type-param') {
    return inferred.get(ref.name)?.type ?? null;
  }
  if (ref.kind === 'array' || ref.kind === 'matrix') {
    const elem = instantiateNativeParamType(ref.element, inferred, null);
    if (elem === null) {
      return null;
    }
    return ref.kind === 'array'
      ? {kind: TypeKind.Array, elem}
      : {kind: TypeKind.Matrix, elem};
  }
  const key = instantiateNativeParamType(ref.key, inferred, null);
  const value = instantiateNativeParamType(ref.value, inferred, null);
  return key === null || value === null
    ? null
    : {kind: TypeKind.Map, key, value};
}

function instantiateNativeResult(
  result: NativeResult,
  inferred: ReadonlyMap<string, InferredNativeType>,
  argTypes: readonly Type[],
): Type | null {
  if (result === FirstArgumentResult) {
    return argTypes[0] ?? null;
  }
  if (isGenericTypeRef(result)) {
    return instantiateGenericType(result, inferred);
  }
  return result;
}

function collectionNamespace(type: Type): 'array' | 'matrix' | 'map' | null {
  if (type.kind === TypeKind.Array) {
    return 'array';
  }
  if (type.kind === TypeKind.Matrix) {
    return 'matrix';
  }
  if (type.kind === TypeKind.Map) {
    return 'map';
  }
  return null;
}

function functionSignaturesEqual(
  a: FunctionInstance['signature'],
  b: FunctionInstance['signature'],
): boolean {
  return (
    a.length === b.length &&
    a.every((left, i) => {
      const right = b[i];
      if (left === null || right === null) {
        return left === right;
      }
      return (
        left.qualifier === right.qualifier && typesEqual(left.type, right.type)
      );
    })
  );
}

function unwrapParens(e: syntax.Expr): syntax.Expr {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) {
    x = x.x;
  }
  return x;
}

function constValuesEqual(a: ConstValue, b: ConstValue): boolean {
  if (isNaValue(a) || isNaValue(b)) {
    return isNaValue(a) && isNaValue(b);
  }
  // Pine numeric equality does not distinguish +0 from -0. na never reaches
  // input options, so strict equality is the correct constant-domain rule.
  return a === b;
}

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
  if (isGenericTypeRef(to)) {
    return false;
  }
  if (to === TypeRef.Num) {
    return assignable(from, FloatType);
  }
  if (to === TypeRef.Any) {
    return from.kind !== TypeKind.Void;
  }
  if (to === TypeRef.Enum) {
    return from.kind === TypeKind.Enum;
  }
  if (to === TypeRef.Nullable) {
    // A bare na has no type yet; the noder contextualizes this call-site
    // default to float so TypeKind.Na never enters Program IR.
    return from.kind === TypeKind.Na || isNullableType(from);
  }
  if (to === TypeRef.StringConvertible) {
    switch (from.kind) {
      case TypeKind.Na:
      case TypeKind.Int:
      case TypeKind.Float:
      case TypeKind.Bool:
      case TypeKind.String:
      case TypeKind.Color:
      case TypeKind.Enum:
      case TypeKind.Line:
      case TypeKind.Label:
      case TypeKind.Box:
      case TypeKind.Table:
      case TypeKind.Polyline:
      case TypeKind.Linefill:
        return true;
      default:
        return false;
    }
  }
  return assignable(from, to);
}

function formatRef(ref: NativeTypeRef): string {
  if (isGenericTypeRef(ref)) {
    if (ref.kind === 'type-param') {
      return ref.name;
    }
    if (ref.kind === 'array' || ref.kind === 'matrix') {
      return `${ref.kind}<${formatRef(ref.element)}>`;
    }
    return `map<${formatRef(ref.key)}, ${formatRef(ref.value)}>`;
  }
  if (ref === TypeRef.Num) {
    return 'a numeric value';
  }
  if (ref === TypeRef.Any) {
    return 'a value';
  }
  if (ref === TypeRef.Enum) {
    return 'an enum value';
  }
  if (ref === TypeRef.Nullable) {
    return 'a nullable value';
  }
  if (ref === TypeRef.StringConvertible) {
    return 'a scalar, enum, or resource value';
  }
  return formatType(ref);
}

function isNullableType(type: Type): boolean {
  // Keep native nullable matching on the same owner as annotations,
  // assignments, and branch unification. In particular, nominal enums are
  // nullable even though they are not one of the primitive reference kinds.
  return assignable(NaType, type);
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
  if (a === null || b === null) {
    return null;
  }
  if (isNaValue(a) || isNaValue(b)) {
    switch (op) {
      case Op.Plus:
      case Op.Minus:
      case Op.Star:
      case Op.Slash:
      case Op.Percent:
        return NA_VALUE;
      default:
        // Every comparison involving na, including !=, is false.
        return false;
    }
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
      return canonicalConst(a + b);
    case Op.Minus:
      return canonicalConst(a - b);
    case Op.Star:
      return canonicalConst(a * b);
    case Op.Slash:
      if (b === 0) {
        return NA_VALUE;
      }
      // Pine integer division truncates toward zero.
      return canonicalConst(
        resultType.kind === TypeKind.Int ? Math.trunc(a / b) : a / b,
      );
    case Op.Percent:
      return b === 0 ? NA_VALUE : canonicalConst(a % b);
    default:
      return null;
  }
}

// Value folders for pure numeric natives; keyed by catalog name. Applied only
// when every provided argument folded to a number.
// Folders over arbitrary const values (color arithmetic); numeric-only
// folders live in NATIVE_FOLDERS below. na propagates: a NA_VALUE argument
// folds to NA_VALUE, exactly what the runtime helpers do with null/NaN.
const VALUE_FOLDERS: Record<
  string,
  (xs: readonly ConstValue[]) => ConstValue | null
> = {
  'color.new': xs => {
    if (xs.some(isNaValue)) {
      return NA_VALUE;
    }
    return typeof xs[0] === 'string' && typeof xs[1] === 'number'
      ? applyTransparency(xs[0], xs[1])
      : null;
  },
  'color.rgb': xs => {
    if (xs.some(isNaValue)) {
      return NA_VALUE;
    }
    if (
      typeof xs[0] !== 'number' ||
      typeof xs[1] !== 'number' ||
      typeof xs[2] !== 'number'
    ) {
      return null;
    }
    const transp = xs.length > 3 ? xs[3] : null;
    if (transp !== null && typeof transp !== 'number') {
      return null;
    }
    return rgbColor(xs[0], xs[1], xs[2], transp);
  },
};

// Const arguments with a known numeric domain fail loudly at compile time
// (Pine parity); series values clamp at runtime instead.
const CONST_ARG_RANGES: Record<
  string,
  Record<string, readonly [number, number]>
> = {
  indicator: {max_bars_back: [0, 5000]},
  'color.new': {transp: [0, 100]},
  'color.rgb': {
    red: [0, 255],
    green: [0, 255],
    blue: [0, 255],
    transp: [0, 100],
  },
};

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

// @agent invariant: JS NaN is the runtime encoding of numeric na, but the
// compile-time constant domain has exactly one na representation: NA_VALUE.
// Every folder result and folded argument crosses this constructor before it
// can reach another folder or the Program.
function canonicalConst(value: ConstValue): ConstValue {
  return typeof value === 'number' && !Number.isFinite(value)
    ? NA_VALUE
    : value;
}

function foldNativeCall(
  name: string,
  tvs: readonly TypeAndValue[],
): ConstValue | null {
  const valueFolder = VALUE_FOLDERS[name];
  if (valueFolder !== undefined) {
    const values: ConstValue[] = [];
    for (const tv of tvs) {
      if (tv.value === null) {
        return null;
      }
      values.push(canonicalConst(tv.value));
    }
    const value = valueFolder(values);
    return value === null ? null : canonicalConst(value);
  }
  const folder = NATIVE_FOLDERS[name];
  if (folder === undefined) {
    return null;
  }
  const values: number[] = [];
  for (const tv of tvs) {
    if (tv.value === null) {
      return null;
    }
    const value = canonicalConst(tv.value);
    if (isNaValue(value)) {
      return NA_VALUE;
    }
    if (typeof value !== 'number') {
      return null;
    }
    values.push(value);
  }
  return canonicalConst(folder(values));
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
