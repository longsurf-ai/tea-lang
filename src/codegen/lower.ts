// Purpose: Lower Tea expressions and statements to typed values and named runtime state.

import {fatal} from '../base/print';
import type {FrameTopology} from '../ir/frames';
import {unimplemented} from '../base/unimplemented';
import {
  CollectionLocationKind,
  IrKind,
  IrOp,
  PlaceKind,
  type CollectionLocation,
  type IrBinaryOp,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../ir/node';
import type {
  EffectDecl,
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
  readonly outputIds: Map<OutputDecl | EffectDecl, number>;
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

function collectionLocationType(location: CollectionLocation): Type {
  return location.kind === CollectionLocationKind.Name
    ? location.name.type
    : structFieldType(location.owner, location.fieldIndex);
}

interface CapturedCollectionLocation {
  readonly value: string;
  store(replacement: string): string;
}

// Capture a collection location and its current header before explicit
// arguments. A struct-field receiver is certified once and reused for the
// final replacement write even if an argument rebinds an ancestor Name.
function captureCollectionLocation(
  location: CollectionLocation,
  out: string[],
  ctx: LowerCtx,
): CapturedCollectionLocation {
  if (location.kind === CollectionLocationKind.Name) {
    const value = ctx.fresh();
    out.push(`const ${value} = (${readName(ctx, location.name, '0', true)});`);
    return {
      value,
      store: replacement =>
        `${writeNameExpr(ctx, location.name, replacement)};`,
    };
  }
  if (!typesEqual(location.object.type, location.owner)) {
    return fatal('collection field object disagrees with its owner type');
  }
  structFieldType(location.owner, location.fieldIndex);
  const object = capture(location.object, out, ctx);
  const target = ctx.fresh();
  const value = ctx.fresh();
  const field = location.owner.fields[location.fieldIndex].name;
  out.push(
    `const ${target} = (${object}).require().field(${JSON.stringify(field)});`,
    `const ${value} = ${target}.get();`,
  );
  return {
    value,
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
    case IrKind.OutputRef: {
      // Output references cross the ABI as their oid (fill's plot args).
      const oid = ctx.outputIds.get(e.output);
      if (oid === undefined) {
        return fatal('lowering reached an unmapped output reference');
      }
      return `int(${oid})`;
    }
    case IrKind.HistRead: {
      const off =
        e.offset === null ? '0' : `(${capture(e.offset, out, ctx)}).value`;
      switch (e.place.kind) {
        case PlaceKind.Name: {
          const current =
            e.offset === null ||
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
            if (e.offset !== null) {
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
    case IrKind.Cond: {
      // Pine evaluates all three operands eagerly.
      const c = capture(e.cond, out, ctx);
      const t = capture(e.then, out, ctx);
      const f = capture(e.else, out, ctx);
      return `((${c}).value ? (${coerce(t, e.then.type, e.type)}) : (${coerce(f, e.else.type, e.type)}))`;
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
      const bindRef = ctx.bindFuncRefs?.get(e.func);
      if (ctx.binding === true) {
        if (bindRef === undefined) {
          return fatal(
            `module binding reached unavailable function '${e.func.name}'`,
          );
        }
        return `${bindRef}(${args.map((arg, i) => coerce(arg, e.args[i].type, e.func.params[i].type)).join(', ')})`;
      }
      return `${ctx.functionRef(e.func)}(ctx, ${property(`${ctx.currentFid === 0 ? 'ctx.state' : 'frame'}.calls`, ctx.callKey(ctx.currentFid, e.slot))}${args.map((arg, i) => `, ${coerce(arg, e.args[i].type, e.func.params[i].type)}`).join('')})`;
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
      const bindRef = ctx.bindFuncRefs?.get(e.func);
      if (ctx.binding === true) {
        if (bindRef === undefined) {
          return fatal(
            `module binding reached unavailable method '${e.func.name}'`,
          );
        }
        return `${bindRef}(${receiver}${args.map((arg, i) => `, ${coerce(arg, e.args[i].type, e.func.params[i].type)}`).join('')})`;
      }
      return `${ctx.functionRef(e.func)}(ctx, ${property(`${ctx.currentFid === 0 ? 'ctx.state' : 'frame'}.calls`, ctx.callKey(ctx.currentFid, e.slot))}, ${receiver}${args.map((arg, i) => `, ${coerce(arg, e.args[i].type, e.func.params[i].type)}`).join('')})`;
    }
    case IrKind.CallMutableMethod: {
      if (ctx.binding === true) {
        return fatal(
          `module binding cannot call mutable method '${e.func.name}'`,
        );
      }
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
      if (e.receiver.type.kind !== TypeKind.Struct) {
        return fatal(
          `mutable method '${e.func.name}' has non-struct receiver ${e.receiver.type.kind}`,
        );
      }
      const fid = ctx.funcIds.get(e.func);
      if (fid === undefined) {
        return fatal(`unmapped mutable method '${e.func.name}'`);
      }
      ctx.noteCallSite(ctx.currentFid, e.slot, e.func);
      const candidate = capture(e.receiver, out, ctx);
      const receiver = ctx.fresh();
      out.push(`const ${receiver} = (${candidate}).require();`);
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `mutable method call '${e.func.name}'`,
      );
      return `${ctx.functionRef(e.func)}(ctx, ${property(`${ctx.currentFid === 0 ? 'ctx.state' : 'frame'}.calls`, ctx.callKey(ctx.currentFid, e.slot))}, ${receiver}${args.map((arg, i) => `, ${coerce(arg, e.args[i].type, e.func.params[i].type)}`).join('')})`;
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
      if (ctx.binding === true) {
        return fatal(
          `module binding cannot mutate collection '${e.operation}'`,
        );
      }
      const locationType = collectionLocationType(e.location);
      const collectionKind = locationType.kind;
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
      const location = captureCollectionLocation(e.location, out, ctx);
      const args = captureArguments(
        e.args,
        e.argumentEvaluationOrder,
        out,
        ctx,
        `collection mutation '${e.operation}'`,
      );
      const method = e.operation.split('.')[1];
      const expected =
        locationType.kind === TypeKind.Map
          ? method === 'put'
            ? [locationType.key, locationType.value]
            : [locationType.key]
          : locationType.kind === TypeKind.Array
            ? method === 'set'
              ? [e.args[0]?.type, locationType.elem]
              : [locationType.elem]
            : locationType.kind === TypeKind.Matrix
              ? method === 'set'
                ? [e.args[0]?.type, e.args[1]?.type, locationType.elem]
                : [locationType.elem]
              : [];
      const values = args.map((arg, index) =>
        expected[index] === undefined
          ? arg
          : coerce(arg, e.args[index].type, expected[index]),
      );
      const result = ctx.fresh();
      out.push(
        `const ${result} = ${location.value}.${method}(${values.join(', ')});`,
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
  if (native === '$historyDepth') return `historyDepth(${args[0]})`;
  if (/^(array|matrix|map)\./.test(native)) {
    ctx.layoutOf(resultType);
    if (ctx.binding === true)
      return fatal(`module binding cannot call aggregate native '${native}'`);
    const method = native
      .split('.')[1]
      .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (method === 'new' || method === 'from') {
      const initial =
        resultType.kind === TypeKind.Array ||
        resultType.kind === TypeKind.Matrix
          ? resultType.elem
          : null;
      const values = args.map((arg, index) =>
        initial !== null &&
        (method === 'from' ||
          index === (resultType.kind === TypeKind.Matrix ? 2 : 1))
          ? coerce(arg, argExprs[index].type, initial)
          : arg,
      );
      return `${ctx.factoryOf(resultType)}.${method}(ctx${values.map(arg => `, ${arg}`).join('')})`;
    }
    const receiver = argExprs[0].type;
    const values = args
      .slice(1)
      .map((arg, index) =>
        receiver.kind === TypeKind.Map && index === 0
          ? coerce(arg, argExprs[index + 1].type, receiver.key)
          : arg,
      );
    return `${args[0]}.${method}(${values.join(', ')})`;
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
        `${local}.init(() => {`,
        ...indent(body),
        `  return ${coerce(value, stmt.value.type, stmt.name.type)};`,
        '});',
      );
      return;
    }
    case IrKind.WriteName: {
      const v = lowerExpr(stmt.value, out, ctx);
      out.push(
        `${writeNameExpr(ctx, stmt.name, coerce(v, stmt.value.type, stmt.name.type))};`,
      );
      return;
    }
    case IrKind.StoreField: {
      if (ctx.binding === true) {
        return fatal('module binding cannot store a struct field');
      }
      if (!typesEqual(stmt.object.type, stmt.owner)) {
        return fatal('struct field store object disagrees with its owner type');
      }
      const targetType = structFieldType(stmt.owner, stmt.fieldIndex);
      if (!assignable(stmt.value.type, targetType)) {
        return fatal(
          `struct field value type ${stmt.value.type.kind} is not assignable to ${targetType.kind}`,
        );
      }
      const object = capture(stmt.object, out, ctx);
      const target = ctx.fresh();
      out.push(
        `const ${target} = (${object}).require().field(${JSON.stringify(stmt.owner.fields[stmt.fieldIndex].name)});`,
      );
      const value = lowerExpr(stmt.value, out, ctx);
      out.push(
        ` ${target}.set(${coerce(value, stmt.value.type, targetType)});`,
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
      const args = captureArguments(
        stmt.args,
        stmt.argumentEvaluationOrder,
        out,
        ctx,
        `output '${stmt.output.effect}'`,
      );
      if (args.length === 0) return;
      out.push(
        `${property('ctx.outputs', `output${oid}`)}.set({${args.map((arg, channel) => `${JSON.stringify(stmt.output.channels[channel].name)}: ${arg}`).join(', ')}});`,
      );
      return;
    }
    case IrKind.EmitEffect: {
      if (ctx.binding === true) {
        return fatal('module binding cannot emit an effect');
      }
      const outputId = ctx.outputIds.get(stmt.effect);
      if (outputId === undefined) {
        return fatal('lowering reached an unmapped effect');
      }
      const payload = lowerExpr(stmt.payload, out, ctx);
      out.push(
        `${property('ctx.outputs', `effect${outputId - [...ctx.outputIds.keys()].filter(output => 'channels' in output).length}`)}.append(${payload});`,
      );
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
