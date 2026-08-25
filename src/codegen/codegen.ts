// Purpose: Code generator — lowers a Tea Program to a self-describing JS module (code + manifest) against the rt ABI; docs/runtime.md owns the module contract. Dense ids are assigned here and published in the manifest — the runtime never re-derives them.

import {fatal} from '../base/print';
import {paramSpecsOf} from './params';
import {frameTopologyOf, type FrameTopology} from '../ir/frames';
import {
  DepthKind,
  IrKind,
  Storage,
  type HistoryDepth,
  type IrExpr,
  type IrStmt,
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
import {builtinInputsOf, requestsOf, seriesInputsOf} from '../ir/visit';
import {RUNTIME_ABI_VERSION} from '../runtime/module-abi';
import type {
  BuiltinSpec,
  DepthSpec,
  FrameLayout,
  ModuleManifest,
  OutputChannelTransport,
  OutputSpec,
  RequestSpec,
  SeriesSpec,
} from '../runtime/module-abi';
import type {ManifestValue} from '../runtime/value';
import type {
  AggregateLayoutManifest,
  LayoutId,
  ValueLayout,
} from '../runtime/value-layout';
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
    `const L = ${json({layouts: emitter.layouts} satisfies AggregateLayoutManifest)};`,
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
    // Bind-time params are compilation-global: a request child declares no
    // params of its own and references the PARENT's ParamInput objects, so
    // a child generator inherits the parent's pid map (the runtime serves
    // children the parent's resolved values). Source params never cross —
    // their reads are series-qualified, which the capture check rejects —
    // so the inherited paramSeriesIds entries are unreachable in a child.
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
    const bindLines = this.lowerBind();
    const funcBodies = this.lowerFuncs();
    const mainLines: string[] = [];
    lowerStmts(this.program.body, mainLines, this.ctxFor(0));

    const children = this.requests.map(edge =>
      this.emitter.emitChild(edge.child, edge.resultName, this),
    );
    const manifest = this.buildManifest(children);

    const out: string[] = [];
    out.push(`abi: ${RUNTIME_ABI_VERSION},`);
    out.push('aggregateLayouts: L,');
    // U+2028/2029 are line terminators in ES2015 string literals; escape
    // them so the embedded manifest stays parseable everywhere.
    out.push(`manifest: ${json(manifest)},`);
    out.push(`requests: [${children.map(c => c.ref).join(', ')}],`);
    out.push('bind(values) {');
    out.push(
      `  return $bind(${this.moduleRef}, values, (rt, fr) => {`,
      ...indent(indent(bindLines)),
      '  });',
      '},',
    );
    out.push('funcs: {');
    for (const [fid, lines] of funcBodies) {
      out.push(`  ${fid}: ${lines[0]}`);
      out.push(...indent(lines.slice(1)));
    }
    out.push('},');
    out.push('main(rt, fr) {', ...indent(mainLines), '},');
    return out;
  }

  // Bind-time expressions may use immutable input/simple aliases and the
  // context-constant builtins those aliases depend on.
  // Evaluate their top-level writes against a provisional program frame,
  // report the resulting depths, then consume them for the remaining
  // host-facing bind contracts. The runtime rebuilds the final frame with
  // those reported capacities after this section returns.
  private lowerBind(): string[] {
    const ctx = this.ctxFor(0);
    const lines: string[] = [];
    const bindPrelude = this.program.body.filter(
      (stmt): stmt is IrStmt =>
        stmt.kind === IrKind.WriteName &&
        qualifierLE(stmt.name.qualifier, Qualifier.Simple),
    );
    lowerStmts(bindPrelude, lines, ctx);
    this.series.forEach((s, sid) => {
      if (s.depth.kind === DepthKind.Bound) {
        const expr = lowerExpr(s.depth.expr, lines, ctx);
        lines.push(`rt.bindSeriesDepth(${sid}, (${expr}));`);
      }
    });
    this.builtins.forEach((builtin, bid) => {
      if (builtin.depth.kind === DepthKind.Bound) {
        const expr = lowerExpr(builtin.depth.expr, lines, ctx);
        lines.push(`rt.bindBuiltinDepth(${bid}, (${expr}));`);
      }
    });
    for (const [param, sid] of this.paramSeriesIds) {
      if (param.depth.kind === DepthKind.Bound) {
        const expr = lowerExpr(param.depth.expr, lines, ctx);
        lines.push(`rt.bindSeriesDepth(${sid}, (${expr}));`);
      }
    }
    for (const [name, where] of this.nameSlots) {
      if (name.depth.kind === DepthKind.Bound) {
        const expr = lowerExpr(name.depth.expr, lines, ctx);
        // The depth pass normalizes function-frame bind dependencies back to
        // root expressions, including root-owned UDF call slots.
        lines.push(`rt.bindDepth(${where.fid}, ${where.slot}, (${expr}));`);
      }
    }
    this.program.params.forEach(param => {
      const pid = this.paramIds.get(param);
      if (pid === undefined) {
        return fatal(`unmapped param '${param.name}'`);
      }
      const active = lowerExpr(param.active, lines, ctx);
      lines.push(`rt.bindParamActive(${pid}, (${active}));`);
    });
    this.program.outputs.forEach((output, oid) => {
      const args = captureArguments(
        output.bindArgs.map(arg => arg.expr),
        output.bindArgumentEvaluationOrder,
        lines,
        ctx,
        `output '${output.effect}' bind arguments`,
      );
      output.bindArgs.forEach((arg, index) => {
        lines.push(
          `rt.bindOutput(${oid}, ${JSON.stringify(arg.name)}, (${args[index]}));`,
        );
      });
    });
    // Every supported edge binds its options and fixed context pair once.
    this.requests.forEach((edge, rid) => {
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
      lines.push(
        `rt.bindRequestOptions(${rid}, (${gaps}), (${lookahead}), (${ignoreInvalidSymbol}), (${calcBarsCount}));`,
      );
      const [symbol, timeframe] = captureArguments(
        [edge.symbol, edge.timeframe],
        edge.contextArgumentEvaluationOrder,
        lines,
        ctx,
        'request context',
      );
      lines.push(`rt.bindRequest(${rid}, (${symbol}), (${timeframe}));`);
    });
    return lines;
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
        `(rt, fr${params.map(p => `, ${p}`).join('')}) => {`,
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
        lines.push(`  rt.write(fr, ${where.slot}, p${i});`);
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
    }));
    for (const [param] of this.paramSeriesIds) {
      series.push({id: null, depth: depthSpec(param.depth)});
    }

    const builtin: BuiltinSpec[] = this.builtins.map(input => ({
      source: input.source,
      layout: this.emitter.layoutOf(input.type),
      depth: depthSpec(input.depth),
    }));

    const params = paramSpecsOf(this.program.params).map((spec, pid) => ({
      ...spec,
      seriesSid: this.paramSeriesIds.get(this.program.params[pid]) ?? null,
    }));

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
      if (edge.merge.mode !== MergeMode.Sample) {
        return unimplemented('codegen: collect merge (security_lower_tf)');
      }
      return {
        merge: {
          mode: MergeMode.Sample,
        },
        depth: depthSpec(edge.depth),
        resultSlot: children[rid].resultSlot,
        layout: this.emitter.layoutOf(edge.resultType),
        dynamic: false,
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
      return {kind: 'bound'};
    case DepthKind.Capped:
      return {kind: 'capped', bars: capBars(depth.bars)};
  }
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
