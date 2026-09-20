// Purpose: Noder — buildProgram() projects a CheckedPackage's semantic objects and per-context Info into a Tea Program, including desugaring and host-interface extraction.
//
// The noder consumes checked, error-free syntax and never re-checks: every
// type and qualifier comes from checked Info facts. Semantic objects resolve
// source identities; this pass projects them into Program-owned IR objects.
// Bad nodes or missing facts here mean the phase barrier was violated — fatal.

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
  type ReadExpr,
  type WritableExpr,
  type HistoryDepth,
  type Name as IrName,
  type Place,
  type SwitchArm,
} from '../ir/node';
import {
  MergeMode,
  ParamConstraintKind,
  ParamDefaultKind,
  type BuiltinInput,
  type IrFunc,
  type MergePolicy,
  type OutputDecl,
  type ParamConstraints,
  type ParamDefault,
  type ParamInput,
  type Program,
  type RequestEdge,
  type SeriesInput,
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
  StringType,
  TypeKind,
  VoidType,
  joinQualifiers,
  unifyTypes,
  typesEqual,
  type ConstValue,
  type Type,
  type TypeAndValue,
} from '../ir/type';
import {
  bindEvaluable,
  builtinInputsOf,
  namesOf,
  requestsOf,
  seriesInputsOf,
  walkIrExpr,
} from '../ir/visit';
import {ASSIGN_BASE_OP, AssignOp, Mode, NodeKind} from '../syntax/nodes';
import type * as syntax from '../syntax/nodes';
import {Op} from '../syntax/tokens';
import {Effect} from '../checker/catalog';
import {
  CallKind,
  SelectionKind,
  type CheckedExpression,
  type CollectionLocation as CheckedCollectionLocation,
  type FunctionInstance,
  type Info,
  type NativeCall,
  type RequestCall,
  type StructFieldStore,
  type OutputColumn,
} from '../checker/info';
import {
  ObjectKind,
  type BuiltinObject,
  type VariableObject,
} from '../checker/object';
import type {CheckedPackage, Package} from '../checker/package';
import {resolveDepths} from './depth';

// Build the Program from checked syntax ("noding"). Requires a clean check —
// compile()'s phase barrier guarantees it.
export function buildProgram(checked: CheckedPackage, errors: Errors): Program {
  const file = checked.pkg.files[0];
  if (file === undefined) {
    return fatal('checked package has no source file');
  }
  return new Noder(checked, errors).build(file);
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

interface FrameLoweringContext {
  readonly kind: 'program' | 'function';
  readonly program: ProgramLoweringContext;
  readonly names: ReadonlySet<IrName>;
  nextSlot: number;
}

class ProgramLoweringContext {
  readonly names = new Map<VariableObject, IrName>();
  readonly series = new Map<BuiltinObject, SeriesInput>();
  readonly builtin = new Map<BuiltinObject, BuiltinInput>();
  readonly funcs = new Map<FunctionInstance, IrFunc>();
  readonly aliasRefs = new Map<VariableObject, Place>();
  readonly requests: RequestEdge[] = [];
  readonly requestsByCall = new Map<RequestCall, RequestEdge>();
  readonly rootFrame: FrameLoweringContext;

  constructor(
    readonly info: Info,
    readonly parent: ProgramLoweringContext | null,
  ) {
    this.rootFrame = {
      kind: 'program',
      program: this,
      names: new Set(),
      nextSlot: 0,
    };
  }
}

class Noder {
  private readonly params: ParamInput[] = [];
  private readonly outputs: OutputDecl[] = [];
  private readonly outputOf = new Map<OutputColumn, OutputDecl>();
  private returnType: Type = VoidType;
  // Parameters remain call-site declarations; output columns are name-owned.
  private readonly paramOf = new Map<syntax.CallExpr, ParamInput>();
  // Compile-time reference bindings: `len = input.int(...)` binds to its
  // parameter instead of emitting a
  // per-bar write (only when the name is never reassigned).
  private readonly paramRefs = new Map<VariableObject, ParamInput>();
  private nesting = 0;
  private version = 1;
  private info: Info;
  private program: ProgramLoweringContext;
  private frame: FrameLoweringContext;
  constructor(
    private readonly checked: CheckedPackage,
    private readonly errors: Errors,
  ) {
    this.info = checked.info;
    this.program = new ProgramLoweringContext(checked.info, null);
    this.frame = this.program.rootFrame;
  }

  private mintSlot(): number {
    const id = this.frame.nextSlot;
    this.frame.nextSlot += 1;
    return id;
  }

  build(file: syntax.File): Program {
    const versionNumber = Number(file.version ?? '1');
    this.version = Number.isFinite(versionNumber) ? versionNumber : 1;
    const body: IrStmt[] = [];
    for (const stmt of file.stmtList) {
      body.push(...this.nodeStmt(stmt));
    }
    const packageGlobals: IrName[] = [];
    const program: Program = {
      version: this.version,
      nominalIds: this.checked.nominalTypeIds,
      params: this.params,
      requests: this.program.requests,
      outputs: this.outputs,
      packageGlobals,
      // Hoisting const/input/simple work out of the bar loop is a later
      // optimization; everything runs in the per-bar body for now.
      init: [],
      body,
    };
    body.unshift(...this.nodePackageGlobals(this.program, packageGlobals));
    resolveDepths(program);
    this.checkBindingSupport(program);
    this.checkRequestSupport(program);
    return program;
  }

  private nodePackageGlobals(
    context: ProgramLoweringContext,
    out: IrName[],
  ): IrStmt[] {
    const required = new Set<VariableObject>();
    this.notePackageGlobalsFromInfo(context.info, required);
    for (const instance of context.funcs.keys()) {
      for (const dependency of instance.dependencies) {
        if (
          dependency.kind === ObjectKind.Variable &&
          dependency.packageGlobal !== null
        ) {
          required.add(dependency);
        }
      }
    }

    // Close over initializer dependencies. A package import or exported type
    // alone never seeds runtime state.
    const pending = [...required];
    while (pending.length > 0) {
      const global = pending.pop()!;
      const owner = global.packageGlobal?.pkg;
      if (owner === undefined) {
        continue;
      }
      const initializer = this.checked.packageContexts
        .get(owner)
        ?.info.packageGlobalInitializers.get(global);
      if (initializer === undefined) {
        return fatal(
          `package global '${owner.path}.${global.name}' has no initializer fact`,
        );
      }
      for (const dependency of initializer.dependencies) {
        if (
          dependency.kind === ObjectKind.Variable &&
          dependency.packageGlobal !== null &&
          !required.has(dependency)
        ) {
          required.add(dependency);
          pending.push(dependency);
        }
      }
    }

    const packages = new Set(
      [...required].map(global => global.packageGlobal!.pkg),
    );
    const ordered: Package[] = [];
    const visited = new Set<Package>();
    const visit = (pkg: Package): void => {
      if (visited.has(pkg)) {
        return;
      }
      visited.add(pkg);
      for (const dependency of pkg.imports) {
        if (packages.has(dependency)) {
          visit(dependency);
        }
      }
      ordered.push(pkg);
    };
    for (const pkg of packages) {
      visit(pkg);
    }

    const orderedGlobals: VariableObject[] = [];
    const placed = new Set<VariableObject>();
    const place = (global: VariableObject): void => {
      if (placed.has(global)) {
        return;
      }
      const owner = global.packageGlobal!.pkg;
      const initializer = this.checked.packageContexts
        .get(owner)
        ?.info.packageGlobalInitializers.get(global);
      if (initializer === undefined) {
        return fatal(
          `package global '${owner.path}.${global.name}' has no initializer fact`,
        );
      }
      for (const dependency of initializer.dependencies) {
        if (
          dependency.kind === ObjectKind.Variable &&
          dependency.packageGlobal !== null &&
          required.has(dependency)
        ) {
          place(dependency);
        }
      }
      placed.add(global);
      orderedGlobals.push(global);
    };
    for (const pkg of ordered) {
      const packageContext = this.checked.packageContexts.get(pkg);
      if (packageContext === undefined) {
        return fatal(`package '${pkg.path}' has no checked context`);
      }
      for (const global of packageContext.initOrder) {
        if (required.has(global)) {
          place(global);
        }
      }
    }

    const savedInfo = this.info;
    const savedProgram = this.program;
    const savedFrame = this.frame;
    const initializers: IrStmt[] = [];
    this.program = context;
    this.frame = context.rootFrame;
    for (const object of orderedGlobals) {
      const pkg = object.packageGlobal!.pkg;
      const initializer = this.checked.packageContexts
        .get(pkg)!
        .info.packageGlobalInitializers.get(object)!;
      const name = this.nameOf(object);
      if (!out.includes(name)) {
        this.info = initializer.info;
        out.push(name);
        initializers.push({
          kind: IrKind.InitName,
          pos: initializer.expr.pos,
          name,
          value: this.nodeExpr(initializer.expr, object.type),
        });
      }
    }
    this.info = savedInfo;
    this.program = savedProgram;
    this.frame = savedFrame;
    return initializers;
  }

  private notePackageGlobalsFromInfo(
    info: Info,
    out: Set<VariableObject>,
  ): void {
    for (const object of info.uses.values()) {
      if (
        object.kind === ObjectKind.Variable &&
        object.packageGlobal !== null
      ) {
        out.add(object);
      }
    }
    for (const call of info.calls.values()) {
      if (call.kind === CallKind.Function) {
        for (const dependency of call.instance.dependencies) {
          if (
            dependency.kind === ObjectKind.Variable &&
            dependency.packageGlobal !== null
          ) {
            out.add(dependency);
          }
        }
      }
    }
  }

  // The current runtime supports only request contexts that are completely
  // known during binding. RequestEdge.dynamic is the noder-owned fact that
  // captures this distinction after aliases and function frames have been
  // projected. Check the complete request tree so a nested child cannot
  // bypass the execution boundary.
  private checkRequestSupport(program: Program): void {
    const visit = (requests: readonly RequestEdge[]): void => {
      for (const edge of requests) {
        if (edge.dynamic) {
          this.errors.errorAt(
            edge.pos,
            'dynamic requests are not supported yet; symbol and timeframe must be bind-time-known',
          );
        }
        visit(edge.child.requests);
      }
    };
    visit(program.requests);
  }

  // Module binding runs without execution Context, frame state, or
  // Heap storage. Reject expressions that would require those owners before a
  // valid Program reaches target lowering.
  private checkBindingSupport(program: Program): void {
    const visitProgram = (current: Program): void => {
      const writes = new Map<IrName, IrExpr>();
      for (const stmt of [...current.init, ...current.body]) {
        const name =
          stmt.kind === IrKind.InitName
            ? stmt.name
            : stmt.kind === IrKind.Assign && stmt.target.kind === IrKind.Read
              ? stmt.target.place.name
              : null;
        if (
          name !== null &&
          !writes.has(name) &&
          (stmt.kind === IrKind.InitName || stmt.kind === IrKind.Assign)
        )
          writes.set(name, stmt.value);
      }

      const supported = (root: IrExpr): boolean => {
        let valid = true;
        const names = new Set<IrName>();
        const funcs = new Set<IrFunc>();
        const scan = (
          expr: IrExpr,
          localNames: ReadonlySet<IrName> = new Set(),
        ): void => {
          walkIrExpr(expr, {
            stmt: stmt => {
              if (stmt.kind === IrKind.InitName || stmt.kind === IrKind.Emit)
                valid = false;
            },
            expr: nested => {
              switch (nested.kind) {
                case IrKind.HistRead:
                  valid = false;
                  return;
                case IrKind.Read:
                  if (
                    nested.place.kind === PlaceKind.Series ||
                    nested.place.kind === PlaceKind.Request
                  ) {
                    valid = false;
                    return;
                  }
                  if (
                    nested.place.kind === PlaceKind.Param &&
                    nested.place.param.defaultValue?.kind ===
                      ParamDefaultKind.Series
                  ) {
                    valid = false;
                    return;
                  }
                  if (
                    nested.place.kind === PlaceKind.Name &&
                    !localNames.has(nested.place.name) &&
                    !names.has(nested.place.name)
                  ) {
                    names.add(nested.place.name);
                    const value = writes.get(nested.place.name);
                    if (value === undefined) valid = false;
                    else scan(value);
                  }
                  return;
                case IrKind.CallFunc:
                  if (nested.func.callMode !== 'free') {
                    valid = false;
                    return;
                  }
                  if (!funcs.has(nested.func)) {
                    funcs.add(nested.func);
                    scan(
                      nested.func.body,
                      new Set([...nested.func.params, ...nested.func.locals]),
                    );
                  }
                  return;
                case IrKind.NewStruct:
                case IrKind.MakeTuple:
                case IrKind.TupleGet:
                case IrKind.Selector:
                case IrKind.ForInExpr:
                  valid = false;
                  return;
                case IrKind.CallNative:
                  if (nested.native.effect !== 'pure') {
                    valid = false;
                  }
                  return;
                default:
                  return;
              }
            },
          });
        };
        scan(root);
        return valid;
      };

      const check = (expr: IrExpr): void => {
        if (!supported(expr)) {
          this.errors.errorAt(
            expr.pos,
            'module configuration must depend only on constants, scalar parameters, and non-allocating simple expressions',
          );
        }
      };
      const checkDepth = (depth: HistoryDepth): void => {
        if (depth.kind === DepthKind.Bound) check(depth.expr);
      };

      namesOf(current).forEach(name => checkDepth(name.depth));
      seriesInputsOf(current).forEach(series => checkDepth(series.depth));
      builtinInputsOf(current).forEach(builtin => checkDepth(builtin.depth));
      current.params.forEach(param => {
        check(param.active);
        checkDepth(param.depth);
      });
      requestsOf(current).forEach(request => {
        checkDepth(request.depth);
        if (request.dynamic) return;
        check(request.symbol);
        check(request.timeframe);
        check(request.merge.fill);
        check(request.merge.ignoreInvalidSymbol);
        check(request.merge.calcBarsCount);
      });
      current.requests.forEach(request => visitProgram(request.child));
    };
    visitProgram(program);
  }

  private tvOf(e: syntax.Expr): TypeAndValue {
    const tv = this.info.types.get(e);
    if (tv === undefined) {
      return fatal(`unchecked expression reached the noder: ${e.kind}`);
    }
    return tv;
  }

  private variableDef(node: syntax.Name): VariableObject {
    const object = this.info.defs.get(node);
    if (object?.kind !== ObjectKind.Variable) {
      return fatal(`unbound declaration reached the noder: ${node.value}`);
    }
    return object;
  }

  private variableUse(node: syntax.Name): VariableObject {
    const object = this.info.uses.get(node);
    if (object?.kind !== ObjectKind.Variable) {
      return fatal(`unresolved name reached the noder: ${node.value}`);
    }
    return object;
  }

  private receiverUse(node: syntax.ThisExpr): VariableObject {
    const object = this.info.uses.get(node);
    if (object?.kind !== ObjectKind.Variable) {
      return fatal('unresolved this reached the noder');
    }
    return object;
  }

  private nameOf(object: VariableObject): IrName {
    let name = this.program.names.get(object);
    if (name === undefined) {
      name = {
        name: object.name,
        storage: object.storage,
        type: object.type,
        qualifier: object.qualifier,
        depth: {kind: DepthKind.None},
      };
      this.program.names.set(object, name);
    }
    return name;
  }

  private structFieldStore(target: StructFieldStore): {
    readonly object: IrExpr;
    readonly owner: Extract<Type, {kind: typeof TypeKind.Struct}>;
    readonly fieldIndex: number;
  } {
    const owner = target.owner.type;
    const projected =
      owner.kind === TypeKind.Struct
        ? owner.fields[target.field.index]
        : undefined;
    if (
      owner.kind !== TypeKind.Struct ||
      target.field.owner !== target.owner ||
      projected === undefined ||
      projected.name !== target.field.name ||
      !typesEqual(projected.type, target.field.type)
    ) {
      return fatal('non-canonical struct field store reached the noder');
    }
    if (!typesEqual(target.object.tv.type, owner)) {
      return fatal('struct field store object disagrees with its owner');
    }
    return {
      object: this.nodeChecked(target.object, owner),
      owner,
      fieldIndex: target.field.index,
    };
  }

  private collectionLocation(
    location: CheckedCollectionLocation,
    receiver: CheckedExpression,
  ): WritableExpr {
    if (location.kind === 'name') {
      if (!typesEqual(location.name.type, receiver.tv.type)) {
        return fatal('collection name location disagrees with receiver fact');
      }
      return this.read(this.nameOf(location.name), receiver.expr.pos);
    }
    const field = this.structFieldStore(location);
    if (!typesEqual(location.field.type, receiver.tv.type)) {
      return fatal('collection field location disagrees with receiver fact');
    }
    return {
      kind: IrKind.Selector,
      pos: receiver.expr.pos,
      type: location.field.type,
      qualifier: receiver.tv.qualifier,
      x: field.object,
      fieldIndex: field.fieldIndex,
    };
  }

  private builtinOf(
    e: syntax.Name | syntax.SelectorExpr,
  ): BuiltinObject | null {
    if (e.kind === NodeKind.Name) {
      const object = this.info.uses.get(e);
      return object?.kind === ObjectKind.Builtin ? object : null;
    }
    const selection = this.info.selections.get(e);
    return selection?.kind === SelectionKind.Builtin ? selection.builtin : null;
  }

  private seriesOf(builtin: BuiltinObject): SeriesInput {
    if (builtin.binding?.kind !== 'series') {
      return fatal(`builtin '${builtin.name}' is not a numeric series input`);
    }
    let series = this.program.series.get(builtin);
    if (series === undefined) {
      series = {
        id: builtin.binding.id,
        type: builtin.type,
        qualifier: builtin.qualifier,
        depth: {kind: DepthKind.None},
      };
      this.program.series.set(builtin, series);
    }
    return series;
  }

  private builtinInputOf(builtin: BuiltinObject): BuiltinInput {
    if (builtin.binding?.kind !== 'builtin') {
      return fatal(`builtin '${builtin.name}' has no builtin runtime binding`);
    }
    let input = this.program.builtin.get(builtin);
    if (input === undefined) {
      input = {
        source: builtin.binding.source,
        type: builtin.type,
        qualifier: builtin.qualifier,
        depth: {kind: DepthKind.None},
      };
      this.program.builtin.set(builtin, input);
    }
    return input;
  }

  // A checked default changes only the semantic fact view. It still lowers
  // into the caller's current Program and frame.
  private nodeChecked(
    checked: CheckedExpression,
    expectedType: Type = checked.tv.type,
  ): IrExpr {
    const saved = this.info;
    this.info = checked.info;
    const expr = this.nodeExpr(checked.expr, expectedType);
    this.info = saved;
    return expr;
  }

  private read(
    name: IrName,
    pos: Pos,
  ): ReadExpr & {place: Extract<Place, {kind: typeof PlaceKind.Name}>} {
    return {
      kind: IrKind.Read,
      pos,
      type: name.type,
      qualifier: name.qualifier,
      place: {kind: PlaceKind.Name, name},
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

  // ---- statements -----------------------------------------------------------

  private nodeStmt(stmt: syntax.Stmt): IrStmt[] {
    switch (stmt.kind) {
      case NodeKind.ExprStmt:
        return this.nodeExprStmt(stmt);
      case NodeKind.DeclStmt:
        return this.nodeDecl(stmt);
      case NodeKind.AssignStmt:
        return this.nodeAssign(stmt);
      case NodeKind.EmitStmt: {
        const column = this.info.emits.get(stmt);
        if (column === undefined)
          return fatal('unchecked emission reached the noder');
        let output = this.outputOf.get(column);
        if (output === undefined) {
          this.checkExport(column.valueType, stmt.pos);
          output = {...column};
          this.outputOf.set(column, output);
          this.outputs.push(output);
        }
        return [
          {
            kind: IrKind.Emit,
            pos: stmt.pos,
            output,
            value: this.nodeExpr(stmt.value, output.valueType),
          },
        ];
      }
      case NodeKind.ReturnStmt:
        return [
          {
            kind: IrKind.Return,
            pos: stmt.pos,
            value:
              stmt.value === null
                ? null
                : this.nodeExpr(stmt.value, this.returnType),
          },
        ];
      case NodeKind.FuncDecl:
      case NodeKind.InterfaceDecl:
      case NodeKind.StructDecl:
      case NodeKind.TypeAliasDecl:
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
      const resolved = this.info.calls.get(call);
      if (resolved?.kind === CallKind.Native) {
        if (resolved.native.effect === Effect.Declaration) {
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
    // A statement discards its value, so a structure whose result is na has
    // no consumer to take a type from: it has no value at all.
    const x = this.nodeExpr(
      stmt.x,
      tv.type.kind === TypeKind.Na ? VoidType : null,
    );
    // A fully-folded statement expression is pure and dead.
    if (x.kind === IrKind.Const) {
      return [];
    }
    return [x];
  }

  private nodeDecl(d: syntax.DeclStmt): IrStmt[] {
    if (d.target.kind === NodeKind.TuplePattern) {
      return this.nodeTupleDecl(d, d.target);
    }
    const object = this.variableDef(d.target);
    const name = this.nameOf(object);
    const rebindable = !this.info.reassigned.has(object);

    // `len = input.int(...)` binds the name to the param: reads become
    // param reads, no per-bar write exists.
    const call = unwrapCall(d.init);
    if (call !== null && rebindable && d.mode === Mode.None) {
      const resolved = this.info.calls.get(call);
      if (
        resolved?.kind === CallKind.Native &&
        resolved.native.effect === Effect.Param
      ) {
        const param = this.ensureParam(call, resolved, name.name);
        this.paramRefs.set(object, param);
        return [];
      }
    }

    // Tea const declarations are fully compile-time: every read folded.
    if (d.mode === Mode.Const) {
      return [];
    }

    const init = this.nodeExpr(d.init, name.type);

    if (
      init.kind === IrKind.Read &&
      init.place.kind !== PlaceKind.Name &&
      // Keep an unsupported dynamic request materialized until the recursive
      // fail-closed support check reports it; never project it as an alias.
      !(init.place.kind === PlaceKind.Request && init.place.request.dynamic) &&
      rebindable &&
      d.mode === Mode.None
    ) {
      this.program.aliasRefs.set(object, init.place);
      return [];
    }

    if (name.storage === Storage.Var || name.storage === Storage.Varip) {
      return [{kind: IrKind.InitName, pos: d.pos, name, value: init}];
    }
    return [
      {
        kind: IrKind.Assign,
        pos: d.pos,
        target: this.read(name, d.pos),
        value: init,
        op: null,
      },
    ];
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
    };
    const stmts: IrStmt[] = [
      {
        kind: IrKind.Assign,
        pos: d.pos,
        target: this.read(temp, d.pos),
        op: null,
        value: this.nodeExpr(d.init, initTv.type),
      },
    ];
    pattern.elems.forEach((elem, i) => {
      const name = this.nameOf(this.variableDef(elem));
      stmts.push({
        kind: IrKind.Assign,
        pos: elem.pos,
        target: this.read(name, elem.pos),
        op: null,
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
    const base = ASSIGN_BASE_OP[a.op];
    let target: WritableExpr;
    if (a.target.kind === NodeKind.Name)
      target = this.read(this.nameOf(this.variableUse(a.target)), a.target.pos);
    else if (a.target.kind === NodeKind.SelectorExpr) {
      const checked = this.info.updates.get(a);
      if (checked === undefined)
        return fatal('unchecked assignment target reached the noder');
      const field = this.structFieldStore(checked);
      target = {
        kind: IrKind.Selector,
        pos: a.target.pos,
        type: checked.field.type,
        qualifier: Qualifier.Series,
        x: field.object,
        fieldIndex: field.fieldIndex,
      };
    } else return fatal('invalid assignment target reached the noder');
    return [
      {
        kind: IrKind.Assign,
        pos: a.pos,
        target,
        value: this.nodeExpr(a.value, target.type),
        op: base === undefined ? null : mapBinaryOp(base),
      },
    ];
  }

  // ---- expressions ----------------------------------------------------------

  private nodeExpr(e: syntax.Expr, expectedType: Type | null = null): IrExpr {
    const checked = this.tvOf(e);
    // An na result takes its consumer's type. Inside a structure that has no
    // value (Void) nothing consumes it, so it has no value either.
    const contextualType =
      checked.type.kind === TypeKind.Na &&
      expectedType !== null &&
      expectedType.kind !== TypeKind.Na &&
      (expectedType.kind === TypeKind.Void ||
        assignable(checked.type, expectedType))
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
      case NodeKind.ThisExpr:
        return this.read(this.nameOf(this.receiverUse(e)), e.pos);
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
          kind: IrKind.IfExpr,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          cond: this.nodeExpr(e.cond),
          then: this.blockify(e.then, tv.type),
          else: this.blockify(e.else, tv.type),
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
        const index = this.nameOf(this.variableDef(e.index));
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
        const targets = targetNames.map(n => this.nameOf(this.variableDef(n)));
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

  // A Name or Selector read: context builtin, parameter binding,
  // struct-value field, or a plain name read.
  private nodePlaceRead(
    e: syntax.Name | syntax.SelectorExpr,
    tv: TypeAndValue,
  ): IrExpr {
    const builtin = this.builtinOf(e);
    if (builtin !== null) {
      const place: Place =
        builtin.binding?.kind === 'series'
          ? {kind: PlaceKind.Series, series: this.seriesOf(builtin)}
          : builtin.binding?.kind === 'builtin'
            ? {
                kind: PlaceKind.Builtin,
                builtin: this.builtinInputOf(builtin),
              }
            : fatal(`constant builtin '${builtin.name}' reached place noding`);
      return {
        kind: IrKind.Read,
        pos: e.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        place,
      };
    }
    if (e.kind === NodeKind.Name) {
      const object = this.variableUse(e);
      const param = this.paramRefs.get(object);
      if (param !== undefined) {
        return {
          kind: IrKind.Read,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          place: {kind: PlaceKind.Param, param},
        };
      }
      const alias = this.program.aliasRefs.get(object);
      if (alias !== undefined) {
        return {
          kind: IrKind.Read,
          pos: e.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          place: alias,
        };
      }
      return this.read(this.nameOf(object), e.pos);
    }
    const selection = this.info.selections.get(e);
    if (selection?.kind !== SelectionKind.Field) {
      return fatal(`unresolved selector reached the noder: ${e.sel.value}`);
    }
    const receiverType = this.tvOf(e.x).type;
    if (
      receiverType.kind !== TypeKind.Struct ||
      selection.field.owner.type !== receiverType
    ) {
      return fatal('non-canonical field selection reached the noder');
    }
    return {
      kind: IrKind.Selector,
      pos: e.pos,
      type: tv.type,
      qualifier: tv.qualifier,
      x: this.nodeExpr(e.x),
      fieldIndex: selection.field.index,
    };
  }

  private nodeCall(c: syntax.CallExpr, tv: TypeAndValue): IrExpr {
    const resolved = this.info.calls.get(c);
    if (resolved === undefined) {
      return fatal('unresolved call reached the noder');
    }
    if (resolved.kind === CallKind.Constructor) {
      resolved.args.forEach((arg, index) => {
        if (arg.field.owner !== resolved.type || arg.field.index !== index) {
          return fatal('non-canonical constructor field order reached noder');
        }
      });
      return {
        kind: IrKind.NewStruct,
        pos: c.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        structType: resolved.type.type,
        args: resolved.args.map(arg =>
          this.nodeChecked(arg.value, arg.field.type),
        ),
        argumentEvaluationOrder: resolved.argumentEvaluationOrder,
      };
    }
    if (resolved.kind === CallKind.Function) {
      const func = this.funcOf(resolved.instance);
      const args = resolved.instance.params.map((param, i) => {
        const provided = resolved.args[i];
        return provided !== null
          ? this.nodeExpr(provided, param.type)
          : this.nodeInstanceDefault(resolved.instance, i, param.type);
      });
      const base = {
        pos: c.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        slot: this.mintSlot(),
        args,
        argumentEvaluationOrder: resolved.argumentEvaluationOrder,
      };
      return {
        kind: IrKind.CallFunc,
        ...base,
        func,
        receiver:
          resolved.receiver === null
            ? null
            : this.nodeChecked(resolved.receiver.value),
      };
    }
    if (resolved.kind === CallKind.Request) {
      return this.nodeRequest(c, resolved, tv);
    }
    if (!typesEqual(resolved.resultType, tv.type)) {
      return fatal(
        `native '${resolved.native.name}' result facts disagree in the noder`,
      );
    }
    if (resolved.receiver?.mode === 'inout') {
      const argTypes: readonly Type[] | undefined = resolved.argTypes;
      const receiverType = argTypes?.[0];
      if (receiverType === undefined) {
        return fatal(
          `inout native '${resolved.native.name}' lacks a receiver type`,
        );
      }
      if (resolved.args[0] !== resolved.receiver.value.expr) {
        return fatal(
          `inout native '${resolved.native.name}' receiver is not argument 0`,
        );
      }
      if (
        receiverType.kind !== TypeKind.Array &&
        receiverType.kind !== TypeKind.Matrix &&
        receiverType.kind !== TypeKind.Map
      ) {
        return fatal(
          `non-collection inout native '${resolved.native.name}' reached collection noding`,
        );
      }
      const lowered = this.nodeNativeArgs(c, resolved, 1);
      return {
        kind: IrKind.CallNative,
        pos: c.pos,
        type: tv.type,
        qualifier: tv.qualifier,
        receiver: this.collectionLocation(
          resolved.receiver.location,
          resolved.receiver.value,
        ),
        native: {
          name: resolved.native.name,
          argTypes: resolved.argTypes.slice(1, lowered.args.length + 1),
          resultType: resolved.resultType,
          effect: resolved.native.runtimeEffect,
        },
        args: lowered.args,
        argumentEvaluationOrder: lowered.argumentEvaluationOrder,
      };
    }
    switch (resolved.native.effect) {
      case Effect.Param: {
        const param = this.ensureParam(c, resolved, null);
        return {
          kind: IrKind.Read,
          pos: c.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          place: {kind: PlaceKind.Param, param},
        };
      }
      case Effect.Request:
        return fatal('request native lacks request semantics');
      case Effect.Emit:
        return fatal('effect.emit in expression position reached the noder');
      case Effect.Declaration:
        return fatal(
          'declaration call in expression position reached the noder',
        );
      default: {
        const lowered = this.nodeNativeArgs(c, resolved);
        return {
          kind: IrKind.CallNative,
          pos: c.pos,
          type: tv.type,
          qualifier: tv.qualifier,
          native: {
            name: resolved.native.name,
            argTypes: resolved.argTypes.slice(0, lowered.args.length),
            resultType: resolved.resultType,
            effect: resolved.native.runtimeEffect,
          },
          receiver: null,
          args: lowered.args,
          argumentEvaluationOrder: lowered.argumentEvaluationOrder,
        };
      }
    }
  }

  // NativeCall already owns the instantiated argument types. Noding consumes
  // those exact facts; it never repeats generic inference. Omitted middles
  // become typed na while omitted trailing optionals remain runtime defaults.
  private nodeNativeArgs(
    c: syntax.CallExpr,
    resolved: NativeCall,
    start = 0,
  ): {
    readonly args: IrExpr[];
    readonly argumentEvaluationOrder: readonly number[];
  } {
    const argTypes: readonly Type[] | undefined = resolved.argTypes;
    if (argTypes === undefined) {
      return fatal(
        `native '${resolved.native.name}' lacks instantiated argument types`,
      );
    }
    const provided = [...resolved.args];
    while (provided.length > start && provided[provided.length - 1] === null) {
      provided.pop();
    }
    const args = provided.slice(start).map((arg, relativeIndex) => {
      const index = start + relativeIndex;
      const expected = argTypes[index];
      if (expected === undefined) {
        return fatal(
          `native '${resolved.native.name}' lacks argument type ${index}`,
        );
      }
      return arg !== null
        ? this.nodeExpr(arg, expected)
        : this.naConst(c.pos, expected);
    });
    const requestedOrder = resolved.argumentEvaluationOrder
      .filter(index => index >= start && index < provided.length)
      .map(index => index - start);
    const seen = new Set(requestedOrder);
    const syntheticOrder = args.flatMap((_arg, index) =>
      seen.has(index) ? [] : [index],
    );
    return {
      args,
      argumentEvaluationOrder: [...requestedOrder, ...syntheticOrder],
    };
  }

  // `x[k]`: the checker has already proved that x is a direct readable
  // binding. History therefore projects to that binding's ordinary Place;
  // the noder never invents a hidden Name for a computed expression.
  private nodeHistory(e: syntax.HistoryExpr, tv: TypeAndValue): IrExpr {
    const offset = this.nodeExpr(e.offset, IntType);
    const binding = unwrapExpr(e.x);
    if (
      binding.kind !== NodeKind.Name &&
      binding.kind !== NodeKind.SelectorExpr
    )
      return fatal('non-binding history operand reached the noder');
    // A specialized parameter's current value may fold, but its history still
    // belongs to the binding and retains the callee's independently written state.
    const x = this.nodePlaceRead(binding, this.tvOf(binding));
    if (
      x.kind === IrKind.Read &&
      // Keep an unsupported dynamic request materialized until the recursive
      // fail-closed support check reports it; never project history past it.
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
    return fatal('non-binding history operand reached the noder');
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
    const value = this.resultValue(e, expectedType);
    return {
      kind: IrKind.BlockExpr,
      pos: e.pos,
      type: value !== null ? value.type : VoidType,
      qualifier: value !== null ? value.qualifier : Qualifier.Const,
      stmts: [],
      value,
    };
  }

  // The value an expression in result position yields. A folded na inside a
  // structure that has no value (Void) is a dead constant: nothing consumes
  // it, so it never enters Program IR.
  private resultValue(
    e: syntax.Expr,
    expectedType: Type | null,
  ): IrExpr | null {
    const tv = this.tvOf(e);
    return expectedType?.kind === TypeKind.Void &&
      tv.type.kind === TypeKind.Na &&
      tv.value !== null
      ? null
      : this.nodeExpr(e, expectedType);
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
        value = this.resultValue(stmt.x, expectedType);
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

  // The value a declaration or assignment yields when it closes a block. The
  // checker types an na initializer as an untyped na, so it takes its
  // consumer's type; where nothing consumes it (no context, or a Void
  // structure) it keeps the type its declaration is required to annotate.
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
            tv.type.kind !== TypeKind.Na
              ? tv.type
              : expectedType !== null && expectedType.kind !== TypeKind.Void
                ? expectedType
                : this.variableDef(stmt.target).type,
          qualifier: tv.qualifier,
          value: tv.value,
        };
      }
      const object = this.info.defs.get(stmt.target);
      return object?.kind === ObjectKind.Variable
        ? this.read(this.nameOf(object), stmt.pos)
        : null;
    }
    if (
      stmt.kind === NodeKind.AssignStmt &&
      stmt.target.kind === NodeKind.Name
    ) {
      const object = this.info.uses.get(stmt.target);
      return object?.kind === ObjectKind.Variable
        ? this.read(this.nameOf(object), stmt.pos)
        : null;
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
    resolved: RequestCall,
    tv: TypeAndValue,
  ): IrExpr {
    const existing = this.program.requestsByCall.get(resolved);
    if (existing !== undefined) {
      return this.requestRead(c, existing, tv);
    }
    const argExpr = (paramName: string): syntax.Expr | null => {
      const index = resolved.native.params.findIndex(p => p.name === paramName);
      return index === -1 ? null : (resolved.args[index] ?? null);
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
    const symbolIndex = resolved.native.params.findIndex(
      param => param.name === 'symbol',
    );
    const timeframeIndex = resolved.native.params.findIndex(
      param => param.name === 'timeframe',
    );
    const contextArgumentEvaluationOrder = resolved.argumentEvaluationOrder
      .filter(index => index === symbolIndex || index === timeframeIndex)
      .map(index => (index === symbolIndex ? 0 : 1));
    if (
      contextArgumentEvaluationOrder.length !== 2 ||
      new Set(contextArgumentEvaluationOrder).size !== 2
    ) {
      return fatal(
        `request native '${resolved.native.name}' has an invalid parent-context evaluation order`,
      );
    }

    // Parent-context pieces first.
    const symbol = this.nodeExpr(symbolExpr, this.tvOf(symbolExpr).type);
    const timeframe = this.nodeExpr(
      timeframeExpr,
      this.tvOf(timeframeExpr).type,
    );
    const optionNames = [
      'fill',
      'ignore_invalid_symbol',
      'calc_bars_count',
    ] as const;
    const optionParamIndices = optionNames.map(name =>
      resolved.native.params.findIndex(param => param.name === name),
    );
    const suppliedOptionOrder = resolved.argumentEvaluationOrder
      .filter(index => index >= 0 && optionParamIndices.includes(index))
      .map(index => optionParamIndices.indexOf(index));
    const omittedOptionOrder = optionNames
      .map((name, index) => (argExpr(name) === null ? index : null))
      .filter((index): index is number => index !== null);
    const optionArgumentEvaluationOrder = [
      ...suppliedOptionOrder,
      ...omittedOptionOrder,
    ];
    if (
      optionArgumentEvaluationOrder.length !== optionNames.length ||
      new Set(optionArgumentEvaluationOrder).size !== optionNames.length
    ) {
      return fatal(
        `request native '${resolved.native.name}' has an invalid option evaluation order`,
      );
    }
    const optionExpr = (
      name: (typeof optionNames)[number],
      type: Type,
      defaultValue: ConstValue,
    ): IrExpr => {
      const expr = argExpr(name);
      return expr === null
        ? this.constExpr(c.pos, type, defaultValue)
        : this.nodeExpr(expr, this.tvOf(expr).type);
    };
    const merge: MergePolicy = {
      mode:
        resolved.native.name === 'request.security_lower_tf'
          ? MergeMode.Collect
          : MergeMode.Sample,
      fill: optionExpr('fill', StringType, 'carry'),
      ignoreInvalidSymbol: optionExpr('ignore_invalid_symbol', BoolType, false),
      calcBarsCount: optionExpr('calc_bars_count', IntType, 0),
    };
    for (const [name, option] of [
      ['fill', merge.fill],
      ['ignore_invalid_symbol', merge.ignoreInvalidSymbol],
      ['calc_bars_count', merge.calcBarsCount],
    ] as const) {
      if (!this.requestContextBindEvaluable(option)) {
        return fatal(
          `request option '${name}' reached noding without a bind-evaluable owner`,
        );
      }
    }

    // The child context owns its semantic facts, context inputs, functions,
    // frame slots, and nested requests. Compilation-global params remain
    // shared through the binding projection maps.
    const resultName: IrName = {
      name: '$result',
      storage: Storage.PerBar,
      type: resolved.captureType,
      qualifier: Qualifier.Series,
      depth: {kind: DepthKind.None},
    };
    const parentProgram = this.program;
    const savedInfo = this.info;
    const savedFrame = this.frame;
    const savedNesting = this.nesting;
    const childContext = new ProgramLoweringContext(
      resolved.capture,
      parentProgram,
    );
    this.info = resolved.capture;
    this.program = childContext;
    this.frame = childContext.rootFrame;
    this.nesting += 1;
    const childValue = this.nodeExpr(captureExpr, resolved.captureType);
    this.nesting = savedNesting;
    this.info = savedInfo;
    this.program = parentProgram;
    this.frame = savedFrame;

    const childPackageGlobals: IrName[] = [];
    const childBody: IrStmt[] = [
      {
        kind: IrKind.Assign,
        pos: captureExpr.pos,
        target: this.read(resultName, captureExpr.pos),
        op: null,
        value: childValue,
      },
    ];
    const child: Program = {
      version: this.version,
      nominalIds: this.checked.nominalTypeIds,
      // Bind-time params are compilation-global: a child references the
      // parent's ParamInput objects directly and declares none of its own.
      params: [],
      requests: childContext.requests,
      outputs: [],
      packageGlobals: childPackageGlobals,
      init: [],
      body: childBody,
    };
    childBody.unshift(
      ...this.nodePackageGlobals(childContext, childPackageGlobals),
    );

    // In the program frame, bind-known context expressions may use immutable
    // input/simple aliases and pure UDFs because module.bind owns a real root
    // frame. Inside function/capture frames, only frame-free expressions are
    // safe to evaluate independently; local parameters must stay dynamic.
    const staticAtBind = (expr: IrExpr): boolean =>
      this.requestContextBindEvaluable(expr);
    const edge: RequestEdge = {
      pos: c.pos,
      name: resolved.bindingName,
      symbol,
      timeframe,
      contextArgumentEvaluationOrder,
      optionArgumentEvaluationOrder,
      merge,
      resultName,
      captureType: resolved.captureType,
      resultType: resolved.resultType,
      dynamic: !staticAtBind(symbol) || !staticAtBind(timeframe),
      depth: {kind: DepthKind.None},
      child,
    };
    parentProgram.requests.push(edge);
    parentProgram.requestsByCall.set(resolved, edge);
    return this.requestRead(c, edge, tv);
  }

  // Dynamic edges are rejected after the complete Program tree is built.
  // Until then, keep their reads materialized so alias/history projection
  // cannot erase the unsupported call site before its diagnostic is emitted.
  private requestRead(
    c: syntax.CallExpr,
    edge: RequestEdge,
    tv: TypeAndValue,
  ): ReadExpr {
    return {
      kind: IrKind.Read,
      pos: c.pos,
      type: tv.type,
      qualifier: tv.qualifier,
      place: {kind: PlaceKind.Request, request: edge},
    };
  }

  private requestContextBindEvaluable(expr: IrExpr): boolean {
    if (bindEvaluable(expr)) {
      return true;
    }
    if (!qualifierLE(expr.qualifier, Qualifier.Simple)) {
      return false;
    }
    if (this.frame.kind === 'program') {
      // Only the compilation root owns the provisional root frame available
      // during module.bind. Request-child program roots remain frame-free.
      return this.program.parent === null;
    }
    return rootNameBindEvaluable(expr, this.frame.names);
  }

  // ---- functions ------------------------------------------------------------

  // One IrFunc per checker instance and Program: the body nodes once against
  // the instance's Info, under its own frame-local slot counter (each user
  // call inside selects a sub-frame of THIS func's frame). Recursion cannot
  // occur — the checker rejected cyclic call graphs.
  private funcOf(instance: FunctionInstance): IrFunc {
    const existing = this.program.funcs.get(instance);
    if (existing !== undefined) {
      return existing;
    }
    const savedInfo = this.info;
    const savedFrame = this.frame;
    const savedNesting = this.nesting;
    const savedReturnType = this.returnType;
    this.returnType = instance.resultType;
    this.info = instance.info;
    const paramSet = new Set(instance.params);
    const localObjects = [...new Set(instance.info.defs.values())].filter(
      (object): object is VariableObject =>
        object.kind === ObjectKind.Variable && !paramSet.has(object),
    );
    const params = instance.params.map(param => this.nameOf(param));
    const receiver =
      instance.receiver === null ? null : this.nameOf(instance.receiver);
    const locals = localObjects.map(local => this.nameOf(local));
    this.frame = {
      kind: 'function',
      program: this.program,
      names: new Set([
        ...(receiver === null ? [] : [receiver]),
        ...params,
        ...locals,
      ]),
      nextSlot: 0,
    };
    this.nesting += 1;
    const decl = instance.template.decl;
    const body =
      decl.body.kind === NodeKind.Block
        ? this.nodeBlock(decl.body, instance.resultType)
        : this.nodeExpr(decl.body, instance.resultType);
    this.nesting = savedNesting;
    this.info = savedInfo;
    this.frame = savedFrame;
    const base = {
      name: instance.name,
      params,
      locals,
      resultType: instance.resultType,
      resultQualifier: instance.resultQualifier,
      body,
    };
    this.returnType = savedReturnType;
    const declarationReceiver = instance.template.receiver;
    let func: IrFunc;
    if (declarationReceiver === null) {
      if (receiver !== null) {
        return fatal(
          `free function '${instance.name}' has a hidden receiver instance`,
        );
      }
      func = {...base, callMode: 'free'};
    } else {
      if (receiver === null) {
        return fatal(`method '${instance.name}' lacks a hidden receiver`);
      }
      func =
        declarationReceiver.mode === 'const'
          ? {...base, callMode: 'const-method', receiver}
          : {...base, callMode: 'mutable-method', receiver};
    }
    this.program.funcs.set(instance, func);
    return func;
  }

  // An omitted argument nodes the instance's checked default at the call
  // site. Defaults must not reference sibling params (see AGENTS.md).
  private nodeInstanceDefault(
    instance: FunctionInstance,
    index: number,
    expectedType: Type,
  ): IrExpr {
    const dflt = instance.defaults.get(index);
    if (dflt === undefined) {
      return fatal(
        `no default for omitted argument ${index} of '${instance.name}'`,
      );
    }
    return this.nodeChecked(dflt, expectedType);
  }

  // ---- parameters ----------------------------------------------------------

  private ensureParam(
    c: syntax.CallExpr,
    resolved: NativeCall,
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
        const source = unwrapExpr(defval);
        const builtin =
          source.kind === NodeKind.Name || source.kind === NodeKind.SelectorExpr
            ? this.builtinOf(source)
            : null;
        if (builtin !== null) {
          defaultValue = {
            kind: ParamDefaultKind.Series,
            series: this.seriesOf(builtin),
          };
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

  // Arrow schemas are finite trees. Recursive references remain valid inside
  // the program, but exporting one must fail before a backend is selected.
  private checkExport(type: Type, pos: Pos): void {
    const active = new Set<Type>();
    const finite = (type: Type): boolean => {
      if (active.has(type)) return false;
      active.add(type);
      let children: readonly Type[] = [];
      switch (type.kind) {
        case TypeKind.Struct:
          children = type.fields.map(field => field.type);
          break;
        case TypeKind.Array:
        case TypeKind.Matrix:
          children = [type.elem];
          break;
        case TypeKind.Map:
          children = [type.key, type.value];
          break;
        case TypeKind.Tuple:
          children = type.elems;
          break;
      }
      const result = children.every(finite);
      active.delete(type);
      return result;
    };
    if (!finite(type)) {
      this.errors.errorAt(
        pos,
        'recursive value types cannot be exported as Arrow schemas',
      );
    }
  }
}

// A static request nested in a UDF may read compilation-global bind-known
// aliases through ctx.root(), but it cannot read the UDF's own params/locals
// without a concrete call-site frame. Keep this deliberately structural: UDF
// calls and control-flow blocks remain dynamic when the request itself is
// inside a UDF.
function rootNameBindEvaluable(
  expr: IrExpr,
  frameNames: ReadonlySet<IrName>,
): boolean {
  if (bindEvaluable(expr)) {
    return true;
  }
  switch (expr.kind) {
    case IrKind.Read:
      return (
        expr.place.kind === PlaceKind.Name &&
        !frameNames.has(expr.place.name) &&
        qualifierLE(expr.place.name.qualifier, Qualifier.Simple)
      );
    case IrKind.Binary:
      return (
        rootNameBindEvaluable(expr.x, frameNames) &&
        rootNameBindEvaluable(expr.y, frameNames)
      );
    case IrKind.Unary:
      return rootNameBindEvaluable(expr.x, frameNames);
    case IrKind.IfExpr:
      return (
        rootNameBindEvaluable(expr.cond, frameNames) &&
        rootNameBindEvaluable(expr.then, frameNames) &&
        (expr.else === null || rootNameBindEvaluable(expr.else, frameNames))
      );
    case IrKind.BlockExpr:
      return (
        expr.stmts.length === 0 &&
        (expr.value === null || rootNameBindEvaluable(expr.value, frameNames))
      );
    case IrKind.CallNative:
      return (
        expr.native.effect === 'pure' &&
        expr.args.every(arg => rootNameBindEvaluable(arg, frameNames))
      );
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
