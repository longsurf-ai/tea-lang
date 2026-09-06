// Purpose: Lower Tea expressions and statements to typed values and named runtime state.

import {fatal} from '../base/print';
import type {FrameTopology} from '../ir/frames';
import {unimplemented} from '../base/unimplemented';
import {
  IrKind,
  IrOp,
  PlaceKind,
  type WritableExpr,
  type IrBinaryOp,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../ir/node';
import type {
  IrFunc,
  BuiltinInput,
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

// Compiler bookkeeping for addressing Program objects as dense IDs. The
// driver builds it from the existing frame topology; noteCallSite verifies
// that emitted calls agree with it rather than discovering another topology.
export interface LowerCtx {
  readonly nameLocations: FrameTopology['nameLocations'];
  // Parameters without history remain ordinary captured-value locals.
  readonly directNames: ReadonlyMap<Name, string>;
  readonly seriesIds: Map<SeriesInput, number>;
  readonly builtinIds: Map<BuiltinInput, number>;
  readonly paramIds: Map<ParamInput, number>;
  // input.source params read as series through their bound slot.
  readonly paramSeriesIds: Map<ParamInput, number>;
  readonly outputIds: Map<OutputDecl, number>;
  readonly funcIds: Map<IrFunc, number>;
  readonly requestIds: Map<RequestEdge, number>;
  // Binding reads fixed parameter/context values without execution state.
  readonly binding?: boolean;
  readonly bindFuncRefs?: ReadonlyMap<IrFunc, string>;
  // Root ModuleEmitter-owned projection. Request children share the same
  // layout namespace; no semantic Type is ever mutated with a backend id.
  layoutOf(type: Type): number;
  // Which typed frame owns the currently lowered function.
  currentFid: number;
  readonly currentResultType?: Type;
  noteCallSite(fid: number, slot: number, callee: IrFunc): void;
  typeOf(type: Type): string;
  valueOf(type: Type, raw: string): string;
  emptyOf(type: Type): string;
  factoryOf(type: Type): string;
  localKey(name: Name): string;
  callKey(frame: number, slot: number): string;
  functionRef(func: IrFunc): string;
  seriesKey(series: SeriesInput | ParamInput): string;
  fresh(): string;
}

export function property(owner: string, name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `${owner}.${name}`
    : `${owner}[${JSON.stringify(name)}]`;
}

export function coerce(value: string, from: Type, to: Type): string {
  return from.kind === TypeKind.Int && to.kind === TypeKind.Float
    ? `float((${value}).value)`
    : value;
}

// The frame handle expression for a name: the current frame, or the program
// frame — the one legal cross-frame access (functions read globals through
// ctx.state, never another function's frame).
function frameRef(ctx: LowerCtx, name: Name): string {
  const entry = ctx.nameLocations.get(name);
  if (entry === undefined) {
    return fatal(`lowering reached an unmapped name '${name.name}'`);
  }
  if (entry.frameId === ctx.currentFid) {
    return ctx.currentFid === 0 ? 'ctx.state' : 'frame';
  }
  if (ctx.binding === true) {
    return fatal(`module binding reached stateful name '${name.name}'`);
  }
  if (entry.frameId === 0) {
    return 'ctx.state';
  }
  return fatal(
    `name '${name.name}' of frame ${entry.frameId} referenced from frame ${ctx.currentFid}`,
  );
}

function localRef(ctx: LowerCtx, name: Name): string {
  return property(`${frameRef(ctx, name)}.locals`, ctx.localKey(name));
}

function directName(ctx: LowerCtx, name: Name): string | undefined {
  return ctx.directNames.get(name);
}

function readName(
  ctx: LowerCtx,
  name: Name,
  offset: string,
  current: boolean,
): string {
  const direct = directName(ctx, name);
  if (direct !== undefined && current) {
    return direct;
  }
  if (ctx.binding === true) {
    return fatal(`module binding requires history for '${name.name}'`);
  }
  return `${localRef(ctx, name)}.hist(${offset})`;
}

function writeNameExpr(ctx: LowerCtx, name: Name, value: string): string {
  const direct = directName(ctx, name);
  if (ctx.binding === true && direct === undefined) {
    return fatal(`module binding reached stateful name '${name.name}'`);
  }
  return direct !== undefined
    ? `${direct} = (${value})`
    : `${localRef(ctx, name)}.set(${value})`;
}

function structFieldType(
  owner: Extract<Type, {kind: typeof TypeKind.Struct}>,
  fieldIndex: number,
): Type {
  const field = owner.fields[fieldIndex];
  return (
    field?.type ??
    fatal(`field index ${fieldIndex} is out of range for ${owner.name}`)
  );
}

interface CapturedDestination {
  readonly read: string;
  store(replacement: string): string;
}

// Capture the destination, not its value. Compound assignments and writable
// calls capture read separately, before their later operand effects.
function captureDestination(
  location: WritableExpr,
  out: string[],
  ctx: LowerCtx,
): CapturedDestination {
  if (location.kind === IrKind.Read) {
    if (location.place.kind !== PlaceKind.Name)
      return fatal('assignment destination is not writable');
    const name = location.place.name;
    return {
      read: readName(ctx, name, '0', true),
      store: replacement => `${writeNameExpr(ctx, name, replacement)};`,
    };
  }
  if (ctx.binding === true)
    return fatal('module binding cannot store a struct field');
  const owner = location.x.type;
  if (owner.kind !== TypeKind.Struct)
    return fatal('field destination has a non-struct receiver');
  if (!typesEqual(structFieldType(owner, location.fieldIndex), location.type))
    return fatal('field destination has the wrong type');
  const object = capture(location.x, out, ctx);
  const target = ctx.fresh();
  const field = owner.fields[location.fieldIndex].name;
  out.push(
    `const ${target} = (${object}).require().field(${JSON.stringify(field)});`,
  );
  return {
    read: `${target}.get()`,
    store: replacement => `${target}.set(${replacement});`,
  };
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

// ---- expressions ------------------------------------------------------------

// Lowers `e` to a JS expression string; statement-shaped constructs emit
// into `out` and return a temp. Left-to-right evaluation order is preserved
// by materializing earlier operands into temps whenever a later operand
// needs statements.
export function lowerExpr(e: IrExpr, out: string[], ctx: LowerCtx): string {
  if (e.type.kind === TypeKind.Na)
    return fatal('uncontextualized na type reached lowering');
  switch (e.kind) {
    case IrKind.Const: {
      const v = e.value;
      if (isNaValue(v)) {
        return ctx.emptyOf(e.type);
      }
      if (typeof v === 'number') {
        return Number.isFinite(v)
          ? ctx.valueOf(e.type, String(v))
          : fatal('non-finite constant reached lowering');
      }
      if (typeof v === 'boolean') {
        return ctx.valueOf(e.type, String(v));
      }
      return ctx.valueOf(e.type, JSON.stringify(v));
    }
    case IrKind.Read:
    case IrKind.HistRead: {
      const off =
        e.kind === IrKind.Read ? '0' : `(${capture(e.offset, out, ctx)}).value`;
      switch (e.place.kind) {
        case PlaceKind.Name: {
          const current =
            e.kind === IrKind.Read ||
            (e.offset.kind === IrKind.Const &&
              typeof e.offset.value === 'number' &&
              e.offset.value === 0);
          return readName(ctx, e.place.name, off, current);
        }
        case PlaceKind.Series: {
          if (ctx.binding === true) {
            return fatal('module binding cannot read a source series');
          }
          const sid = ctx.seriesIds.get(e.place.series);
          if (sid === undefined) {
            return fatal(`unmapped series '${e.place.series.id}'`);
          }
          return `${property('ctx.inputs.series', ctx.seriesKey(e.place.series))}.hist(${off})`;
        }
        case PlaceKind.Builtin: {
          const bid = ctx.builtinIds.get(e.place.builtin);
          if (bid === undefined) {
            return fatal(
              `unmapped builtin '${e.place.builtin.source.domain}.${e.place.builtin.source.field}'`,
            );
          }
          if (ctx.binding === true) {
            if (e.kind === IrKind.HistRead) {
              return fatal('module binding cannot read builtin history');
            }
            const name = `${e.place.builtin.source.domain}.${e.place.builtin.source.field}`;
            return ctx.valueOf(
              e.type,
              `contextValue(contextConstants, ${bid}, ${JSON.stringify(name)}) as ${scalarType(e.type)}`,
            );
          }
          return `${property('ctx.inputs.builtins', `${e.place.builtin.source.domain}.${e.place.builtin.source.field}`)}.hist(${off})`;
        }
        case PlaceKind.Param: {
          const sid = ctx.paramSeriesIds.get(e.place.param);
          if (sid !== undefined) {
            if (ctx.binding === true) {
              return fatal(
                `module binding cannot read source parameter '${e.place.param.name}'`,
              );
            }
            return `${property('ctx.inputs.series', ctx.seriesKey(e.place.param))}.hist(${off})`;
          }
          const pid = ctx.paramIds.get(e.place.param);
          if (pid === undefined) {
            return fatal(`unmapped param '${e.place.param.name}'`);
          }
          if (ctx.binding === true) {
            return ctx.valueOf(
              e.type,
              `module.parameters[${pid}].value as ${scalarType(e.type)}`,
            );
          }
          // Scalar params are constant over rows; history is the value.
          return property('ctx.params', e.place.param.name);
        }
        case PlaceKind.Request: {
          if (ctx.binding === true) {
            return fatal('module binding cannot read a request result');
          }
          const edge = e.place.request;
          const rid = ctx.requestIds.get(edge);
          if (rid === undefined) {
            return fatal('lowering reached an unmapped request edge');
          }
          return `${property('ctx.inputs.children', edge.name)}.hist(${off})`;
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
        return `(${x}).not()`;
      }
      return `(${x}).neg()`;
    }
    case IrKind.CallFunc: {
      const fid = ctx.funcIds.get(e.func);
      if (fid === undefined) {
        return fatal(`unmapped function '${e.func.name}'`);
      }
      if (e.args.length !== e.func.params.length)
        return fatal(`function '${e.func.name}' has the wrong argument count`);
      if (!typesEqual(e.type, e.func.resultType))
        return fatal(`function '${e.func.name}' has the wrong result type`);
      let receiver: string | null = null;
      if (e.func.callMode === 'free') {
        if (e.receiver !== null)
          return fatal(`free function '${e.func.name}' has a receiver`);
      } else {
        if (
          e.receiver === null ||
          !typesEqual(e.func.receiver.type, e.receiver.type)
        )
          return fatal(`method '${e.func.name}' receiver has the wrong type`);
        receiver = capture(e.receiver, out, ctx);
        if (e.func.callMode === 'mutable-method') {
          if (ctx.binding === true)
            return fatal(
              `module binding cannot call mutable method '${e.func.name}'`,
            );
          const validated = ctx.fresh();
          out.push(`const ${validated} = (${receiver}).require();`);
          receiver = validated;
        }
      }
      ctx.noteCallSite(ctx.currentFid, e.slot, e.func);
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `function call '${e.func.name}'`,
      );
      const operands = args.map((arg, i) =>
        coerce(arg, e.args[i].type, e.func.params[i].type),
      );
      if (receiver !== null) operands.unshift(receiver);
      const bindRef = ctx.bindFuncRefs?.get(e.func);
      if (ctx.binding === true) {
        if (bindRef === undefined) {
          return fatal(
            `module binding reached unavailable function '${e.func.name}'`,
          );
        }
        return `${bindRef}(${operands.join(', ')})`;
      }
      return `${ctx.functionRef(e.func)}(ctx, ${property(`${ctx.currentFid === 0 ? 'ctx.state' : 'frame'}.calls`, ctx.callKey(ctx.currentFid, e.slot))}${operands.map(arg => `, ${arg}`).join('')})`;
    }
    case IrKind.CallNative: {
      if (
        e.args.length !== e.native.argTypes.length ||
        !typesEqual(e.type, e.native.resultType)
      )
        return fatal(
          `native '${e.native.name}' disagrees with its concrete signature`,
        );
      if (
        ctx.binding === true &&
        (e.receiver !== null || e.native.effect !== 'pure')
      )
        return fatal(
          `module binding cannot execute ${e.native.effect} native '${e.native.name}'`,
        );
      if (
        e.args.some(
          (arg, index) => !assignable(arg.type, e.native.argTypes[index]),
        )
      )
        return fatal(
          `native '${e.native.name}' has an incompatible argument type`,
        );
      if (e.receiver === null)
        return lowerNative(
          e.native.name,
          e.native.argTypes,
          e.args,
          e.argumentEvaluationOrder,
          e.type,
          out,
          ctx,
        );
      if (e.native.effect !== 'write')
        return fatal(
          `writable receiver on non-writing native '${e.native.name}'`,
        );
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
      if (!e.native.name.startsWith(`${collectionKind.toLowerCase()}.`)) {
        return fatal(
          `collection mutation '${e.native.name}' disagrees with ${collectionKind} receiver`,
        );
      }
      const location = captureDestination(e.receiver, out, ctx);
      const receiver = ctx.fresh();
      out.push(`const ${receiver} = ${location.read};`);
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `native call '${e.native.name}'`,
      );
      const method = e.native.name.split('.')[1];
      const values = args.map((arg, index) =>
        coerce(arg, e.args[index].type, e.native.argTypes[index]),
      );
      const result = ctx.fresh();
      out.push(
        `const ${result} = ${receiver}.${method}(${values.join(', ')});`,
        location.store(`${result}.replacement`),
      );
      return `${result}.result`;
    }
    case IrKind.MakeTuple: {
      if (ctx.binding === true) {
        return fatal('module binding cannot allocate a tuple');
      }
      const elems = e.elems.map(el => capture(el, out, ctx));
      return `${ctx.factoryOf(e.type)}.create(ctx, [${elems.join(', ')}])`;
    }
    case IrKind.TupleGet: {
      if (ctx.binding === true) {
        return fatal('module binding cannot read a tuple');
      }
      const tuple = capture(e.x, out, ctx);
      return `${tuple}.get(${e.index})`;
    }
    case IrKind.NewStruct: {
      if (ctx.binding === true) {
        return fatal(
          `module binding cannot allocate struct '${e.structType.name}'`,
        );
      }
      if (!typesEqual(e.type, e.structType)) {
        return fatal(
          `constructor for '${e.structType.name}' has a different result type`,
        );
      }
      if (e.args.length !== e.structType.fields.length) {
        return fatal(
          `constructor for '${e.structType.name}' has the wrong argument count`,
        );
      }
      e.args.forEach((arg, index) => {
        const field = e.structType.fields[index];
        if (!assignable(arg.type, field.type)) {
          fatal(
            `constructor for '${e.structType.name}' has an invalid argument for field '${field.name}'`,
          );
        }
      });
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `constructor '${e.structType.name}.new'`,
      );
      return `${ctx.factoryOf(e.structType)}.create(ctx, {${args.map((arg, i) => `${JSON.stringify(e.structType.fields[i].name)}: ${coerce(arg, e.args[i].type, e.structType.fields[i].type)}`).join(', ')}})`;
    }
    case IrKind.FieldGet: {
      if (ctx.binding === true) {
        return fatal('module binding cannot read a struct field');
      }
      if (e.x.type.kind !== TypeKind.Struct) {
        return fatal(`field read traverses non-struct ${e.x.type.kind}`);
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
      return `(${value}).field(${JSON.stringify(selected.name)}).get()`;
    }
    case IrKind.IfExpr: {
      const temp = ctx.fresh();
      out.push(`let ${temp} = ${ctx.emptyOf(e.type)};`);
      const c = lowerExpr(e.cond, out, ctx);
      const thenLines: string[] = [];
      const thenVal = lowerBlockInto(e.then, thenLines, ctx);
      if (thenVal !== null) {
        thenLines.push(`${temp} = (${coerce(thenVal, e.then.type, e.type)});`);
      }
      out.push(`if ((${c}).value) {`, ...indent(thenLines));
      if (e.else !== null) {
        const elseLines: string[] = [];
        const elseVal = lowerBlockInto(e.else, elseLines, ctx);
        if (elseVal !== null) {
          elseLines.push(
            `${temp} = (${coerce(elseVal, e.else.type, e.type)});`,
          );
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
        `let ${temp} = ${ctx.emptyOf(e.type)};`,
        `let ${matched} = false;`,
      );
      const subject = e.subject !== null ? capture(e.subject, out, ctx) : null;
      e.arms.forEach(arm => {
        const armLines: string[] = [];
        const val = lowerBlockInto(arm.body, armLines, ctx);
        if (val !== null) {
          armLines.push(`${temp} = (${coerce(val, arm.body.type, e.type)});`);
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
        const test =
          subject !== null ? `${subject}.eq(${p}).value` : `(${p}).value`;
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
      out.push(`let ${temp} = ${ctx.emptyOf(e.type)};`);
      const fromT = capture(e.from, out, ctx);
      const toT = capture(e.to, out, ctx);
      const stepT = e.step !== null ? capture(e.step, out, ctx) : 'int(1)';
      const index = localRef(ctx, e.index);
      const idx = `${index}.hist(0)`;
      const bodyLines: string[] = [];
      const val = lowerBlockInto(e.body, bodyLines, ctx);
      if (val !== null) {
        bodyLines.push(`${temp} = (${coerce(val, e.body.type, e.type)});`);
      }
      out.push(
        `for (${index}.set(${fromT}); (${stepT}).value > 0 ? (${idx}).le(${toT}).value : (${stepT}).value < 0 ? (${idx}).ge(${toT}).value : false; ${index}.set(rangeNext(${idx}, ${stepT}))) {`,
        ...indent(bodyLines),
        '}',
      );
      return temp;
    }
    case IrKind.WhileExpr: {
      const temp = ctx.fresh();
      out.push(`let ${temp} = ${ctx.emptyOf(e.type)};`, 'for (;;) {');
      const condLines: string[] = [];
      const c = lowerExpr(e.cond, condLines, ctx);
      const bodyLines: string[] = [];
      const val = lowerBlockInto(e.body, bodyLines, ctx);
      if (val !== null) {
        bodyLines.push(`${temp} = (${coerce(val, e.body.type, e.type)});`);
      }
      out.push(
        ...indent([
          ...condLines,
          `if (!((${c}).value)) { break; }`,
          ...bodyLines,
        ]),
        '}',
      );
      return temp;
    }
    case IrKind.ForInExpr: {
      if (ctx.binding === true) {
        return fatal('module binding cannot iterate a collection');
      }
      const result = ctx.fresh();
      const collection = capture(e.x, out, ctx);
      const entries = ctx.fresh();
      const index = ctx.fresh();
      out.push(
        `let ${result} = ${ctx.emptyOf(e.type)};`,
        `const ${entries} = ${collection}.entries();`,
      );
      const body: string[] = [];
      if (e.x.type.kind === TypeKind.Array) {
        if (e.targets.length === 1) {
          body.push(
            `${writeNameExpr(ctx, e.targets[0], `${entries}[${index}]`)};`,
          );
        } else if (e.targets.length === 2) {
          body.push(
            `${writeNameExpr(ctx, e.targets[0], `int(${index})`)};`,
            `${writeNameExpr(ctx, e.targets[1], `${entries}[${index}]`)};`,
          );
        } else {
          return fatal('array iteration requires one or two targets');
        }
      } else if (e.x.type.kind === TypeKind.Map) {
        if (e.targets.length !== 2) {
          return fatal('map iteration requires key and value targets');
        }
        body.push(
          `${writeNameExpr(ctx, e.targets[0], `${entries}[${index}][0]`)};`,
          `${writeNameExpr(ctx, e.targets[1], `${entries}[${index}][1]`)};`,
        );
      } else {
        return fatal(`unsupported collection iteration over ${e.x.type.kind}`);
      }
      const value = lowerBlockInto(e.body, body, ctx);
      if (value !== null) {
        body.push(`${result} = (${coerce(value, e.body.type, e.type)});`);
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
      return `bool((${x}).value ${op === IrOp.And ? '&&' : '||'} (${y}).value)`;
    }
    const temp = ctx.fresh();
    out.push(`let ${temp} = (${x});`);
    const guard =
      op === IrOp.And ? `if (${temp}.value) {` : `if (!${temp}.value) {`;
    out.push(guard, ...indent([...yLines, `${temp} = (${y});`]), '}');
    return temp;
  }
  const x = capture(xe, out, ctx);
  const y = capture(ye, out, ctx);
  const method =
    op === IrOp.Add && type.kind === TypeKind.String
      ? 'concat'
      : op.toLowerCase();
  return `${x}.${method}(${y})`;
}

// ---- natives ----------------------------------------------------------------

function scalarType(type: Type): string {
  switch (type.kind) {
    case TypeKind.Bool:
      return 'boolean';
    case TypeKind.Int:
    case TypeKind.Float:
      return 'number';
    default:
      return 'string | null';
  }
}

function lowerNative(
  native: string,
  argTypes: readonly Type[],
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
  ).map((arg, index) => coerce(arg, argExprs[index].type, argTypes[index]));
  if (native === '$historyDepth') return `historyDepth(${args[0]})`;
  if (/^(array|matrix|map)\./.test(native)) {
    ctx.layoutOf(resultType);
    if (ctx.binding === true)
      return fatal(`module binding cannot call aggregate native '${native}'`);
    const method = native
      .split('.')[1]
      .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (method === 'new' || method === 'from') {
      return `${ctx.factoryOf(resultType)}.${method}(ctx${args.map(arg => `, ${arg}`).join('')})`;
    }
    return `${args[0]}.${method}(${args.slice(1).join(', ')})`;
  }
  if (native === 'int') return `int(Math.trunc(${args[0]}.value))`;
  if (native === 'float') return `float(${args[0]}.value)`;
  if (native === 'na') return `na(${args[0]})`;
  if (native === 'nz') return `nz(${args.join(', ')})`;
  if (native === 'str.tostring') {
    const type = argExprs[0].type;
    const titles =
      type.kind === TypeKind.Enum
        ? `, ${JSON.stringify(type.members.map(member => [member.name, member.title]))}`
        : '';
    return `str.tostring(${args[0]}${titles})`;
  }
  if (native === 'color.new' || native === 'color.rgb')
    return `colors.${native.slice(6)}(${args.join(', ')})`;
  if (native.startsWith('math.')) {
    const value = `${native}(${args.join(', ')})`;
    return ctx.valueOf(resultType, `${value}.value`);
  }
  return unimplemented(`codegen: native '${native}'`);
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
      const direct = directName(ctx, stmt.name);
      if (ctx.binding === true && direct !== undefined) {
        const body: string[] = [];
        const value = lowerExpr(stmt.value, body, ctx);
        out.push(`if (${direct} === undefined) {`);
        out.push(...indent(body));
        out.push(`  ${direct} = (${value});`);
        out.push('}');
        return;
      }
      const local = localRef(ctx, stmt.name);
      const body: string[] = [];
      const value = lowerExpr(stmt.value, body, ctx);
      out.push(
        `if (${local}.needsInit()) {`,
        ...indent(body),
        `  ${local}.initialize(${coerce(value, stmt.value.type, stmt.name.type)});`,
        '}',
      );
      return;
    }
    case IrKind.Assign: {
      if (!assignable(stmt.value.type, stmt.target.type)) {
        return fatal(
          `assigned value type ${stmt.value.type.kind} is not assignable to ${stmt.target.type.kind}`,
        );
      }
      const target = captureDestination(stmt.target, out, ctx);
      let previous: string | null = null;
      if (stmt.op !== null) {
        previous = ctx.fresh();
        out.push(`const ${previous} = ${target.read};`);
      }
      let value = lowerExpr(stmt.value, out, ctx);
      if (stmt.op !== null) {
        const method =
          stmt.op === IrOp.Add && stmt.target.type.kind === TypeKind.String
            ? 'concat'
            : stmt.op.toLowerCase();
        value = `${previous}.${method}(${value})`;
      }
      out.push(
        target.store(
          coerce(
            value,
            stmt.op === null ? stmt.value.type : stmt.target.type,
            stmt.target.type,
          ),
        ),
      );
      return;
    }
    case IrKind.Emit: {
      if (ctx.binding === true) {
        return fatal('module binding cannot emit a row output');
      }
      const oid = ctx.outputIds.get(stmt.output);
      if (oid === undefined) {
        return fatal('lowering reached an unmapped output');
      }
      const value = lowerExpr(stmt.value, out, ctx);
      out.push(
        `${property('ctx.outputs', stmt.output.name)}.${stmt.output.mode}(${coerce(value, stmt.value.type, stmt.output.valueType)});`,
      );
      return;
    }
    case IrKind.Return: {
      if (ctx.currentResultType === undefined)
        return fatal('return outside a function reached lowering');
      if (stmt.value === null) out.push('return;');
      else {
        const value = lowerExpr(stmt.value, out, ctx);
        out.push(
          `return ${coerce(value, stmt.value.type, ctx.currentResultType)};`,
        );
      }
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
