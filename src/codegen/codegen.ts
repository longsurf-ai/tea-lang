// Purpose: Code generator — lowers a Tea Program to a self-describing JS
// module against the generated-code RuntimeContext ABI; docs/runtime.md owns
// the module contract and dense ids published in its manifest.

import {fatal} from '../base/print';
import {paramSpecsOf} from './params';
import {frameTopologyOf, type FrameTopology} from '../ir/frames';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  Storage,
  type HistoryDepth,
  type IrExpr,
  type Name,
} from '../ir/node';
import {unimplemented} from '../base/unimplemented';
import {
  MergeMode,
  ParamDefaultKind,
  type EffectDecl,
  type EffectValueSchema,
  type IrFunc,
  type BuiltinInput,
  type OutputDecl,
  type ParamInput,
  type Program,
  type RequestEdge,
  type SeriesInput,
} from '../ir/program';
import {
  formatType,
  isNaValue,
  Qualifier,
  qualifierLE,
  TypeKind,
  typesEqual,
  type ConstValue,
  type Type,
} from '../ir/type';
import {
  builtinInputsOf,
  requestsOf,
  seriesInputsOf,
  walkIrExpr,
} from '../ir/visit';
import {RUNTIME_ABI_VERSION} from '../runtime/module-abi';
import type {
  BuiltinSpec,
  DepthSpec,
  FrameLayout,
  ModuleManifest,
  RequestSpec,
  SeriesSpec,
} from '../runtime/module-abi';
import type {OutputChannelTransport, OutputSpec} from '../runtime/output';
import type {ManifestValue} from '../runtime/value';
import type {LayoutId, ValueLayout} from '../runtime/value-layout';
import {
  HELPERS,
  captureArguments,
  indent,
  lowerExpr,
  lowerStmts,
  type HelperName,
  type LowerCtx,
} from './lower';

export function generate(program: Program): string {
  const emitter = new ModuleEmitter();
  const rootBody = new Generator(program, 'M', emitter).moduleBody();
  const out: string[] = ['"use strict";'];
  for (const name of [...emitter.usedHelpers].sort()) {
    out.push(`const ${name} = ${HELPERS[name]};`);
  }
  // Request children are sibling consts in dependency order (a nested
  // child's const precedes its parent's), referenced from the requests
  // arrays — code cannot live inside the JSON manifest.
  out.push(
    `const L = ${json(emitter.layouts satisfies readonly ValueLayout[])};`,
  );
  out.push(...emitter.childDecls);
  out.push('const M = {');
  out.push(...indent(rootBody));
  out.push('};');
  out.push('return M;');
  return `${out.join('\n')}\n`;
}

function effectScalarMatches(
  type: Type,
  schema: Exclude<
    EffectValueSchema,
    {readonly kind: 'enum' | 'struct'}
  >['kind'],
): boolean {
  switch (schema) {
    case 'int':
      return type.kind === TypeKind.Int;
    case 'float':
      return type.kind === TypeKind.Float;
    case 'bool':
      return type.kind === TypeKind.Bool;
    case 'string':
      return type.kind === TypeKind.String;
    case 'color':
      return type.kind === TypeKind.Color;
  }
}

// Shared across the module tree: helper usage, child-module declarations,
// and the M1/M2… ref counter (depth-first, deterministic).
class ModuleEmitter {
  readonly usedHelpers = new Set<HelperName>();
  readonly childDecls: string[] = [];
  readonly layouts: ValueLayout[] = [];
  private readonly layoutTypes: Type[] = [];
  private childCounter = 0;

  layoutOf(type: Type): LayoutId {
    const existing = this.layoutTypes.findIndex(candidate =>
      typesEqual(candidate, type),
    );
    if (existing >= 0) {
      return existing;
    }

    const id = this.layouts.length;
    this.layoutTypes.push(type);
    // Reserve before recursion: Node { array<Node> children } is finite at
    // runtime even though its static layout graph has a collection cycle.
    this.layouts.push({kind: 'boolean'});
    this.layouts[id] = this.buildLayout(type);
    return id;
  }

  // Effect declarations expose canonical nominal identity to hosts. Mirror
  // that identity onto the independently consumed physical JS layout so the
  // runtime can reject a manifest whose logical declaration was forged while
  // retaining the same field shape.
  registerEffectSchema(type: Type, schema: EffectValueSchema): void {
    const layoutId = this.layoutOf(type);
    const layout = this.layouts[layoutId];
    switch (schema.kind) {
      case 'enum':
        if (type.kind !== TypeKind.Enum || layout?.kind !== 'enum') {
          return fatal('enum effect schema disagrees with its IR type');
        }
        this.layouts[layoutId] = {
          ...layout,
          typeId: this.sameNominalId(layout.typeId, schema.typeId),
        };
        return;
      case 'struct':
        if (
          type.kind !== TypeKind.Struct ||
          layout?.kind !== 'struct' ||
          type.fields.length !== schema.fields.length
        ) {
          return fatal('struct effect schema disagrees with its IR type');
        }
        this.layouts[layoutId] = {
          ...layout,
          typeId: this.sameNominalId(layout.typeId, schema.typeId),
        };
        type.fields.forEach((field, index) => {
          const logical = schema.fields[index];
          if (logical === undefined || logical.name !== field.name) {
            return fatal(`struct effect schema disagrees at field ${index}`);
          }
          this.registerEffectSchema(field.type, logical.value);
        });
        return;
      default:
        if (!effectScalarMatches(type, schema.kind)) {
          return fatal(
            `${schema.kind} effect schema disagrees with its IR type`,
          );
        }
    }
  }

  private sameNominalId(existing: string | undefined, next: string): string {
    if (existing !== undefined && existing !== next) {
      return fatal(
        `one physical layout cannot represent nominal effects '${existing}' and '${next}'`,
      );
    }
    return next;
  }

  private buildLayout(type: Type): ValueLayout {
    switch (type.kind) {
      case TypeKind.Int:
      case TypeKind.Float:
        return {
          kind: 'number',
          numeric: type.kind === TypeKind.Int ? 'int' : 'float',
        };
      case TypeKind.Bool:
        return {kind: 'boolean'};
      case TypeKind.String:
      case TypeKind.Color:
        return {
          kind: 'nullable-scalar',
          scalar: type.kind === TypeKind.String ? 'string' : 'color',
        };
      case TypeKind.Enum:
        return {
          kind: 'enum',
          name: type.name,
          members: type.members.map(member => member.name),
        };
      case TypeKind.Line:
      case TypeKind.Label:
      case TypeKind.Box:
      case TypeKind.Table:
      case TypeKind.Polyline:
      case TypeKind.Linefill:
        return {kind: 'resource', handle: type.kind};
      case TypeKind.Struct:
        return {
          kind: 'struct',
          name: type.name,
          fields: type.fields.map(field => ({
            name: field.name,
            layout: this.layoutOf(field.type),
          })),
        };
      case TypeKind.Array:
        return {kind: 'array', element: this.layoutOf(type.elem)};
      case TypeKind.Matrix:
        return {kind: 'matrix', element: this.layoutOf(type.elem)};
      case TypeKind.Map:
        return {
          kind: 'map',
          key: this.layoutOf(type.key),
          value: this.layoutOf(type.value),
        };
      case TypeKind.Tuple:
        return {
          kind: 'tuple',
          elements: type.elems.map(element => this.layoutOf(element)),
        };
      case TypeKind.Na:
        return fatal('uncontextualized na type reached layout projection');
      case TypeKind.Invalid:
      case TypeKind.Void:
      case TypeKind.Plot:
      case TypeKind.Hline:
      case TypeKind.Func:
        return fatal(`non-runtime type ${type.kind} reached layout projection`);
    }
  }

  emitChild(
    child: Program,
    resultName: Name,
    parent: Generator,
  ): {ref: string; resultSlot: number} {
    this.childCounter += 1;
    const ref = `M${this.childCounter}`;
    const generator = new Generator(child, ref, this, parent);
    const body = generator.moduleBody();
    const resultSlot = generator.programFrameSlot(resultName);
    this.childDecls.push(`const ${ref} = {`, ...indent(body), '};');
    return {ref, resultSlot};
  }
}

class Generator {
  private readonly topology: FrameTopology;
  private readonly funcs: readonly IrFunc[];
  private readonly series: readonly SeriesInput[];
  private readonly builtins: readonly BuiltinInput[];
  private readonly requests: readonly RequestEdge[];
  private readonly globalParams: readonly ParamInput[];
  private readonly root: boolean;
  private readonly nameSlots = new Map<Name, {fid: number; slot: number}>();
  private readonly seriesIds = new Map<SeriesInput, number>();
  private readonly builtinIds = new Map<BuiltinInput, number>();
  private readonly paramIds = new Map<ParamInput, number>();
  private readonly paramSeriesIds = new Map<ParamInput, number>();
  private readonly outputIds = new Map<OutputDecl, number>();
  private readonly effectIds = new Map<EffectDecl, number>();
  private readonly funcIds = new Map<IrFunc, number>();
  private readonly requestIds = new Map<RequestEdge, number>();
  private tempCounter = 0;

  constructor(
    private readonly program: Program,
    private readonly moduleRef: string,
    private readonly emitter: ModuleEmitter,
    parent: Generator | null = null,
  ) {
    this.globalParams = parent?.globalParams ?? program.params;
    this.root = parent === null;
    this.topology = frameTopologyOf(program);
    this.funcs = this.topology.frames.flatMap(frame =>
      frame.owner === null ? [] : [frame.owner],
    );
    this.series = seriesInputsOf(program);
    this.builtins = builtinInputsOf(program);
    this.requests = requestsOf(program);
    this.requests.forEach((edge, rid) => {
      if (edge.dynamic) {
        return fatal('dynamic request reached generated JavaScript lowering');
      }
      this.requestIds.set(edge, rid);
    });

    this.series.forEach((s, sid) => this.seriesIds.set(s, sid));
    this.builtins.forEach((builtin, bid) => this.builtinIds.set(builtin, bid));
    let nextSid = this.series.length;
    // Parameters are compilation-global. A request child inherits the root's
    // pid map and carries the same parameter specs/values in its own concrete
    // manifest. Source-parameter reads cannot cross into children.
    if (parent !== null) {
      for (const [param, pid] of parent.paramIds) {
        this.paramIds.set(param, pid);
      }
      for (const [param, sid] of parent.paramSeriesIds) {
        this.paramSeriesIds.set(param, sid);
      }
    }
    program.params.forEach((param, pid) => {
      this.paramIds.set(param, pid);
      if (param.defaultValue?.kind === ParamDefaultKind.Series) {
        this.paramSeriesIds.set(param, nextSid);
        nextSid += 1;
      }
    });
    program.outputs.forEach((output, oid) => this.outputIds.set(output, oid));
    program.effects.forEach((effect, eid) => this.effectIds.set(effect, eid));
    this.topology.frameByFunc.forEach((frame, func) => {
      this.funcIds.set(func, frame.id);
    });
    this.topology.nameLocations.forEach((where, name) => {
      this.nameSlots.set(name, {fid: where.frameId, slot: where.slot});
    });
  }

  private ctxFor(
    fid: number,
    directNames: ReadonlyMap<Name, string> = new Map(),
  ): LowerCtx {
    return {
      nameSlots: this.nameSlots,
      directNames,
      seriesIds: this.seriesIds,
      builtinIds: this.builtinIds,
      paramIds: this.paramIds,
      paramSeriesIds: this.paramSeriesIds,
      outputIds: this.outputIds,
      effectIds: this.effectIds,
      funcIds: this.funcIds,
      requestIds: this.requestIds,
      moduleRef: this.moduleRef,
      layoutOf: type => this.emitter.layoutOf(type),
      currentFid: fid,
      noteCallSite: (siteFid, slot, callee) => {
        const frame = this.topology.frames[siteFid];
        const child = frame?.children.find(
          candidate => candidate.slot === slot,
        );
        if (child === undefined || child.callee !== callee) {
          return fatal(
            `lowered call site ${siteFid}:${slot} disagrees with frame topology`,
          );
        }
      },
      useHelper: name => {
        this.emitter.usedHelpers.add(name);
      },
      fresh: () => `t${this.tempCounter++}`,
    };
  }

  // The slot of a name in THIS module's program frame \u2014 how a parent learns
  // its child's result slot.
  programFrameSlot(name: Name): number {
    const where = this.nameSlots.get(name);
    if (where === undefined || where.fid !== 0) {
      return fatal(`'${name.name}' is not a program-frame name`);
    }
    return where.slot;
  }

  // The module object's body lines (between the braces). Every node is a
  // complete JSModule; the request tree shares the one emitted layout table.
  moduleBody(): string[] {
    // Lower all code first: call sites (frame sub layouts) and helpers are
    // discovered during lowering; the manifest is assembled afterwards.
    const concretizeLines = this.lowerConcretize();
    const funcBodies = this.lowerFuncs();
    const mainLines: string[] = [];
    lowerStmts(this.program.body, mainLines, this.ctxFor(0));

    const children = this.requests.map(edge =>
      this.emitter.emitChild(edge.child, edge.resultName, this),
    );
    const manifest = this.buildManifest(children);

    const out: string[] = [];
    out.push(`abi: ${RUNTIME_ABI_VERSION},`);
    out.push('layout: L,');
    // U+2028/2029 are line terminators in ES2015 string literals; escape
    // them so the embedded manifest stays parseable everywhere.
    out.push(`manifest: ${json(manifest)},`);
    out.push(`requests: [${children.map(c => c.ref).join(', ')}],`);
    out.push(
      'concretize(manifest, contextConstants) {',
      ...indent(concretizeLines),
      '},',
    );
    out.push('funcs: {');
    for (const [fid, lines] of funcBodies) {
      out.push(`  ${fid}: ${lines[0]}`);
      out.push(...indent(lines.slice(1)));
    }
    out.push('},');
    out.push('main(ctx, fr) {', ...indent(mainLines), '},');
    return out;
  }

  // Concretization is ordinary generated JavaScript over a fresh manifest
  // copy. Input/simple aliases and input-only UDFs become local JS values;
  // no RuntimeContext, frame, Heap, or callback evaluator participates.
  private lowerConcretize(): string[] {
    const roots = this.concretizeExpressions();
    const dependencies = this.concretizeDependencies(roots);
    const rootNames = new Map<Name, string>();
    for (const name of dependencies.names) {
      const where = this.nameSlots.get(name);
      if (
        where?.fid === 0 &&
        name.storage === Storage.PerBar &&
        qualifierLE(name.qualifier, Qualifier.Simple)
      ) {
        rootNames.set(name, `b0_${where.slot}`);
      }
    }

    const funcs = [...dependencies.funcs].sort((left, right) => {
      const l = this.funcIds.get(left) ?? fatal('unmapped concretize function');
      const r =
        this.funcIds.get(right) ?? fatal('unmapped concretize function');
      return l - r;
    });
    const funcRefs = new Map<IrFunc, string>();
    funcs.forEach(func => {
      const fid = this.funcIds.get(func);
      if (fid === undefined) return fatal('unmapped concretize function');
      funcRefs.set(func, `bF${fid}`);
    });

    const lines: string[] = [];
    for (const local of rootNames.values()) {
      lines.push(`let ${local};`);
    }
    for (const func of funcs) {
      lines.push(...this.lowerConcretizeFunc(func, rootNames, funcRefs));
    }

    const ctx = {
      ...this.ctxFor(0, rootNames),
      concretize: true,
      concretizeFuncRefs: funcRefs,
    } satisfies LowerCtx;
    const validationCtx = {...ctx, fresh: () => 'unused'} satisfies LowerCtx;
    const prelude = [...this.program.init, ...this.program.body].filter(
      stmt =>
        (stmt.kind === IrKind.InitName || stmt.kind === IrKind.WriteName) &&
        dependencies.names.has(stmt.name) &&
        qualifierLE(stmt.name.qualifier, Qualifier.Simple),
    );
    lowerStmts(prelude, lines, ctx);

    const writeDepth = (target: string, depth: HistoryDepth): void => {
      if (depth.kind !== DepthKind.Bound || depthSpec(depth).kind !== 'bound') {
        return;
      }
      const expr = lowerExpr(depth.expr, lines, ctx);
      this.emitter.usedHelpers.add('$historyDepth');
      lines.push(
        `${target} = {kind: "const", bars: $historyDepth((${expr}))};`,
      );
    };
    this.series.forEach((series, sid) =>
      writeDepth(`manifest.series[${sid}].depth`, series.depth),
    );
    this.builtins.forEach((builtin, bid) =>
      writeDepth(`manifest.builtin[${bid}].depth`, builtin.depth),
    );
    if (this.root) {
      for (const [param, sid] of this.paramSeriesIds) {
        writeDepth(`manifest.series[${sid}].depth`, param.depth);
      }
    }
    for (const [name, where] of this.nameSlots) {
      writeDepth(
        `manifest.frames[${where.fid}].locals[${where.slot}].depth`,
        name.depth,
      );
    }

    if (this.root) {
      this.program.params.forEach(param => {
        if (staticBool(param.active) !== null) return;
        const pid = this.paramIds.get(param);
        if (pid === undefined) return fatal(`unmapped param '${param.name}'`);
        const active = lowerExpr(param.active, lines, ctx);
        lines.push(`manifest.params[${pid}].active = (${active});`);
      });
    }
    this.program.outputs.forEach((output, oid) => {
      if (staticOutputArgs(output) !== null) {
        captureArguments(
          output.bindArgs.map(arg => arg.expr),
          output.bindArgumentEvaluationOrder,
          [],
          validationCtx,
          `output '${output.effect}' bind arguments`,
        );
        return;
      }
      const args = captureArguments(
        output.bindArgs.map(arg => arg.expr),
        output.bindArgumentEvaluationOrder,
        lines,
        ctx,
        `output '${output.effect}' bind arguments`,
      );
      const entries = output.bindArgs.map(
        (arg, index) =>
          `{name: ${JSON.stringify(arg.name)}, value: (${args[index]})}`,
      );
      lines.push(
        `manifest.outputs[${oid}].boundArgs = [${entries.join(', ')}];`,
      );
    });
    this.requests.forEach((edge, rid) => {
      if (staticRequestContext(edge) !== null) {
        captureArguments(
          [
            edge.merge.gaps,
            edge.merge.lookahead,
            edge.merge.ignoreInvalidSymbol,
            edge.merge.calcBarsCount,
          ],
          edge.optionArgumentEvaluationOrder,
          [],
          validationCtx,
          'request options',
        );
        captureArguments(
          [edge.symbol, edge.timeframe],
          edge.contextArgumentEvaluationOrder,
          [],
          validationCtx,
          'request context',
        );
        return;
      }
      const [gaps, lookahead, ignoreInvalidSymbol, calcBarsCount] =
        captureArguments(
          [
            edge.merge.gaps,
            edge.merge.lookahead,
            edge.merge.ignoreInvalidSymbol,
            edge.merge.calcBarsCount,
          ],
          edge.optionArgumentEvaluationOrder,
          lines,
          ctx,
          'request options',
        );
      const [symbol, timeframe] = captureArguments(
        [edge.symbol, edge.timeframe],
        edge.contextArgumentEvaluationOrder,
        lines,
        ctx,
        'request context',
      );
      lines.push(
        `manifest.requests[${rid}].context = {symbol: (${symbol}), timeframe: (${timeframe}), gaps: (${gaps}), lookahead: (${lookahead}), ignoreInvalidSymbol: (${ignoreInvalidSymbol}), calcBarsCount: (${calcBarsCount})};`,
      );
    });
    return lines;
  }

  private concretizeExpressions(): IrExpr[] {
    const expressions: IrExpr[] = [];
    const noteDepth = (depth: HistoryDepth): void => {
      if (depth.kind === DepthKind.Bound && depthSpec(depth).kind === 'bound') {
        expressions.push(depth.expr);
      }
    };
    this.series.forEach(series => noteDepth(series.depth));
    this.builtins.forEach(builtin => noteDepth(builtin.depth));
    if (this.root) {
      for (const [param] of this.paramSeriesIds) noteDepth(param.depth);
    }
    for (const [name] of this.nameSlots) noteDepth(name.depth);
    if (this.root) {
      this.program.params.forEach(param => {
        if (staticBool(param.active) === null) expressions.push(param.active);
      });
    }
    this.program.outputs.forEach(output => {
      if (staticOutputArgs(output) === null) {
        output.bindArgs.forEach(arg => expressions.push(arg.expr));
      }
    });
    this.requests.forEach(edge => {
      if (staticRequestContext(edge) === null) {
        expressions.push(
          edge.merge.gaps,
          edge.merge.lookahead,
          edge.merge.ignoreInvalidSymbol,
          edge.merge.calcBarsCount,
          edge.symbol,
          edge.timeframe,
        );
      }
    });
    return expressions;
  }

  private concretizeDependencies(expressions: readonly IrExpr[]): {
    names: Set<Name>;
    funcs: Set<IrFunc>;
  } {
    const names = new Set<Name>();
    const funcs = new Set<IrFunc>();
    const writes = new Map<Name, IrExpr>();
    for (const stmt of [...this.program.init, ...this.program.body]) {
      if (
        (stmt.kind === IrKind.InitName || stmt.kind === IrKind.WriteName) &&
        !writes.has(stmt.name)
      ) {
        writes.set(stmt.name, stmt.value);
      }
    }
    const scannedNames = new Set<Name>();
    const scanName = (name: Name): void => {
      names.add(name);
      if (scannedNames.has(name)) return;
      scannedNames.add(name);
      const value = writes.get(name);
      if (value !== undefined) scanExpr(value);
    };
    const scanFunc = (func: IrFunc): void => {
      if (funcs.has(func)) return;
      funcs.add(func);
      scanExpr(func.body);
    };
    const scanExpr = (expr: IrExpr): void => {
      walkIrExpr(expr, {
        expr: nested => {
          if (
            nested.kind === IrKind.HistRead &&
            nested.place.kind === PlaceKind.Name
          ) {
            scanName(nested.place.name);
          } else if (
            nested.kind === IrKind.CallFunc ||
            nested.kind === IrKind.CallConstMethod ||
            nested.kind === IrKind.CallMutableMethod
          ) {
            scanFunc(nested.func);
          }
        },
      });
    };
    expressions.forEach(scanExpr);
    return {names, funcs};
  }

  private lowerConcretizeFunc(
    func: IrFunc,
    rootNames: ReadonlyMap<Name, string>,
    funcRefs: ReadonlyMap<IrFunc, string>,
  ): string[] {
    const frame = this.topology.frameByFunc.get(func);
    const fid = this.funcIds.get(func);
    const ref = funcRefs.get(func);
    if (frame === undefined || fid === undefined || ref === undefined) {
      return fatal(`unmapped concretize function '${func.name}'`);
    }
    const receiver = func.callMode === 'free' ? [] : [func.receiver];
    const parameters = [...receiver, ...func.params];
    const parameterNames = parameters.map((_, index) => `p${index}`);
    const directNames = new Map(rootNames);
    parameters.forEach((param, index) =>
      directNames.set(param, parameterNames[index]),
    );
    const declarations: string[] = [];
    frame.locals.forEach((name, slot) => {
      if (directNames.has(name)) return;
      if (name.storage !== Storage.PerBar) {
        return fatal(
          `manifest concretization reached persistent local '${name.name}'`,
        );
      }
      const local = `b${fid}_${slot}`;
      directNames.set(name, local);
      declarations.push(`let ${local};`);
    });
    const ctx = {
      ...this.ctxFor(fid, directNames),
      concretize: true,
      concretizeFuncRefs: funcRefs,
    } satisfies LowerCtx;
    const body: string[] = [];
    const value = lowerExpr(func.body, body, ctx);
    return [
      `const ${ref} = (${parameterNames.join(', ')}) => {`,
      ...indent([...declarations, ...body, `return (${value});`]),
      '};',
    ];
  }

  private lowerFuncs(): Map<number, string[]> {
    const bodies = new Map<number, string[]>();
    this.funcs.forEach(func => {
      const fid = this.funcIds.get(func);
      if (fid === undefined) {
        return fatal('unmapped function during lowering');
      }
      // The generated JS ABI is internal: method receivers occupy p0, while
      // Program.params remains source-visible explicit parameters only.
      const receiver = func.callMode === 'free' ? [] : [func.receiver];
      const parameters = [...receiver, ...func.params];
      const params = parameters.map((_, i) => `p${i}`);
      const directNames = new Map<Name, string>();
      parameters.forEach((param, index) => {
        if (
          param.storage === Storage.PerBar &&
          param.depth.kind === DepthKind.None
        ) {
          directNames.set(param, params[index]);
        }
      });
      const ctx = this.ctxFor(fid, directNames);
      const lines: string[] = [
        `(ctx, fr${params.map(p => `, ${p}`).join('')}) => {`,
      ];
      // Arguments land in the frame so param history works like any name.
      parameters.forEach((param, i) => {
        if (directNames.has(param)) {
          return;
        }
        const where = this.nameSlots.get(param);
        if (where === undefined) {
          return fatal(`unmapped param '${param.name}'`);
        }
        lines.push(`  ctx.write(fr, ${where.slot}, p${i});`);
      });
      const bodyLines: string[] = [];
      const value = lowerExpr(func.body, bodyLines, ctx);
      lines.push(...indent(bodyLines));
      lines.push(`  return (${value});`);
      lines.push('},');
      bodies.set(fid, lines);
    });
    return bodies;
  }

  // ---- manifest ---------------------------------------------------------------

  private buildManifest(
    children: readonly {readonly resultSlot: number}[],
  ): ModuleManifest {
    const series: SeriesSpec[] = this.series.map(s => ({
      id: s.id,
      depth: depthSpec(s.depth),
      supplied: false,
    }));
    if (this.root) {
      for (const [param] of this.paramSeriesIds) {
        series.push({id: null, depth: depthSpec(param.depth), supplied: false});
      }
    }

    const builtin: BuiltinSpec[] = this.builtins.map(input => ({
      source: input.source,
      layout: this.emitter.layoutOf(input.type),
      depth: depthSpec(input.depth),
    }));

    const params = paramSpecsOf(this.globalParams).map((spec, pid) => {
      const param = this.globalParams[pid];
      if (param === undefined) return fatal(`missing global parameter ${pid}`);
      return {
        ...spec,
        seriesSid: this.root ? (this.paramSeriesIds.get(param) ?? null) : null,
        bindable: this.root,
        active: this.root ? staticBool(param.active) : true,
      };
    });

    const outputs: OutputSpec[] = this.program.outputs.map(output => ({
      effect: output.effect,
      staticArgs: output.staticArgs.map(a => ({
        name: a.name,
        value: constValue(a.value),
      })),
      channels: output.channels.map(ch => ({
        name: ch.name,
        type: formatType(ch.type),
        transport: outputChannelTransport(ch.type),
      })),
      boundArgs: staticOutputArgs(output),
    }));

    const effects = this.program.effects.map(effect => {
      this.emitter.registerEffectSchema(
        effect.payloadType,
        effect.payloadSchema,
      );
      return {
        layout: this.emitter.layoutOf(effect.payloadType),
        declaration: {payload: effect.payloadSchema},
      };
    });

    const frames: FrameLayout[] = this.topology.frames.map(frame => {
      const slotCount =
        frame.children.length === 0
          ? 0
          : Math.max(...frame.children.map(child => child.slot)) + 1;
      const subs: {fid: number}[] = [];
      for (let slot = 0; slot < slotCount; slot += 1) {
        const child = frame.children.find(candidate => candidate.slot === slot);
        if (child === undefined) {
          return fatal(
            `frame ${frame.id} call-site slot ${slot} is not a frame`,
          );
        }
        subs.push({fid: child.frameId});
      }
      return {
        locals: frame.locals.map(name => ({
          storage: name.storage,
          depth: depthSpec(name.depth),
          layout: this.emitter.layoutOf(name.type),
        })),
        subs,
      };
    });

    const requests: RequestSpec[] = this.requests.map((edge, rid) => {
      return {
        name: edge.name,
        merge: {
          mode: edge.merge.mode,
        },
        depth: depthSpec(edge.depth),
        resultSlot: children[rid].resultSlot,
        resultLayout: this.emitter.layoutOf(edge.captureType),
        layout: this.emitter.layoutOf(edge.resultType),
        dynamic: false,
        context: staticRequestContext(edge),
      };
    });

    return {series, builtin, params, outputs, effects, frames, requests};
  }
}

function outputChannelTransport(type: Type): OutputChannelTransport {
  switch (type.kind) {
    case TypeKind.Int:
      return {kind: 'int'};
    case TypeKind.Float:
      return {kind: 'float'};
    case TypeKind.Bool:
      return {kind: 'bool'};
    case TypeKind.String:
      return {kind: 'string'};
    case TypeKind.Color:
      return {kind: 'color'};
    case TypeKind.Enum:
      return {
        kind: 'enum',
        name: type.name,
        members: type.members.map(member => member.name),
      };
    case TypeKind.Line:
      return {kind: 'resource', handle: 'line'};
    case TypeKind.Label:
      return {kind: 'resource', handle: 'label'};
    case TypeKind.Box:
      return {kind: 'resource', handle: 'box'};
    case TypeKind.Table:
      return {kind: 'resource', handle: 'table'};
    case TypeKind.Polyline:
      return {kind: 'resource', handle: 'polyline'};
    case TypeKind.Linefill:
      return {kind: 'resource', handle: 'linefill'};
    case TypeKind.Plot:
      return {kind: 'output-ref', output: 'plot'};
    case TypeKind.Hline:
      return {kind: 'output-ref', output: 'hline'};
    case TypeKind.Struct:
      return {kind: 'struct', name: type.name};
    case TypeKind.Array:
      return {kind: 'array'};
    case TypeKind.Matrix:
      return {kind: 'matrix'};
    case TypeKind.Map:
      return {kind: 'map'};
    case TypeKind.Tuple:
      return {kind: 'tuple'};
    case TypeKind.Invalid:
    case TypeKind.Void:
    case TypeKind.Na:
    case TypeKind.Func:
      return fatal(
        `non-value output channel type ${formatType(type)} reached manifest projection`,
      );
  }
}

function json(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function depthSpec(depth: HistoryDepth): DepthSpec {
  switch (depth.kind) {
    case DepthKind.None:
      return {kind: 'none'};
    case DepthKind.Const:
      return {kind: 'const', bars: depth.bars};
    case DepthKind.Bound:
      if (
        depth.expr.kind === IrKind.Const &&
        typeof depth.expr.value === 'number'
      ) {
        return {
          kind: 'const',
          bars: historyDepth(depth.expr.value),
        };
      }
      return {kind: 'bound'};
    case DepthKind.Capped:
      return {kind: 'capped', bars: capBars(depth.bars)};
  }
}

function historyDepth(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function staticBool(expr: IrExpr): boolean | null {
  return expr.kind === IrKind.Const && typeof expr.value === 'boolean'
    ? expr.value
    : null;
}

function staticOutputArgs(
  output: OutputDecl,
): readonly {readonly name: string; readonly value: ManifestValue}[] | null {
  if (output.bindArgs.length === 0) return [];
  if (
    !output.bindArgs.every(
      arg =>
        arg.expr.kind === IrKind.Const &&
        !isNaValue(arg.expr.value) &&
        (typeof arg.expr.value !== 'number' || Number.isFinite(arg.expr.value)),
    )
  ) {
    return null;
  }
  return output.bindArgs.map(arg => {
    if (arg.expr.kind !== IrKind.Const) {
      return fatal('non-constant output argument reached static projection');
    }
    return {name: arg.name, value: constValue(arg.expr.value)};
  });
}

function staticRequestContext(edge: RequestEdge) {
  const expressions = [
    edge.merge.gaps,
    edge.merge.lookahead,
    edge.merge.ignoreInvalidSymbol,
    edge.merge.calcBarsCount,
    edge.symbol,
    edge.timeframe,
  ];
  if (!expressions.every(expr => expr.kind === IrKind.Const)) return null;
  const values = expressions.map(expr => {
    if (expr.kind !== IrKind.Const) {
      return fatal('non-constant request value reached static projection');
    }
    return constValue(expr.value);
  });
  const [
    gaps,
    lookahead,
    ignoreInvalidSymbol,
    calcBarsCount,
    symbol,
    timeframe,
  ] = values;
  if (
    typeof gaps !== 'boolean' ||
    typeof lookahead !== 'boolean' ||
    typeof ignoreInvalidSymbol !== 'boolean' ||
    typeof calcBarsCount !== 'number' ||
    !Number.isSafeInteger(calcBarsCount) ||
    calcBarsCount < 0 ||
    typeof symbol !== 'string' ||
    typeof timeframe !== 'string'
  ) {
    return fatal('constant request context has invalid values');
  }
  return {
    symbol,
    timeframe,
    gaps,
    lookahead,
    ignoreInvalidSymbol,
    calcBarsCount,
  };
}

// The depth pass materializes caps as const int expressions.
function capBars(expr: IrExpr): number {
  if (expr.kind === IrKind.Const && typeof expr.value === 'number') {
    return expr.value;
  }
  return fatal('capped depth without a constant cap');
}

function constValue(v: ConstValue): ManifestValue {
  if (isNaValue(v)) {
    return null;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) {
    return fatal('non-finite constant reached manifest construction');
  }
  return v;
}
