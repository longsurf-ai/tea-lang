// Purpose: Code generator — lowers a Tea Program to a self-describing JS module (code + manifest) against the rt ABI; docs/runtime.md owns the module contract. Dense ids are assigned here and published in the manifest — the runtime never re-derives them.

import type {CompileConfig} from '../base/config';
import {fatal, type Errors} from '../base/print';
import {
  DepthKind,
  IrKind,
  type HistoryDepth,
  type IrExpr,
  type Name,
} from '../ir/node';
import {unimplemented} from '../base/unimplemented';
import {
  MergeMode,
  ParamDefaultKind,
  type IrFunc,
  type OutputDecl,
  type ParamInput,
  type Program,
  type RequestEdge,
  type SeriesInput,
} from '../ir/program';
import {
  formatType,
  isNaValue,
  TypeKind,
  type ConstValue,
  type Type,
} from '../ir/type';
import {
  bindEvaluable,
  funcsOf,
  namesOf,
  requestsOf,
  seriesInputsOf,
} from '../ir/visit';
import type {
  DepthSpec,
  FrameLayout,
  ModuleManifest,
  OutputSpec,
  ParamSpec,
  RequestSpec,
  SeriesSpec,
} from '../runtime/abi';
import {
  HELPERS,
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
  out.push('  abi: 1,');
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
  private childCounter = 0;

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
  private readonly requests: readonly RequestEdge[];
  private readonly nameSlots = new Map<Name, {fid: number; slot: number}>();
  private readonly seriesIds = new Map<SeriesInput, number>();
  private readonly paramIds = new Map<ParamInput, number>();
  private readonly paramSeriesIds = new Map<ParamInput, number>();
  private readonly outputIds = new Map<OutputDecl, number>();
  private readonly funcIds = new Map<IrFunc, number>();
  private readonly requestIds = new Map<RequestEdge, number>();
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
    this.requests = requestsOf(program);
    this.requests.forEach((edge, rid) => this.requestIds.set(edge, rid));

    this.series.forEach((s, sid) => this.seriesIds.set(s, sid));
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

    // Frame locals: ownership is explicit — a func owns its params and
    // declared locals; the program frame owns every remaining Name.
    const owned = new Set<Name>();
    for (const func of this.funcs) {
      for (const name of [...func.params, ...func.locals]) {
        owned.add(name);
      }
    }
    const frame0 = namesOf(this.program).filter(name => !owned.has(name));
    const locals: (readonly Name[])[] = [frame0];
    for (const func of this.funcs) {
      locals.push([...func.params, ...func.locals]);
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
      paramIds: this.paramIds,
      paramSeriesIds: this.paramSeriesIds,
      outputIds: this.outputIds,
      funcIds: this.funcIds,
      requestIds: this.requestIds,
      moduleRef: this.moduleRef,
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
    const manifestJs = JSON.stringify(manifest)
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    out.push(`manifest: ${manifestJs},`);
    out.push(`requests: [${children.map(c => c.ref).join(', ')}],`);
    out.push('init(rt) {', ...indent(initLines), '},');
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

  // The bind-time section: bound depths and output bind-args are compiled
  // expressions; binding runs this.
  private lowerInit(): string[] {
    const ctx = this.ctxFor(0);
    const lines: string[] = [];
    this.series.forEach((s, sid) => {
      if (s.depth.kind === DepthKind.Bound) {
        const expr = lowerExpr(s.depth.expr, lines, ctx);
        lines.push(`rt.bindSeriesDepth(${sid}, (${expr}));`);
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
        const expr = lowerExpr(name.depth.expr, lines, this.ctxFor(where.fid));
        // Bound name depths may only reference bind-time values, so the
        // frame handle is irrelevant to the expression itself.
        lines.push(`rt.bindDepth(${where.fid}, ${where.slot}, (${expr}));`);
      }
    }
    this.program.outputs.forEach((output, oid) => {
      for (const arg of output.bindArgs) {
        const expr = lowerExpr(arg.expr, lines, ctx);
        lines.push(
          `rt.bindOutput(${oid}, ${JSON.stringify(arg.name)}, (${expr}));`,
        );
      }
    });
    // Static request contexts: bind resolves the pair, runs the child, and
    // prepares the merged view before row 0. Series-qualified context args
    // are the dynamic form — a later slice, never wrong code.
    this.requests.forEach((edge, rid) => {
      if (!bindEvaluable(edge.symbol) || !bindEvaluable(edge.timeframe)) {
        return unimplemented('codegen: dynamic request contexts');
      }
      if (edge.merge.currency !== null) {
        return unimplemented('codegen: request currency conversion');
      }
      if (edge.merge.calcBarsCount !== null) {
        return unimplemented('codegen: request calc_bars_count');
      }
      const symbol = lowerExpr(edge.symbol, lines, ctx);
      const timeframe = lowerExpr(edge.timeframe, lines, ctx);
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
      const params = func.params.map((_, i) => `p${i}`);
      const lines: string[] = [
        `(rt, fr${params.map(p => `, ${p}`).join('')}) => {`,
      ];
      // Arguments land in the frame so param history works like any name.
      func.params.forEach((param, i) => {
        const where = this.nameSlots.get(param);
        if (where === undefined) {
          return fatal(`unmapped param '${param.name}'`);
        }
        lines.push(`  rt.write(fr, ${where.slot}, p${i});`);
      });
      const bodyLines: string[] = [];
      const value = lowerExpr(func.body, bodyLines, ctx);
      lines.push(...indent(bodyLines), `  return (${value});`, '},');
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

    const params: ParamSpec[] = this.program.params.map(param => ({
      name: param.name,
      title: param.title,
      type: paramType(param),
      defaultValue: paramDefault(param),
      constraints:
        param.constraints === null
          ? null
          : {
              minval: numOrNull(param.constraints.minval),
              maxval: numOrNull(param.constraints.maxval),
              options:
                param.constraints.options?.map(v => constValue(v)) ?? null,
            },
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
          ref: isRefType(name.type),
        })),
        subs,
      };
    });

    const requests: RequestSpec[] = this.requests.map((edge, rid) => {
      if (edge.merge.mode !== MergeMode.Sample) {
        return unimplemented('codegen: collect merge (security_lower_tf)');
      }
      // A tuple result would need per-element na handling in the merged
      // view (a single ref bit cannot describe it) — staged, never wrong
      // code.
      if (edge.resultType.kind === TypeKind.Tuple) {
        return unimplemented('codegen: tuple request results');
      }
      return {
        merge: {
          mode: MergeMode.Sample,
          gaps: edge.merge.gaps,
          lookahead: edge.merge.lookahead,
          ignoreInvalidSymbol: edge.merge.ignoreInvalidSymbol,
        },
        depth: depthSpec(edge.depth),
        resultSlot: children[rid].resultSlot,
        ref: isRefType(edge.resultType),
      };
    });

    return {series, params, outputs, frames, requests};
  }
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

function isRefType(t: Type): boolean {
  return (
    t.kind === TypeKind.String ||
    t.kind === TypeKind.Color ||
    t.kind === TypeKind.Udt ||
    t.kind === TypeKind.Enum ||
    t.kind === TypeKind.Tuple
  );
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

function constValue(v: ConstValue): number | string | boolean | null {
  return isNaValue(v) ? null : v;
}

function numOrNull(v: ConstValue | null): number | null {
  return typeof v === 'number' ? v : null;
}
