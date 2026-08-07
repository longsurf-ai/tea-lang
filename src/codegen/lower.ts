// Purpose: Expression and statement lowering — the JS emitter rules: Time-Machine ops call rt, everything else expands inline; backend-specific choices live in the tables here, never in the driver walk.

import {fatal} from '../base/print';
import {unimplemented} from '../base/unimplemented';
import {
  IrKind,
  IrOp,
  PlaceKind,
  type IrBinaryOp,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../ir/node';
import type {
  IrFunc,
  OutputDecl,
  ParamInput,
  RequestEdge,
  SeriesInput,
} from '../ir/program';
import {isNaValue, TypeKind, type Type} from '../ir/type';
import {ValueClass, type ValueClass as ValueClassType} from '../runtime/abi';

// Everything the walk needs to address program objects as dense ids. The
// driver (codegen.ts) builds it; call sites discovered during lowering are
// reported back through noteCallSite.
export interface LowerCtx {
  readonly nameSlots: Map<Name, {fid: number; slot: number}>;
  readonly seriesIds: Map<SeriesInput, number>;
  readonly paramIds: Map<ParamInput, number>;
  // input.source params read as series through their bound slot.
  readonly paramSeriesIds: Map<ParamInput, number>;
  readonly outputIds: Map<OutputDecl, number>;
  readonly funcIds: Map<IrFunc, number>;
  readonly requestIds: Map<RequestEdge, number>;
  // Dynamic edges (series context args): the offset-0 read evaluates the
  // args inline and calls rt.requestFor; history reads stay rt.request.
  readonly dynamicRequests: ReadonlySet<RequestEdge>;
  // The generated const this module's own code refers to itself by ('M'
  // for the root, 'M1'… for request children) — funcs-table dispatch must
  // name the module that owns the func.
  readonly moduleRef: string;
  // The frame whose handle is in scope as `fr` while lowering.
  currentFid: number;
  noteCallSite(fid: number, slot: number, callee: IrFunc): void;
  useHelper(name: HelperName): void;
  fresh(): string;
}

// Pure helper functions emitted once at the top of the module when used.
// Division/modulo by zero is na per Pine, unlike JS Infinity.
export const HELPERS = {
  $div: '(a, b) => (b === 0 ? NaN : a / b)',
  $mod: '(a, b) => (b === 0 ? NaN : a % b)',
  $num: '(x) => (Number.isFinite(x) ? x : NaN)',
  $eq: '(a, b) => (a === null || b === null || Number.isNaN(a) || Number.isNaN(b) ? false : a === b)',
  $ne: '(a, b) => (a === null || b === null || Number.isNaN(a) || Number.isNaN(b) ? false : a !== b)',
  $concat: '(a, b) => (a === null || b === null ? null : a + b)',
  $naBool: '(_) => false',
  $round2:
    '(x, p) => { const m = Math.pow(10, p); return Math.round(x * m) / m; }',
  $nzNum: '(x, r) => (Number.isNaN(x) ? r : x)',
  $nzRef: '(x, r) => (x === null ? r : x)',
  $toString: "(x) => (x === null || Number.isNaN(x) ? 'NaN' : String(x))",
  $enumToString:
    "(x, pairs) => { if (x === null) { return 'NaN'; } for (let i = 0; i < pairs.length; i += 1) { if (pairs[i][0] === x) { return pairs[i][1]; } } return String(x); }",
  // Mirror base/color.ts (parity-locked by test): canonical hex, clamped
  // domains, na/non-finite numeric input → na out, per Pine.
  $colorNew:
    "(c, t) => { if (c === null || !Number.isFinite(t)) { return null; } const tc = Math.max(0, Math.min(100, t)); const base = c.slice(0, 7); if (tc === 0) { return base; } const a = Math.round((100 - tc) * 2.55).toString(16).toUpperCase(); return base + (a.length < 2 ? '0' + a : a); }",
  $colorRgb:
    "(r, g, b, t) => { if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || (t !== null && !Number.isFinite(t))) { return null; } const h = x => { const c = Math.max(0, Math.min(255, Math.round(x))).toString(16).toUpperCase(); return c.length < 2 ? '0' + c : c; }; const base = '#' + h(r) + h(g) + h(b); const tc = t === null ? 0 : Math.max(0, Math.min(100, t)); if (tc === 0) { return base; } const a = Math.round((100 - tc) * 2.55).toString(16).toUpperCase(); return base + (a.length < 2 ? '0' + a : a); }",
} as const;

export type HelperName = keyof typeof HELPERS;

// The generated backend's one projection from semantic types to the three
// runtime empty-value families. Manifest construction consumes the same
// projection so frames and lowered expressions cannot disagree.
export function valueClassOf(t: Type): ValueClassType {
  switch (t.kind) {
    case TypeKind.Int:
    case TypeKind.Float:
      return ValueClass.Numeric;
    case TypeKind.Bool:
      return ValueClass.Boolean;
    case TypeKind.String:
    case TypeKind.Color:
    case TypeKind.Line:
    case TypeKind.Label:
    case TypeKind.Box:
    case TypeKind.Table:
    case TypeKind.Polyline:
    case TypeKind.Linefill:
    case TypeKind.Array:
    case TypeKind.Matrix:
    case TypeKind.Map:
    case TypeKind.Udt:
    case TypeKind.Enum:
    case TypeKind.Tuple:
      return ValueClass.Reference;
    case TypeKind.Na:
      return fatal('uncontextualized na type reached lowering');
    case TypeKind.Invalid:
    case TypeKind.Void:
    case TypeKind.Plot:
    case TypeKind.Hline:
    case TypeKind.Func:
      return fatal(`non-runtime type ${t.kind} reached value lowering`);
  }
}

function emptyLiteral(t: Type): string {
  if (t.kind === TypeKind.Void) {
    return 'undefined';
  }
  switch (valueClassOf(t)) {
    case ValueClass.Numeric:
      return 'NaN';
    case ValueClass.Reference:
      return 'null';
    case ValueClass.Boolean:
      return 'false';
  }
}

function naLiteral(t: Type): string {
  const valueClass = valueClassOf(t);
  if (valueClass === ValueClass.Boolean) {
    return fatal('bool na reached lowering');
  }
  return valueClass === ValueClass.Reference ? 'null' : 'NaN';
}

// The frame handle expression for a name: the current frame, or the program
// frame — the one legal cross-frame access (functions read globals through
// rt.root(), never other frames).
function frameRef(ctx: LowerCtx, name: Name): string {
  const entry = ctx.nameSlots.get(name);
  if (entry === undefined) {
    return fatal(`lowering reached an unmapped name '${name.name}'`);
  }
  if (entry.fid === ctx.currentFid) {
    return 'fr';
  }
  if (entry.fid === 0) {
    return 'rt.root()';
  }
  return fatal(
    `name '${name.name}' of frame ${entry.fid} referenced from frame ${ctx.currentFid}`,
  );
}

function slotOf(ctx: LowerCtx, name: Name): number {
  const entry = ctx.nameSlots.get(name);
  if (entry === undefined) {
    return fatal(`lowering reached an unmapped name '${name.name}'`);
  }
  return entry.slot;
}

const BINARY_JS: Partial<Record<IrBinaryOp, string>> = {
  [IrOp.Add]: '+',
  [IrOp.Sub]: '-',
  [IrOp.Mul]: '*',
  [IrOp.Lt]: '<',
  [IrOp.Le]: '<=',
  [IrOp.Gt]: '>',
  [IrOp.Ge]: '>=',
};

// ---- expressions ------------------------------------------------------------

// Lowers `e` to a JS expression string; statement-shaped constructs emit
// into `out` and return a temp. Left-to-right evaluation order is preserved
// by materializing earlier operands into temps whenever a later operand
// needs statements.
export function lowerExpr(e: IrExpr, out: string[], ctx: LowerCtx): string {
  switch (e.kind) {
    case IrKind.Const: {
      const v = e.value;
      if (isNaValue(v)) {
        return naLiteral(e.type);
      }
      if (typeof v === 'number') {
        return Number.isFinite(v)
          ? String(v)
          : fatal('non-finite constant reached lowering');
      }
      if (typeof v === 'boolean') {
        return String(v);
      }
      return JSON.stringify(v);
    }
    case IrKind.OutputRef: {
      // Output references cross the ABI as their oid (fill's plot args).
      const oid = ctx.outputIds.get(e.output);
      if (oid === undefined) {
        return fatal('lowering reached an unmapped output reference');
      }
      return String(oid);
    }
    case IrKind.HistRead: {
      const off = e.offset === null ? '0' : subexpr(e.offset, out, ctx).expr;
      switch (e.place.kind) {
        case PlaceKind.Name:
          return `rt.read(${frameRef(ctx, e.place.name)}, ${slotOf(ctx, e.place.name)}, ${off})`;
        case PlaceKind.Series: {
          const sid = ctx.seriesIds.get(e.place.series);
          if (sid === undefined) {
            return fatal(`unmapped series '${e.place.series.id}'`);
          }
          return `rt.series(${sid}, ${off})`;
        }
        case PlaceKind.Param: {
          const sid = ctx.paramSeriesIds.get(e.place.param);
          if (sid !== undefined) {
            return `rt.series(${sid}, ${off})`;
          }
          const pid = ctx.paramIds.get(e.place.param);
          if (pid === undefined) {
            return fatal(`unmapped param '${e.place.param.name}'`);
          }
          // Scalar params are constant over rows; history is the value.
          return `rt.param(${pid})`;
        }
        case PlaceKind.Request: {
          const edge = e.place.request;
          const rid = ctx.requestIds.get(edge);
          if (rid === undefined) {
            return fatal('lowering reached an unmapped request edge');
          }
          if (e.offset === null && ctx.dynamicRequests.has(edge)) {
            const symbol = subexpr(edge.symbol, out, ctx).expr;
            const timeframe = subexpr(edge.timeframe, out, ctx).expr;
            return `rt.requestFor(${rid}, (${symbol}), (${timeframe}))`;
          }
          return `rt.request(${rid}, ${off})`;
        }
        default:
          return fatal('unhandled place kind');
      }
    }
    case IrKind.Binary:
      return lowerBinary(e.op, e.x, e.y, e.type, out, ctx);
    case IrKind.Unary: {
      const x = lowerExpr(e.x, out, ctx);
      if (e.op !== IrOp.Neg) {
        return `(!(${x}))`;
      }
      ctx.useHelper('$num');
      return `$num(-(${x}))`;
    }
    case IrKind.Cond: {
      // Pine evaluates all three operands eagerly.
      const c = subexpr(e.cond, out, ctx).expr;
      const t = subexpr(e.then, out, ctx).expr;
      const f = subexpr(e.else, out, ctx).expr;
      return `((${c}) ? (${t}) : (${f}))`;
    }
    case IrKind.CallFunc: {
      const fid = ctx.funcIds.get(e.func);
      if (fid === undefined) {
        return fatal(`unmapped function '${e.func.name}'`);
      }
      ctx.noteCallSite(ctx.currentFid, e.slot, e.func);
      const args = e.args.map(a => subexpr(a, out, ctx).expr);
      return `${ctx.moduleRef}.funcs[${fid}](rt, rt.frame(fr, ${e.slot})${args.map(a => `, (${a})`).join('')})`;
    }
    case IrKind.CallNative:
      return lowerNative(e.native, e.args, out, ctx);
    case IrKind.MakeTuple: {
      const elems = e.elems.map(el => subexpr(el, out, ctx).expr);
      return `[${elems.map(x => `(${x})`).join(', ')}]`;
    }
    case IrKind.TupleGet: {
      const x = lowerExpr(e.x, out, ctx);
      return `((${x})[${e.index}])`;
    }
    case IrKind.NewUdt:
    case IrKind.FieldGet:
      return unimplemented('codegen: UDT execution');
    case IrKind.IfExpr: {
      const temp = ctx.fresh();
      out.push(`let ${temp} = ${emptyLiteral(e.type)};`);
      const c = lowerExpr(e.cond, out, ctx);
      const thenLines: string[] = [];
      const thenVal = lowerBlockInto(e.then, thenLines, ctx);
      if (thenVal !== null) {
        thenLines.push(`${temp} = (${thenVal});`);
      }
      out.push(`if (${c}) {`, ...indent(thenLines));
      if (e.else !== null) {
        const elseLines: string[] = [];
        const elseVal = lowerBlockInto(e.else, elseLines, ctx);
        if (elseVal !== null) {
          elseLines.push(`${temp} = (${elseVal});`);
        }
        out.push('} else {', ...indent(elseLines));
      }
      out.push('}');
      return temp;
    }
    case IrKind.SwitchExpr: {
      const temp = ctx.fresh();
      out.push(`let ${temp} = ${emptyLiteral(e.type)};`);
      const subject =
        e.subject !== null ? subexpr(e.subject, out, ctx).expr : null;
      e.arms.forEach((arm, i) => {
        const isFirst = i === 0;
        const armLines: string[] = [];
        const val = lowerBlockInto(arm.body, armLines, ctx);
        if (val !== null) {
          armLines.push(`${temp} = (${val});`);
        }
        if (arm.pattern === null) {
          out.push(isFirst ? '{' : '} else {', ...indent(armLines));
          return;
        }
        // Patterns are const expressions; lowering them emits no statements.
        const p = lowerExpr(arm.pattern, out, ctx);
        if (subject !== null) {
          ctx.useHelper('$eq');
        }
        const test = subject !== null ? `$eq((${subject}), (${p}))` : `(${p})`;
        out.push(
          `${isFirst ? '' : '} else '}if (${test}) {`,
          ...indent(armLines),
        );
      });
      out.push('}');
      return temp;
    }
    case IrKind.ForExpr: {
      const temp = ctx.fresh();
      out.push(`let ${temp} = ${emptyLiteral(e.type)};`);
      const from = subexpr(e.from, out, ctx).expr;
      const to = subexpr(e.to, out, ctx).expr;
      const step = e.step !== null ? subexpr(e.step, out, ctx).expr : '1';
      const fromT = ctx.fresh();
      const toT = ctx.fresh();
      const stepT = ctx.fresh();
      out.push(
        `const ${fromT} = (${from});`,
        `const ${toT} = (${to});`,
        `const ${stepT} = (${step});`,
      );
      const frRef = frameRef(ctx, e.index);
      const slot = slotOf(ctx, e.index);
      const idx = `rt.read(${frRef}, ${slot}, 0)`;
      const bodyLines: string[] = [];
      const val = lowerBlockInto(e.body, bodyLines, ctx);
      if (val !== null) {
        bodyLines.push(`${temp} = (${val});`);
      }
      ctx.useHelper('$num');
      out.push(
        `for (rt.write(${frRef}, ${slot}, ${fromT}); (${stepT}) >= 0 ? (${idx}) <= (${toT}) : (${idx}) >= (${toT}); rt.write(${frRef}, ${slot}, $num((${idx}) + (${stepT})))) {`,
        ...indent(bodyLines),
        '}',
      );
      return temp;
    }
    case IrKind.WhileExpr: {
      const temp = ctx.fresh();
      out.push(`let ${temp} = ${emptyLiteral(e.type)};`, 'for (;;) {');
      const condLines: string[] = [];
      const c = lowerExpr(e.cond, condLines, ctx);
      const bodyLines: string[] = [];
      const val = lowerBlockInto(e.body, bodyLines, ctx);
      if (val !== null) {
        bodyLines.push(`${temp} = (${val});`);
      }
      out.push(
        ...indent([...condLines, `if (!(${c})) { break; }`, ...bodyLines]),
        '}',
      );
      return temp;
    }
    case IrKind.ForInExpr:
      return unimplemented('codegen: for-in over collections');
    case IrKind.BlockExpr: {
      lowerStmts(e.stmts, out, ctx);
      return e.value !== null ? lowerExpr(e.value, out, ctx) : 'undefined';
    }
  }
}

// And/Or are lazy (Pine v6): when the right side needs statements, lower
// through an explicit branch so it does not execute eagerly.
function lowerBinary(
  op: IrBinaryOp,
  xe: IrExpr,
  ye: IrExpr,
  type: Type,
  out: string[],
  ctx: LowerCtx,
): string {
  if (op === IrOp.And || op === IrOp.Or) {
    const x = lowerExpr(xe, out, ctx);
    const yLines: string[] = [];
    const y = lowerExpr(ye, yLines, ctx);
    if (yLines.length === 0) {
      return op === IrOp.And ? `((${x}) && (${y}))` : `((${x}) || (${y}))`;
    }
    const temp = ctx.fresh();
    out.push(`let ${temp} = (${x});`);
    const guard = op === IrOp.And ? `if (${temp}) {` : `if (!(${temp})) {`;
    out.push(guard, ...indent([...yLines, `${temp} = (${y});`]), '}');
    return temp;
  }

  const x = subexpr(xe, out, ctx);
  const y = subexpr(ye, out, ctx);
  // Preserve left-to-right order: if lowering y emitted statements, x was
  // already materialized by subexpr.
  if (op === IrOp.Eq || op === IrOp.Ne) {
    const helper = op === IrOp.Eq ? '$eq' : '$ne';
    ctx.useHelper(helper);
    return `${helper}((${x.expr}), (${y.expr}))`;
  }
  if (op === IrOp.Add && type.kind === TypeKind.String) {
    ctx.useHelper('$concat');
    return `$concat((${x.expr}), (${y.expr}))`;
  }
  if (op === IrOp.Div) {
    ctx.useHelper('$div');
    ctx.useHelper('$num');
    const div = `$div((${x.expr}), (${y.expr}))`;
    return type.kind === TypeKind.Int
      ? `$num(Math.trunc(${div}))`
      : `$num(${div})`;
  }
  if (op === IrOp.Mod) {
    ctx.useHelper('$mod');
    ctx.useHelper('$num');
    return `$num($mod((${x.expr}), (${y.expr})))`;
  }
  const js = BINARY_JS[op];
  if (js === undefined) {
    return fatal(`unmapped binary operation ${op}`);
  }
  const expr = `((${x.expr}) ${js} (${y.expr}))`;
  if (op === IrOp.Add || op === IrOp.Sub || op === IrOp.Mul) {
    ctx.useHelper('$num');
    return `$num(${expr})`;
  }
  return expr;
}

// Lower an operand; if it needed statements, earlier operands must already
// be temps — callers use this for every multi-operand node.
function subexpr(
  e: IrExpr,
  out: string[],
  ctx: LowerCtx,
): {expr: string; pure: boolean} {
  const before = out.length;
  const expr = lowerExpr(e, out, ctx);
  return {expr, pure: out.length === before};
}

// ---- natives ----------------------------------------------------------------

type NativeRule = (args: string[], ctx: LowerCtx) => string;

const NATIVE_RULES: Record<string, NativeRule> = {
  'math.abs': a => `Math.abs(${a[0]})`,
  'math.sign': a => `Math.sign(${a[0]})`,
  'math.floor': a => `Math.floor(${a[0]})`,
  'math.ceil': a => `Math.ceil(${a[0]})`,
  'math.sqrt': a => `Math.sqrt(${a[0]})`,
  'math.pow': a => `Math.pow(${a[0]}, ${a[1]})`,
  'math.log': a => `Math.log(${a[0]})`,
  'math.log10': a => `Math.log10(${a[0]})`,
  'math.exp': a => `Math.exp(${a[0]})`,
  'math.max': a => `Math.max(${a.join(', ')})`,
  'math.min': a => `Math.min(${a.join(', ')})`,
  'math.avg': a => `((${a.join(' + ')}) / ${a.length})`,
  'math.round': (a, ctx) => {
    if (a.length === 1) {
      return `Math.round(${a[0]})`;
    }
    ctx.useHelper('$round2');
    return `$round2(${a[0]}, ${a[1]})`;
  },
  int: a => `Math.trunc(${a[0]})`,
  float: a => `(${a[0]})`,
  'color.new': (a, ctx) => {
    ctx.useHelper('$colorNew');
    return `$colorNew(${a[0]}, ${a[1]})`;
  },
  'color.rgb': (a, ctx) => {
    ctx.useHelper('$colorRgb');
    return `$colorRgb(${a[0]}, ${a[1]}, ${a[2]}, ${a.length > 3 ? a[3] : 'null'})`;
  },
};

function lowerNative(
  native: string,
  argExprs: readonly IrExpr[],
  out: string[],
  ctx: LowerCtx,
): string {
  // Internal depth-pass primitive: each component is normalized before a
  // synthesized maximum so one invalid offset cannot erase valid demands.
  if (native === '$historyDepth') {
    const x = subexpr(argExprs[0], out, ctx).expr;
    return `rt.historyDepth((${x}))`;
  }
  // na/nz inspect their argument's type for the na representation.
  if (native === 'na') {
    const arg = argExprs[0];
    if (arg.type.kind === TypeKind.Na) {
      return 'true';
    }
    const x = lowerExpr(arg, out, ctx);
    switch (valueClassOf(arg.type)) {
      case ValueClass.Numeric:
        return `Number.isNaN((${x}))`;
      case ValueClass.Reference:
        return `((${x}) === null)`;
      case ValueClass.Boolean:
        ctx.useHelper('$naBool');
        return `$naBool((${x}))`;
    }
  }
  if (native === 'nz') {
    const arg = argExprs[0];
    const valueClass = valueClassOf(arg.type);
    if (valueClass === ValueClass.Boolean) {
      return fatal('bool nz reached lowering');
    }
    const helper = valueClass === ValueClass.Numeric ? '$nzNum' : '$nzRef';
    ctx.useHelper(helper);
    const x = subexpr(arg, out, ctx).expr;
    let replacement: string;
    if (argExprs.length > 1) {
      replacement = subexpr(argExprs[1], out, ctx).expr;
    } else if (valueClass === ValueClass.Numeric) {
      replacement = '0';
    } else if (arg.type.kind === TypeKind.Color) {
      replacement = JSON.stringify('#00000000');
    } else if (arg.type.kind === TypeKind.String) {
      replacement = JSON.stringify('');
    } else {
      return fatal(`nz has no default for ${arg.type.kind}`);
    }
    return `${helper}((${x}), (${replacement}))`;
  }
  if (native === 'str.tostring') {
    const arg = argExprs[0];
    if (arg.type.kind === TypeKind.Na) {
      return JSON.stringify('NaN');
    }
    if (arg.type.kind === TypeKind.Enum) {
      ctx.useHelper('$enumToString');
      const x = subexpr(arg, out, ctx).expr;
      const members = arg.type.members.map(member => [
        member.name,
        member.title,
      ]);
      return `$enumToString((${x}), ${JSON.stringify(members)})`;
    }
    ctx.useHelper('$toString');
    const x = subexpr(arg, out, ctx).expr;
    return `$toString((${x}))`;
  }
  const rule = NATIVE_RULES[native];
  if (rule === undefined) {
    return unimplemented(`codegen: native '${native}'`);
  }
  const args = argExprs.map(a => `(${subexpr(a, out, ctx).expr})`);
  const expr = rule(args, ctx);
  if (native === 'color.new' || native === 'color.rgb') {
    return expr;
  }
  ctx.useHelper('$num');
  return `$num(${expr})`;
}

// ---- statements -------------------------------------------------------------

export function lowerStmts(
  stmts: readonly IrStmt[],
  out: string[],
  ctx: LowerCtx,
): void {
  for (const stmt of stmts) {
    lowerStmt(stmt, out, ctx);
  }
}

function lowerStmt(stmt: IrStmt, out: string[], ctx: LowerCtx): void {
  switch (stmt.kind) {
    case IrKind.ExprStmt: {
      const x = lowerExpr(stmt.x, out, ctx);
      out.push(`void (${x});`);
      return;
    }
    case IrKind.WriteName: {
      const v = lowerExpr(stmt.value, out, ctx);
      out.push(
        `rt.write(${frameRef(ctx, stmt.name)}, ${slotOf(ctx, stmt.name)}, (${v}));`,
      );
      return;
    }
    case IrKind.WriteField:
      return unimplemented('codegen: UDT execution');
    case IrKind.Emit: {
      const oid = ctx.outputIds.get(stmt.output);
      if (oid === undefined) {
        return fatal('lowering reached an unmapped output');
      }
      stmt.args.forEach((arg, channel) => {
        const v = lowerExpr(arg, out, ctx);
        out.push(`rt.emit(${oid}, ${channel}, (${v}));`);
      });
      return;
    }
    case IrKind.Break:
      out.push('break;');
      return;
    case IrKind.Continue:
      out.push('continue;');
      return;
    default:
      return fatal('unhandled IR statement in lowering');
  }
}

// A block used for its statements and optional value.
function lowerBlockInto(
  block: IrExpr,
  out: string[],
  ctx: LowerCtx,
): string | null {
  if (block.kind !== IrKind.BlockExpr) {
    return lowerExpr(block, out, ctx);
  }
  lowerStmts(block.stmts, out, ctx);
  return block.value !== null ? lowerExpr(block.value, out, ctx) : null;
}

export function indent(lines: readonly string[]): string[] {
  return lines.map(line => `  ${line}`);
}
