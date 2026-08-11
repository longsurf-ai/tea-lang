// Purpose: Code generator — lowers a Tea Program to a self-describing JS module (code + manifest) against the rt ABI; docs/runtime.md owns the module contract. Dense ids are assigned here and published in the manifest — the runtime never re-derives them.

import type {CompileConfig} from '../base/config';
import {fatal, type Errors} from '../base/print';
import {
  DepthKind,
  IrKind,
  type HistoryDepth,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../ir/node';
import {unimplemented} from '../base/unimplemented';
import {
  MergeMode,
  ParamConstraintKind,
  ParamDefaultKind,
  type IrFunc,
  type ExecutionInput,
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
  executionInputsOf,
  funcsOf,
  namesOf,
  requestsOf,
  seriesInputsOf,
} from '../ir/visit';
import type {
  DepthSpec,
  ExecutionSpec,
  FrameLayout,
  ManifestValue,
  ModuleManifest,
  OutputSpec,
  ParamSpec,
  RequestSpec,
  SeriesSpec,
} from '../runtime/abi';
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

export function generate(
  program: Program,
  config: CompileConfig,
  errors: Errors,
): string {
  void config;
  void errors;
  const emitter = new ModuleEmitter();
  const rootBody = new Generator(program, 'M', emitter).moduleBody();
  const out: string[] = ['"use strict";'];
  for (const name of [...emitter.usedHelpers].sort()) {
    out.push(`const ${name} = ${HELPERS[name]};`);
  }
  // Request children are sibling consts in dependency order (a nested
  // child's const precedes its parent's), referenced from the requests
  // arrays — code cannot live inside the JSON manifest.
  out.push(...emitter.childDecls);
  out.push('const M = {');
  out.push('  abi: 4,');
  out.push(
    `  aggregateLayouts: ${json({layouts: emitter.layouts} satisfies AggregateLayoutManifest)},`,
  );
  out.push(...indent(rootBody));
  out.push('};');
  out.push('return M;');
  return `${out.join('\n')}\n`;
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
      case TypeKind.UserType:
        return {
          kind: 'user-type',
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
  private readonly funcs: readonly IrFunc[];
  private readonly series: readonly SeriesInput[];
  private readonly executions: readonly ExecutionInput[];
  private readonly requests: readonly RequestEdge[];
  private readonly nameSlots = new Map<Name, {fid: number; slot: number}>();
  private readonly seriesIds = new Map<SeriesInput, number>();
  private readonly executionIds = new Map<ExecutionInput, number>();
  private readonly paramIds = new Map<ParamInput, number>();
  private readonly paramSeriesIds = new Map<ParamInput, number>();
  private readonly outputIds = new Map<OutputDecl, number>();
  private readonly funcIds = new Map<IrFunc, number>();
  private readonly requestIds = new Map<RequestEdge, number>();
  private readonly dynamicRequests = new Set<RequestEdge>();
  // fid → slot → callee fid, discovered while lowering call sites.
  private readonly callSites = new Map<number, Map<number, number>>();
  // fid → its locals in slot order.
  private readonly frameLocals: readonly (readonly Name[])[];
  private tempCounter = 0;

  constructor(
    private readonly program: Program,
    private readonly moduleRef: string,
    private readonly emitter: ModuleEmitter,
    parent: Generator | null = null,
  ) {
    this.funcs = funcsOf(program);
    this.series = seriesInputsOf(program);
    this.executions = executionInputsOf(program);
    this.requests = requestsOf(program);
    this.requests.forEach((edge, rid) => {
      this.requestIds.set(edge, rid);
      // The noder owns this classification while the expression's frame is
      // known. Dynamic edges have no bind-time pair and use rt.requestFor.
      if (edge.dynamic) {
        this.dynamicRequests.add(edge);
      }
    });

    this.series.forEach((s, sid) => this.seriesIds.set(s, sid));
    this.executions.forEach((execution, eid) =>
      this.executionIds.set(execution, eid),
    );
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
    this.funcs.forEach((func, i) => this.funcIds.set(func, i + 1));

    // Frame locals: ownership is explicit — a method owns its hidden receiver,
    // then every function owns its source-visible params and declared locals;
    // the program frame owns every remaining Name.
    const owned = new Set<Name>();
    for (const func of this.funcs) {
      const receiver = func.callMode === 'free' ? [] : [func.receiver];
      if (
        func.callMode !== 'free' &&
        (func.params.includes(func.receiver) ||
          func.locals.includes(func.receiver))
      ) {
        fatal(
          `method '${func.name}' hidden receiver also appears in explicit params or locals`,
        );
      }
      for (const name of [...receiver, ...func.params, ...func.locals]) {
        owned.add(name);
      }
    }
    const frame0 = namesOf(this.program).filter(name => !owned.has(name));
    const locals: (readonly Name[])[] = [frame0];
    for (const func of this.funcs) {
      const receiver = func.callMode === 'free' ? [] : [func.receiver];
      locals.push([...receiver, ...func.params, ...func.locals]);
    }
    this.frameLocals = locals;
    locals.forEach((names, fid) => {
      names.forEach((name, slot) => {
        if (this.nameSlots.has(name)) {
          fatal(`name '${name.name}' owned by two frames`);
        }
        this.nameSlots.set(name, {fid, slot});
      });
    });
  }

  private ctxFor(fid: number): LowerCtx {
    return {
      nameSlots: this.nameSlots,
      seriesIds: this.seriesIds,
      executionIds: this.executionIds,
      paramIds: this.paramIds,
      paramSeriesIds: this.paramSeriesIds,
      outputIds: this.outputIds,
      funcIds: this.funcIds,
      requestIds: this.requestIds,
      dynamicRequests: this.dynamicRequests,
      moduleRef: this.moduleRef,
      layoutOf: type => this.emitter.layoutOf(type),
      currentFid: fid,
      noteCallSite: (siteFid, slot, callee) => {
        const calleeFid = this.funcIds.get(callee);
        if (calleeFid === undefined) {
          return fatal(`call site to unmapped function '${callee.name}'`);
        }
        let slots = this.callSites.get(siteFid);
        if (slots === undefined) {
          slots = new Map();
          this.callSites.set(siteFid, slots);
        }
        const existing = slots.get(slot);
        if (existing !== undefined && existing !== calleeFid) {
          return fatal(`slot ${slot} of frame ${siteFid} has two callees`);
        }
        slots.set(slot, calleeFid);
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

  // The module object's body lines (between the braces). The root wraps
  // them with abi + return; children become sibling consts via the emitter.
  moduleBody(): string[] {
    // Lower all code first: call sites (frame sub layouts) and helpers are
    // discovered during lowering; the manifest is assembled afterwards.
    const initLines = this.lowerInit();
    const bindLines = this.lowerBind();
    const initThunks = this.lowerInitThunks();
    const funcBodies = this.lowerFuncs();
    const mainLines: string[] = [];
    lowerStmts(this.program.body, mainLines, this.ctxFor(0));

    const children = this.requests.map(edge =>
      this.emitter.emitChild(edge.child, edge.resultName, this),
    );
    const manifest = this.buildManifest(children);

    const out: string[] = [];
    // U+2028/2029 are line terminators in ES2015 string literals; escape
    // them so the embedded manifest stays parseable everywhere.
    out.push(`manifest: ${json(manifest)},`);
    out.push(`requests: [${children.map(c => c.ref).join(', ')}],`);
    out.push('init(rt) {', ...indent(initLines), '},');
    out.push('bind(rt, fr) {', ...indent(bindLines), '},');
    out.push('inits: {');
    for (const [key, lines] of initThunks) {
      out.push(`  ${JSON.stringify(key)}: (rt, fr) => {`);
      out.push(...indent(indent(lines)));
      out.push('  },');
    }
    out.push('},');
    out.push('funcs: {');
    for (const [fid, lines] of funcBodies) {
      out.push(`  ${fid}: ${lines[0]}`);
      out.push(...indent(lines.slice(1)));
    }
    out.push('},');
    out.push('main(rt, fr) {', ...indent(mainLines), '},');
    return out;
  }

  // Reserved for frame-free preparation before the provisional bind frame is
  // allocated. Bound depths run in lowerBind because they may read immutable
  // input aliases from that frame.
  private lowerInit(): string[] {
    return [];
  }

  // Bind-time expressions may use immutable input/simple aliases and the
  // context-constant execution inputs those aliases depend on.
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
    this.executions.forEach((execution, eid) => {
      if (execution.depth.kind === DepthKind.Bound) {
        const expr = lowerExpr(execution.depth.expr, lines, ctx);
        lines.push(`rt.bindExecutionDepth(${eid}, (${expr}));`);
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
    // Every edge binds its options exactly once. A static edge separately
    // binds its context pair; a dynamic edge evaluates that pair per row.
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
      if (this.dynamicRequests.has(edge)) {
        return;
      }
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

  private lowerInitThunks(): Map<string, string[]> {
    const thunks = new Map<string, string[]>();
    this.frameLocals.forEach((names, fid) => {
      names.forEach((name, slot) => {
        if (name.init === null) {
          return;
        }
        const ctx = this.ctxFor(fid);
        const lines: string[] = [];
        const expr = lowerExpr(name.init, lines, ctx);
        lines.push(`return (${expr});`);
        thunks.set(`${fid}:${slot}`, lines);
      });
    });
    return thunks;
  }

  private lowerFuncs(): Map<number, string[]> {
    const bodies = new Map<number, string[]>();
    this.funcs.forEach(func => {
      const fid = this.funcIds.get(func);
      if (fid === undefined) {
        return fatal('unmapped function during lowering');
      }
      const ctx = this.ctxFor(fid);
      // The generated JS ABI is internal: method receivers occupy p0, while
      // Program.params remains source-visible explicit parameters only.
      const receiver = func.callMode === 'free' ? [] : [func.receiver];
      const parameters = [...receiver, ...func.params];
      const params = parameters.map((_, i) => `p${i}`);
      const lines: string[] = [
        `(rt, fr${params.map(p => `, ${p}`).join('')}) => {`,
      ];
      // Arguments land in the frame so param history works like any name.
      parameters.forEach((param, i) => {
        const where = this.nameSlots.get(param);
        if (where === undefined) {
          return fatal(`unmapped param '${param.name}'`);
        }
        lines.push(`  rt.write(fr, ${where.slot}, p${i});`);
      });
      const bodyLines: string[] = [];
      const value = lowerExpr(func.body, bodyLines, ctx);
      lines.push(...indent(bodyLines));
      if (func.callMode === 'mutable-method') {
        const receiverSlot = this.nameSlots.get(func.receiver);
        if (receiverSlot === undefined || receiverSlot.fid !== fid) {
          return fatal(`mutable method '${func.name}' has an unowned receiver`);
        }
        lines.push(
          `  return {receiver: rt.read(fr, ${receiverSlot.slot}, 0), result: (${value})};`,
        );
      } else {
        lines.push(`  return (${value});`);
      }
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

    const execution: ExecutionSpec[] = this.executions.map(input => ({
      source: input.source,
      layout: this.emitter.layoutOf(input.type),
      depth: depthSpec(input.depth),
    }));

    const params: ParamSpec[] = this.program.params.map(param => ({
      name: param.name,
      title: param.title,
      type: paramType(param),
      control: param.control,
      group: param.group,
      inline: param.inline,
      tooltip: param.tooltip,
      confirm: param.confirm,
      display: param.display,
      defaultValue: paramDefault(param),
      constraints: paramConstraints(param),
      enumType:
        param.type.kind === TypeKind.Enum
          ? {
              name: param.type.name,
              members: param.type.members.map(member => ({...member})),
            }
          : null,
      seriesSid: this.paramSeriesIds.get(param) ?? null,
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
      })),
    }));

    const frames: FrameLayout[] = this.frameLocals.map((names, fid) => {
      const sites = this.callSites.get(fid) ?? new Map<number, number>();
      const slotCount = sites.size === 0 ? 0 : Math.max(...sites.keys()) + 1;
      const subs: {fid: number}[] = [];
      for (let slot = 0; slot < slotCount; slot += 1) {
        const callee = sites.get(slot);
        if (callee === undefined) {
          return fatal(`frame ${fid} call-site slot ${slot} never lowered`);
        }
        subs.push({fid: callee});
      }
      return {
        locals: names.map(name => ({
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
        dynamic: this.dynamicRequests.has(edge),
      };
    });

    return {series, execution, params, outputs, frames, requests};
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

function paramType(param: ParamInput): ParamSpec['type'] {
  if (param.defaultValue?.kind === ParamDefaultKind.Series) {
    return 'source';
  }
  switch (param.type.kind) {
    case TypeKind.Int:
      return 'int';
    case TypeKind.Float:
      return 'float';
    case TypeKind.Bool:
      return 'bool';
    case TypeKind.String:
      return 'string';
    case TypeKind.Color:
      return 'color';
    case TypeKind.Enum:
      return 'enum';
    default:
      return fatal(`param '${param.name}' has no manifest type`);
  }
}

function paramDefault(param: ParamInput): ParamSpec['defaultValue'] {
  if (param.defaultValue === null) {
    return null;
  }
  if (param.defaultValue.kind === ParamDefaultKind.Series) {
    return param.defaultValue.series.id;
  }
  return constValue(param.defaultValue.value);
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

function numOrNull(v: ConstValue | null): number | null {
  if (typeof v !== 'number') {
    return null;
  }
  return Number.isFinite(v)
    ? v
    : fatal('non-finite numeric constraint reached manifest construction');
}

function paramConstraints(param: ParamInput): ParamSpec['constraints'] {
  const constraints = param.constraints;
  if (constraints === null) {
    return null;
  }
  switch (constraints.kind) {
    case ParamConstraintKind.Range:
      return {
        kind: ParamConstraintKind.Range,
        minval: numOrNull(constraints.minval),
        maxval: numOrNull(constraints.maxval),
        step: numOrNull(constraints.step),
      };
    case ParamConstraintKind.Options:
      return {
        kind: ParamConstraintKind.Options,
        options: constraints.options.map(value => constValue(value)),
      };
  }
}
