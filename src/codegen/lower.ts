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
  type IrValuePath,
  type Name,
} from '../ir/node';
import type {
  EffectDecl,
  IrFunc,
  ExecutionInput,
  OutputDecl,
  ParamInput,
  RequestEdge,
  SeriesInput,
} from '../ir/program';
import {
  assignable,
  isNaValue,
  TypeKind,
  typesEqual,
  type Type,
} from '../ir/type';
import {ValueClass, type ValueClass as ValueClassType} from '../runtime/value';

// Everything the walk needs to address program objects as dense ids. The
// driver (codegen.ts) builds it; call sites discovered during lowering are
// reported back through noteCallSite.
export interface LowerCtx {
  readonly nameSlots: Map<Name, {fid: number; slot: number}>;
  readonly seriesIds: Map<SeriesInput, number>;
  readonly executionIds: Map<ExecutionInput, number>;
  readonly paramIds: Map<ParamInput, number>;
  // input.source params read as series through their bound slot.
  readonly paramSeriesIds: Map<ParamInput, number>;
  readonly outputIds: Map<OutputDecl, number>;
  readonly effectIds: Map<EffectDecl, number>;
  readonly funcIds: Map<IrFunc, number>;
  readonly requestIds: Map<RequestEdge, number>;
  // Dynamic edges (series context args): the offset-0 read evaluates the
  // args inline and calls rt.requestFor; history reads stay rt.request.
  readonly dynamicRequests: ReadonlySet<RequestEdge>;
  // The generated const this module's own code refers to itself by ('M'
  // for the root, 'M1'… for request children) — funcs-table dispatch must
  // name the module that owns the func.
  readonly moduleRef: string;
  // Root ModuleEmitter-owned projection. Request children share the same
  // layout namespace; no semantic Type is ever mutated with a backend id.
  layoutOf(type: Type): number;
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
  $rangeNext:
    '(x, step) => { const next = Number.isFinite(x + step) ? x + step : NaN; return (step > 0 && next > x) || (step < 0 && next < x) ? next : NaN; }',
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
    case TypeKind.UserType:
    case TypeKind.Enum:
    case TypeKind.Tuple:
      return ValueClass.Nullable;
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
    case ValueClass.Nullable:
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
  return valueClass === ValueClass.Nullable ? 'null' : 'NaN';
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

function readRoot(ctx: LowerCtx, path: IrValuePath): string {
  return `rt.read(${frameRef(ctx, path.root)}, ${slotOf(ctx, path.root)}, 0)`;
}

// Program paths contain canonical field indices, but codegen is also the
// final static boundary before those indices become an untyped JS array.
// Fail malformed hand-built Programs here instead of deferring the fault to
// a row-time runtime rebuild.
function valuePathType(path: IrValuePath): Type {
  let type = path.root.type;
  for (const index of path.fieldIndices) {
    if (type.kind !== TypeKind.UserType) {
      return fatal(`field path traverses non-user type ${type.kind}`);
    }
    const field = type.fields[index];
    if (field === undefined) {
      return fatal(
        `field path index ${index} is out of range for ${type.name}`,
      );
    }
    type = field.type;
  }
  return type;
}

function requirePathType(
  path: IrValuePath,
  expected: Type,
  operation: string,
): void {
  const actual = valuePathType(path);
  if (!typesEqual(actual, expected)) {
    fatal(
      `${operation} receiver type ${expected.kind} disagrees with path type ${actual.kind}`,
    );
  }
}

function writePath(
  ctx: LowerCtx,
  path: IrValuePath,
  replacement: string,
): string {
  valuePathType(path);
  const root = readRoot(ctx, path);
  const rebuilt = `rt.rebuildUserPath((${root}), ${ctx.layoutOf(path.root.type)}, ${JSON.stringify(path.fieldIndices)}, (${replacement}))`;
  return `rt.write(${frameRef(ctx, path.root)}, ${slotOf(ctx, path.root)}, ${rebuilt});`;
}

// Evaluate now, not merely when a later generated expression happens to use
// the returned string. Aggregate constructors, tuples, and every call use
// this to preserve source left-to-right value copies around statement-shaped
// later arguments.
function capture(e: IrExpr, out: string[], ctx: LowerCtx): string {
  const expr = lowerExpr(e, out, ctx);
  const temp = ctx.fresh();
  out.push(`const ${temp} = (${expr});`);
  return temp;
}

export function captureArguments(
  args: readonly IrExpr[],
  argumentEvaluationOrder: readonly number[],
  out: string[],
  ctx: LowerCtx,
  operation: string,
): string[] {
  if (argumentEvaluationOrder.length !== args.length) {
    return fatal(`${operation} has an incomplete argument evaluation order`);
  }
  const captured: string[] = [];
  const seen = new Set<number>();
  for (const index of argumentEvaluationOrder) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= args.length ||
      seen.has(index)
    ) {
      return fatal(`${operation} has an invalid argument evaluation order`);
    }
    seen.add(index);
    captured[index] = capture(args[index], out, ctx);
  }
  return captured;
}

function validateWritePath(
  path: IrValuePath,
  out: string[],
  ctx: LowerCtx,
): void {
  if (path.fieldIndices.length === 0) {
    return;
  }
  const root = ctx.fresh();
  out.push(`const ${root} = (${readRoot(ctx, path)});`);
  let value = root;
  let type = path.root.type;
  for (const index of path.fieldIndices) {
    if (type.kind !== TypeKind.UserType) {
      return fatal(`field path traverses non-user type ${type.kind}`);
    }
    const field = type.fields[index];
    if (field === undefined) {
      return fatal(
        `field path index ${index} is out of range for ${type.name}`,
      );
    }
    const next = ctx.fresh();
    out.push(
      `const ${next} = rt.userField((${value}), ${ctx.layoutOf(type)}, ${index});`,
    );
    value = next;
    type = field.type;
  }
  // Reads through a na user value intentionally yield typed empty. Rebuilding
  // the unchanged leaf is the side-effect-free writeability/layout check.
  out.push(
    `void (rt.rebuildUserPath((${root}), ${ctx.layoutOf(path.root.type)}, ${JSON.stringify(path.fieldIndices)}, (${value})));`,
  );
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
      const off = e.offset === null ? '0' : capture(e.offset, out, ctx);
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
        case PlaceKind.Execution: {
          const eid = ctx.executionIds.get(e.place.execution);
          if (eid === undefined) {
            return fatal(
              `unmapped execution input '${e.place.execution.source.domain}.${e.place.execution.source.field}'`,
            );
          }
          return `rt.execution(${eid}, ${off})`;
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
            const [symbol, timeframe] = captureArguments(
              [edge.symbol, edge.timeframe],
              edge.contextArgumentEvaluationOrder,
              out,
              ctx,
              'request context',
            );
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
      const c = capture(e.cond, out, ctx);
      const t = capture(e.then, out, ctx);
      const f = capture(e.else, out, ctx);
      return `((${c}) ? (${t}) : (${f}))`;
    }
    case IrKind.CallFunc: {
      const fid = ctx.funcIds.get(e.func);
      if (fid === undefined) {
        return fatal(`unmapped function '${e.func.name}'`);
      }
      ctx.noteCallSite(ctx.currentFid, e.slot, e.func);
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `function call '${e.func.name}'`,
      );
      return `${ctx.moduleRef}.funcs[${fid}](rt, rt.frame(fr, ${e.slot})${args.map(arg => `, ${arg}`).join('')})`;
    }
    case IrKind.CallConstMethod: {
      if (!typesEqual(e.func.receiver.type, e.receiver.type)) {
        return fatal(
          `const method call '${e.func.name}' receiver has the wrong type`,
        );
      }
      if (e.args.length !== e.func.params.length) {
        return fatal(
          `const method call '${e.func.name}' has the wrong argument count`,
        );
      }
      if (!typesEqual(e.type, e.func.resultType)) {
        return fatal(
          `const method call '${e.func.name}' has the wrong result type`,
        );
      }
      const fid = ctx.funcIds.get(e.func);
      if (fid === undefined) {
        return fatal(`unmapped const method '${e.func.name}'`);
      }
      ctx.noteCallSite(ctx.currentFid, e.slot, e.func);
      const receiver = capture(e.receiver, out, ctx);
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `const method call '${e.func.name}'`,
      );
      return `${ctx.moduleRef}.funcs[${fid}](rt, rt.frame(fr, ${e.slot}), ${receiver}${args.map(arg => `, ${arg}`).join('')})`;
    }
    case IrKind.CallMutableMethod: {
      requirePathType(e.path, e.receiver.type, 'mutable method');
      if (!typesEqual(e.func.receiver.type, e.receiver.type)) {
        return fatal(
          `mutable method call '${e.func.name}' receiver has the wrong type`,
        );
      }
      if (e.args.length !== e.func.params.length) {
        return fatal(
          `mutable method call '${e.func.name}' has the wrong argument count`,
        );
      }
      if (!typesEqual(e.type, e.func.resultType)) {
        return fatal(
          `mutable method call '${e.func.name}' has the wrong result type`,
        );
      }
      const fid = ctx.funcIds.get(e.func);
      if (fid === undefined) {
        return fatal(`unmapped mutable method '${e.func.name}'`);
      }
      ctx.noteCallSite(ctx.currentFid, e.slot, e.func);
      const receiver = capture(e.receiver, out, ctx);
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `mutable method call '${e.func.name}'`,
      );
      const result = ctx.fresh();
      out.push(
        `const ${result} = ${ctx.moduleRef}.funcs[${fid}](rt, rt.frame(fr, ${e.slot}), ${receiver}${args.map(arg => `, ${arg}`).join('')});`,
        writePath(ctx, e.path, `${result}.receiver`),
      );
      return `${result}.result`;
    }
    case IrKind.CallNative:
      return lowerNative(
        e.native,
        e.args,
        e.argumentEvaluationOrder,
        e.type,
        out,
        ctx,
      );
    case IrKind.MutateCollection: {
      requirePathType(e.path, e.receiver.type, 'collection mutation');
      const collectionKind = e.receiver.type.kind;
      if (
        collectionKind !== TypeKind.Array &&
        collectionKind !== TypeKind.Matrix &&
        collectionKind !== TypeKind.Map
      ) {
        return fatal(
          `collection mutation receiver has non-collection type ${collectionKind}`,
        );
      }
      if (!e.operation.startsWith(`${collectionKind.toLowerCase()}.`)) {
        return fatal(
          `collection mutation '${e.operation}' disagrees with ${collectionKind} receiver`,
        );
      }
      const receiver = capture(e.receiver, out, ctx);
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `collection mutation '${e.operation}'`,
      );
      const result = ctx.fresh();
      out.push(
        `const ${result} = rt.mutateCollection(${JSON.stringify(e.operation)}, ${ctx.layoutOf(e.receiver.type)}, ${receiver}, [${args.join(', ')}]);`,
        writePath(ctx, e.path, `${result}.replacement`),
      );
      return `${result}.result`;
    }
    case IrKind.MakeTuple: {
      const elems = e.elems.map(el => capture(el, out, ctx));
      return `[${elems.map(x => `(${x})`).join(', ')}]`;
    }
    case IrKind.TupleGet: {
      const tuple = capture(e.x, out, ctx);
      return `((${tuple}) === null ? ${emptyLiteral(e.type)} : (${tuple})[${e.index}])`;
    }
    case IrKind.NewUserValue: {
      if (!typesEqual(e.type, e.userType)) {
        return fatal(
          `constructor for '${e.userType.name}' has a different result type`,
        );
      }
      if (e.args.length !== e.userType.fields.length) {
        return fatal(
          `constructor for '${e.userType.name}' has the wrong argument count`,
        );
      }
      e.args.forEach((arg, index) => {
        const field = e.userType.fields[index];
        if (!assignable(arg.type, field.type)) {
          fatal(
            `constructor for '${e.userType.name}' has an invalid argument for field '${field.name}'`,
          );
        }
      });
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `constructor '${e.userType.name}.new'`,
      );
      return `rt.newUser(${ctx.layoutOf(e.userType)}, [${args.join(', ')}])`;
    }
    case IrKind.FieldGet: {
      if (e.x.type.kind !== TypeKind.UserType) {
        return fatal(`field read traverses non-user type ${e.x.type.kind}`);
      }
      const selected = e.x.type.fields[e.fieldIndex];
      if (selected === undefined) {
        return fatal(
          `field index ${e.fieldIndex} is out of range for ${e.x.type.name}`,
        );
      }
      if (!typesEqual(e.type, selected.type)) {
        return fatal(
          `field '${selected.name}' of '${e.x.type.name}' has the wrong result type`,
        );
      }
      const value = lowerExpr(e.x, out, ctx);
      return `rt.userField((${value}), ${ctx.layoutOf(e.x.type)}, ${e.fieldIndex})`;
    }
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
      const matched = ctx.fresh();
      out.push(
        `let ${temp} = ${emptyLiteral(e.type)};`,
        `let ${matched} = false;`,
      );
      const subject = e.subject !== null ? capture(e.subject, out, ctx) : null;
      e.arms.forEach(arm => {
        const armLines: string[] = [];
        const val = lowerBlockInto(arm.body, armLines, ctx);
        if (val !== null) {
          armLines.push(`${temp} = (${val});`);
        }
        if (arm.pattern === null) {
          out.push(
            `if (!(${matched})) {`,
            ...indent([`${matched} = true;`, ...armLines]),
            '}',
          );
          return;
        }
        const patternLines: string[] = [];
        const p = lowerExpr(arm.pattern, patternLines, ctx);
        if (subject !== null) {
          ctx.useHelper('$eq');
        }
        const test = subject !== null ? `$eq((${subject}), (${p}))` : `(${p})`;
        out.push(
          `if (!(${matched})) {`,
          ...indent([
            ...patternLines,
            `if (${test}) {`,
            ...indent([`${matched} = true;`, ...armLines]),
            '}',
          ]),
          '}',
        );
      });
      return temp;
    }
    case IrKind.ForExpr: {
      const temp = ctx.fresh();
      out.push(`let ${temp} = ${emptyLiteral(e.type)};`);
      const fromT = capture(e.from, out, ctx);
      const toT = capture(e.to, out, ctx);
      const stepT = e.step !== null ? capture(e.step, out, ctx) : '1';
      const frRef = frameRef(ctx, e.index);
      const slot = slotOf(ctx, e.index);
      const idx = `rt.read(${frRef}, ${slot}, 0)`;
      const bodyLines: string[] = [];
      const val = lowerBlockInto(e.body, bodyLines, ctx);
      if (val !== null) {
        bodyLines.push(`${temp} = (${val});`);
      }
      ctx.useHelper('$rangeNext');
      out.push(
        `for (rt.write(${frRef}, ${slot}, ${fromT}); (${stepT}) > 0 ? (${idx}) <= (${toT}) : (${stepT}) < 0 ? (${idx}) >= (${toT}) : false; rt.write(${frRef}, ${slot}, $rangeNext((${idx}), (${stepT})))) {`,
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
    case IrKind.ForInExpr: {
      const result = ctx.fresh();
      const collection = capture(e.x, out, ctx);
      const entries = ctx.fresh();
      const index = ctx.fresh();
      out.push(
        `let ${result} = ${emptyLiteral(e.type)};`,
        `const ${entries} = rt.collectionEntries(${collection});`,
      );
      const body: string[] = [];
      if (e.x.type.kind === TypeKind.Array) {
        if (e.targets.length === 1) {
          body.push(
            `rt.write(${frameRef(ctx, e.targets[0])}, ${slotOf(ctx, e.targets[0])}, ${entries}[${index}]);`,
          );
        } else if (e.targets.length === 2) {
          body.push(
            `rt.write(${frameRef(ctx, e.targets[0])}, ${slotOf(ctx, e.targets[0])}, ${index});`,
            `rt.write(${frameRef(ctx, e.targets[1])}, ${slotOf(ctx, e.targets[1])}, ${entries}[${index}]);`,
          );
        } else {
          return fatal('array iteration requires one or two targets');
        }
      } else if (e.x.type.kind === TypeKind.Map) {
        if (e.targets.length !== 2) {
          return fatal('map iteration requires key and value targets');
        }
        body.push(
          `rt.write(${frameRef(ctx, e.targets[0])}, ${slotOf(ctx, e.targets[0])}, ${entries}[${index}][0]);`,
          `rt.write(${frameRef(ctx, e.targets[1])}, ${slotOf(ctx, e.targets[1])}, ${entries}[${index}][1]);`,
        );
      } else {
        return fatal(`unsupported collection iteration over ${e.x.type.kind}`);
      }
      const value = lowerBlockInto(e.body, body, ctx);
      if (value !== null) {
        body.push(`${result} = (${value});`);
      }
      out.push(
        `for (let ${index} = 0; ${index} < ${entries}.length; ${index} += 1) {`,
        ...indent(body),
        '}',
      );
      return result;
    }
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

  const x = capture(xe, out, ctx);
  const y = capture(ye, out, ctx);
  if (op === IrOp.Eq || op === IrOp.Ne) {
    const helper = op === IrOp.Eq ? '$eq' : '$ne';
    ctx.useHelper(helper);
    return `${helper}((${x}), (${y}))`;
  }
  if (op === IrOp.Add && type.kind === TypeKind.String) {
    ctx.useHelper('$concat');
    return `$concat((${x}), (${y}))`;
  }
  if (op === IrOp.Div) {
    ctx.useHelper('$div');
    ctx.useHelper('$num');
    const div = `$div((${x}), (${y}))`;
    return type.kind === TypeKind.Int
      ? `$num(Math.trunc(${div}))`
      : `$num(${div})`;
  }
  if (op === IrOp.Mod) {
    ctx.useHelper('$mod');
    ctx.useHelper('$num');
    return `$num($mod((${x}), (${y})))`;
  }
  const js = BINARY_JS[op];
  if (js === undefined) {
    return fatal(`unmapped binary operation ${op}`);
  }
  const expr = `((${x}) ${js} (${y}))`;
  if (op === IrOp.Add || op === IrOp.Sub || op === IrOp.Mul) {
    ctx.useHelper('$num');
    return `$num(${expr})`;
  }
  return expr;
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
  argumentEvaluationOrder: readonly number[],
  resultType: Type,
  out: string[],
  ctx: LowerCtx,
): string {
  const args = captureArguments(
    argExprs,
    argumentEvaluationOrder,
    out,
    ctx,
    `native call '${native}'`,
  );
  // Internal depth-pass primitive: each component is normalized before a
  // synthesized maximum so one invalid offset cannot erase valid demands.
  if (native === '$historyDepth') {
    return `rt.historyDepth((${args[0]}))`;
  }
  if (
    native.startsWith('array.') ||
    native.startsWith('matrix.') ||
    native.startsWith('map.')
  ) {
    return `rt.callCollection(${JSON.stringify(native)}, ${ctx.layoutOf(resultType)}, [${args.join(', ')}])`;
  }
  // na/nz inspect their argument's type for the na representation.
  if (native === 'na') {
    const arg = argExprs[0];
    if (arg.type.kind === TypeKind.Na) {
      return 'true';
    }
    const x = args[0];
    switch (valueClassOf(arg.type)) {
      case ValueClass.Numeric:
        return `Number.isNaN((${x}))`;
      case ValueClass.Nullable:
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
    const x = args[0];
    let replacement: string;
    if (argExprs.length > 1) {
      replacement = args[1];
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
      const x = args[0];
      const members = arg.type.members.map(member => [
        member.name,
        member.title,
      ]);
      return `$enumToString((${x}), ${JSON.stringify(members)})`;
    }
    ctx.useHelper('$toString');
    const x = args[0];
    return `$toString((${x}))`;
  }
  const rule = NATIVE_RULES[native];
  if (rule === undefined) {
    return unimplemented(`codegen: native '${native}'`);
  }
  const expr = rule(
    args.map(arg => `(${arg})`),
    ctx,
  );
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
    case IrKind.InitName: {
      const frame = frameRef(ctx, stmt.name);
      const slot = slotOf(ctx, stmt.name);
      const body: string[] = [];
      const value = lowerExpr(stmt.value, body, ctx);
      out.push(`if (rt.needsInit(${frame}, ${slot})) {`);
      out.push(...indent(body));
      out.push(`  rt.initialize(${frame}, ${slot}, (${value}));`);
      out.push('}');
      return;
    }
    case IrKind.WriteName: {
      const v = lowerExpr(stmt.value, out, ctx);
      out.push(
        `rt.write(${frameRef(ctx, stmt.name)}, ${slotOf(ctx, stmt.name)}, (${v}));`,
      );
      return;
    }
    case IrKind.UpdateValuePath: {
      const targetType = valuePathType(stmt.path);
      if (!assignable(stmt.value.type, targetType)) {
        return fatal(
          `rooted update value type ${stmt.value.type.kind} is not assignable to ${targetType.kind}`,
        );
      }
      validateWritePath(stmt.path, out, ctx);
      const value = lowerExpr(stmt.value, out, ctx);
      out.push(writePath(ctx, stmt.path, value));
      return;
    }
    case IrKind.Emit: {
      const oid = ctx.outputIds.get(stmt.output);
      if (oid === undefined) {
        return fatal('lowering reached an unmapped output');
      }
      const args = captureArguments(
        stmt.args,
        stmt.argumentEvaluationOrder,
        out,
        ctx,
        `output '${stmt.output.effect}'`,
      );
      args.forEach((arg, channel) => {
        out.push(`rt.emit(${oid}, ${channel}, (${arg}));`);
      });
      return;
    }
    case IrKind.EmitEffect: {
      const effectId = ctx.effectIds.get(stmt.effect);
      if (effectId === undefined) {
        return fatal('lowering reached an unmapped effect');
      }
      const payload = lowerExpr(stmt.payload, out, ctx);
      out.push(`rt.emitEffect(${effectId}, (${payload}));`);
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
