// Purpose: Lower one Tea Program to ordinary typed TypeScript using tea/runtime.

import type {Module} from '../runtime/module-binding';

import {Field, Float64, Schema} from 'apache-arrow';
import {outputSchema} from '../runtime/output';
import {fatal} from '../base/print';
import {fieldOf, schemaSource} from './schema';
import ts from 'typescript';
import {parametersOf} from './params';
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
  type IrFunc,
  type BuiltinInput,
  type OutputDecl,
  type ParamInput,
  type Program,
  type RequestEdge,
  type SeriesInput,
} from '../ir/program';
import {
  FloatType,
  formatType,
  isNaValue,
  Qualifier,
  qualifierLE,
  TypeKind,
  typesEqual,
  type ConstValue,
  type EnumType,
  type Type,
} from '../ir/type';
import {
  builtinInputsOf,
  requestsOf,
  seriesInputsOf,
  walkIrExpr,
} from '../ir/visit';
import {isHistoryOffset, RUNTIME_ABI_VERSION} from '../runtime/module-abi';
import type {Depth, Request} from '../runtime/module-abi';
import type {Scalar} from '../runtime/value';
import {
  captureArguments,
  coerce,
  property,
  indent,
  lowerExpr,
  lowerStmts,
  type LowerCtx,
} from './lower';

/**
 * Lower one checked Program to a deterministic TypeScript module. The
 * artifact contains Arrow constructors and state requirements, but no stream,
 * parameter assignment, or mutable execution state. Load it before binding.
 *
 * @example
 * ```ts
 * import {Errors} from '../base/print';
 * import {compileToProgram} from '../compiler';
 * import {loadModule} from '../runtime/load';
 *
 * const program = compileToProgram(
 *   [{filename: 'demo.tea', source: 'plot(close)'}], new Errors(),
 * );
 * if (program !== null) {
 *   const module = loadModule(generate(program));
 *   module.inputs.schema.fields[0].name; // "close"
 * }
 * ```
 */
export function generate(program: Program): string {
  const emitter = new ModuleEmitter(program.nominalIds);
  const root = new Generator(program, 'program', emitter).moduleBody();
  const body = [
    ...emitter.types.values(),
    ...emitter.factoryLines,
    ...emitter.childDecls,
    ...root,
    'export default program;',
    '',
  ].join('\n');
  const values = [
    'Module',
    'Color',
    'int',
    'float',
    'bool',
    'text',
    'color',
    'enumeration',
    'resource',
    'struct',
    'array',
    'matrix',
    'map',
    'tuple',
    'math',
    'colors',
    'str',
    'na',
    'nz',
    'historyDepth',
    'rangeNext',
    'contextValue',
    'Schema',
    'Field',
    'Float64',
    'Uint8',
    'Bool',
    'Utf8',
    'List',
    'Struct',
    'Map_',
    'TimestampMillisecond',
  ];
  const types = [
    'Value',
    'Context',
    'Input',
    'Series',
    'Ref',
    'ArrayValue',
    'MatrixValue',
    'MapValue',
    'ResourceHandle',
  ];
  const used = (name: string) => new RegExp(`\\b${name}\\b`).test(body);
  const imports = [
    ...values.filter(used),
    ...types.filter(used).map(name => `type ${name}`),
  ];
  const source = ts.createSourceFile(
    'generated.ts',
    `import {${imports.join(', ')}} from "tea/runtime";\n${body}`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  return ts
    .createPrinter(
      {newLine: ts.NewLineKind.LineFeed},
      {
        substituteNode: (_, node) => {
          if (
            ts.isStringLiteral(node) &&
            node.text === '__proto__' &&
            node.parent !== undefined &&
            ts.isPropertyAssignment(node.parent) &&
            node.parent.name === node
          )
            return ts.factory.createComputedPropertyName(
              ts.factory.createStringLiteral(node.text),
            );
          return ts.isStringLiteral(node) &&
            node.parent !== undefined &&
            (ts.isPropertyAssignment(node.parent) ||
              ts.isPropertySignature(node.parent) ||
              ts.isEnumMember(node.parent)) &&
            node.parent.name === node &&
            /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.text)
            ? ts.factory.createIdentifier(node.text)
            : node;
        },
      },
    )
    .printFile(source);
}

class ModuleEmitter {
  readonly childDecls: string[] = [];
  readonly types = new Map<Type, string>();
  readonly factories = new Map<number, string>();
  private readonly namedTypes: Type[] = [];
  private childCounter = 0;

  readonly nominalIds: Map<Type, string>;

  constructor(nominalIds: ReadonlyMap<Type, string>) {
    this.nominalIds = new Map(nominalIds);
  }

  get factoryLines(): string[] {
    const depth = (type: Type): number => {
      if (type.kind === TypeKind.Array || type.kind === TypeKind.Matrix)
        return 1 + depth(type.elem);
      if (type.kind === TypeKind.Map)
        return 1 + Math.max(depth(type.key), depth(type.value));
      if (type.kind === TypeKind.Tuple)
        return 1 + Math.max(0, ...type.elems.map(depth));
      return 0;
    };
    return [...this.factories.entries()]
      .sort(([a], [b]) => depth(this.namedTypes[a]) - depth(this.namedTypes[b]))
      .map(([, source]) => source);
  }

  kindOf(type: Type): string {
    if (
      (type.kind === TypeKind.Enum || type.kind === TypeKind.Struct) &&
      !this.nominalIds.has(type)
    )
      this.nominalIds.set(type, `${type.name}#${this.nameId(type)}`);
    return type.kind === TypeKind.Enum || type.kind === TypeKind.Struct
      ? (this.nominalIds.get(type) ?? `${type.name}#${this.nameId(type)}`)
      : [
            TypeKind.Line,
            TypeKind.Label,
            TypeKind.Box,
            TypeKind.Table,
            TypeKind.Polyline,
            TypeKind.Linefill,
          ].some(kind => kind === type.kind)
        ? type.kind
        : type.kind.toLowerCase();
  }

  typeOf(type: Type, owner = 'Value'): string {
    if (type.kind === TypeKind.Void) return 'void';
    return `${owner}<${this.rawType(type)}, ${json(this.kindOf(type))}>`;
  }

  private rawType(type: Type): string {
    switch (type.kind) {
      case TypeKind.Int:
      case TypeKind.Float:
        return 'number';
      case TypeKind.Bool:
        return 'boolean';
      case TypeKind.String:
        return 'string | null';
      case TypeKind.Color:
        return 'Color | null';
      case TypeKind.Enum:
        return `${this.enumOf(type)} | null`;
      case TypeKind.Struct: {
        const name = `${identifier(type.name)}${this.nameId(type)}`;
        const brand = `${name}Tag`;
        if (!this.types.has(type)) {
          this.types.set(type, '');
          this.types.set(
            type,
            `const ${brand} = Symbol(${json(type.name)});
class ${name} {
  declare readonly [${brand}]: void;
  ${type.fields.map(field => `${field.name === 'constructor' ? `[${json(field.name)}]` : json(field.name)}: ${this.typeOf(field.type)} = ${this.emptyOf(field.type, 'undefined')};`).join('\n')}
  constructor(fields?: Omit<${name}, typeof ${brand}>) { if (fields) Object.assign(this, fields); }
}`,
          );
        }
        return `Ref<${name}> | null`;
      }
      case TypeKind.Array:
        return `ArrayValue<${this.typeOf(type.elem)}> | null`;
      case TypeKind.Matrix:
        return `MatrixValue<${this.typeOf(type.elem)}> | null`;
      case TypeKind.Map:
        return `MapValue<${this.typeOf(type.key)}, ${this.typeOf(type.value)}> | null`;
      case TypeKind.Tuple:
        return `readonly [${type.elems.map(type => this.typeOf(type)).join(', ')}] | null`;
      case TypeKind.Line:
      case TypeKind.Label:
      case TypeKind.Box:
      case TypeKind.Table:
      case TypeKind.Polyline:
      case TypeKind.Linefill:
        return 'ResourceHandle | null';
      default:
        return fatal(
          `non-runtime type ${type.kind} reached TypeScript projection`,
        );
    }
  }

  valueOf(type: Type, raw: string): string {
    switch (type.kind) {
      case TypeKind.Int:
        return `int(${raw})`;
      case TypeKind.Float:
        return `float(${raw})`;
      case TypeKind.Bool:
        return `bool(${raw})`;
      case TypeKind.String:
        return `text(${raw})`;
      case TypeKind.Color:
        return `color(${raw})`;
      case TypeKind.Enum: {
        const name = this.enumOf(type);
        const member = type.members.find(member => json(member.name) === raw);
        const value =
          member === undefined
            ? `${raw} as ${name} | null`
            : property(name, member.name);
        return `enumeration<${name}, ${json(this.kindOf(type))}>(${value}, ${json(this.kindOf(type))}, ${this.enumOf(type)})`;
      }
      default:
        return `resource(${raw}, ${json(this.kindOf(type))})`;
    }
  }

  private enumOf(type: EnumType): string {
    const name = `${identifier(type.name)}Enum${this.nameId(type)}`;
    if (!this.types.has(type)) {
      this.types.set(
        type,
        `enum ${name} {${type.members.map(member => `${json(member.name)} = ${json(member.name)}`).join(', ')}}
${type.members.some(member => member.name === '__proto__') ? `Object.defineProperty(${name}, "__proto__", {value: "__proto__", enumerable: true});` : ''}`,
      );
    }
    return name;
  }

  emptyOf(type: Type, context = 'ctx'): string {
    switch (type.kind) {
      case TypeKind.Void:
        return 'undefined';
      case TypeKind.Int:
      case TypeKind.Float:
        return this.valueOf(type, 'NaN');
      case TypeKind.Bool:
        return 'bool(false)';
      case TypeKind.Struct:
      case TypeKind.Array:
      case TypeKind.Matrix:
      case TypeKind.Map:
      case TypeKind.Tuple:
        return `${this.factoryOf(type)}.empty(${context})`;
      default:
        return this.valueOf(type, 'null');
    }
  }

  factoryOf(type: Type): string {
    const id = this.nameId(type);
    const name = `${type.kind === TypeKind.Struct ? identifier(type.name) : type.kind}Type${id}`;
    if (!this.factories.has(id)) {
      this.factories.set(id, '');
      let expression: string;
      switch (type.kind) {
        case TypeKind.Struct:
          this.rawType(type);
          expression = `struct<${identifier(type.name)}${id}, ${json(this.kindOf(type))}>(${identifier(type.name)}${id}, ${json(this.kindOf(type))}, ${16 + type.fields.reduce((sum, field) => sum + this.byteSize(field.type), 0)})`;
          break;
        case TypeKind.Array:
          expression = `array<${this.typeOf(type.elem)}>(${this.emptyOf(type.elem, 'undefined')})`;
          break;
        case TypeKind.Matrix:
          expression = `matrix<${this.typeOf(type.elem)}>(${this.emptyOf(type.elem, 'undefined')})`;
          break;
        case TypeKind.Map:
          expression = `map<${this.typeOf(type.key)}, ${this.typeOf(type.value)}>(${this.emptyOf(type.key, 'undefined')}, ${this.emptyOf(type.value, 'undefined')})`;
          break;
        case TypeKind.Tuple:
          expression = `tuple<readonly [${type.elems.map(type => this.typeOf(type)).join(', ')}]>([${type.elems.map(type => this.emptyOf(type, 'undefined')).join(', ')}])`;
          break;
        default:
          return fatal(`no aggregate factory for ${type.kind}`);
      }
      this.factories.set(id, `const ${name} = ${expression};`);
    }
    return name;
  }

  private nameId(type: Type): number {
    const existing = this.namedTypes.findIndex(candidate =>
      typesEqual(candidate, type),
    );
    if (existing >= 0) return existing;
    this.namedTypes.push(type);
    return this.namedTypes.length - 1;
  }

  private byteSize(type: Type): number {
    if (type.kind === TypeKind.Array || type.kind === TypeKind.Matrix)
      return 32;
    if (type.kind === TypeKind.Map) return 24;
    if (type.kind === TypeKind.Tuple)
      return (
        16 +
        type.elems.reduce((sum, element) => sum + this.byteSize(element), 0)
      );
    return 8;
  }

  emitChild(
    child: Program,
    resultName: Name,
    parent: Generator,
  ): {ref: string; resultSlot: number} {
    this.childCounter += 1;
    const ref = `request${this.childCounter}`;
    const generator = new Generator(child, ref, this, parent);
    const body = generator.moduleBody();
    const resultSlot = generator.programFrameSlot(resultName);
    this.childDecls.push(...body);
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
  private readonly seriesIds = new Map<SeriesInput, number>();
  private readonly builtinIds = new Map<BuiltinInput, number>();
  private readonly paramIds = new Map<ParamInput, number>();
  private readonly paramSeriesIds = new Map<ParamInput, number>();
  private readonly outputIds = new Map<OutputDecl, number>();
  private readonly funcIds = new Map<IrFunc, number>();
  private readonly requestIds = new Map<RequestEdge, number>();
  private readonly localKeys = new Map<Name, string>();
  private readonly callKeys = new Map<string, string>();
  private readonly seriesKeys = new Map<SeriesInput | ParamInput, string>();
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
    for (const frame of this.topology.frames) {
      const locals = new Set<string>();
      frame.locals.forEach(name =>
        this.localKeys.set(name, unique(name.name, locals)),
      );
      const calls = new Set<string>();
      frame.children.forEach(child =>
        this.callKeys.set(
          `${frame.id}:${child.slot}`,
          unique(child.callee.name, calls),
        ),
      );
    }
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

    const inputNames = new Set<string>();
    this.series.forEach((s, sid) => {
      this.seriesIds.set(s, sid);
      this.seriesKeys.set(s, unique(s.id, inputNames));
    });
    this.builtins.forEach((builtin, bid) => this.builtinIds.set(builtin, bid));
    let nextSid = this.series.length;
    // Parameters are compilation-global. A request child inherits the root's
    // pid map and carries the same parameter specs/values in its own concrete
    // module. Source-parameter reads cannot cross into children.
    if (parent !== null) {
      for (const [param, pid] of parent.paramIds) {
        this.paramIds.set(param, pid);
      }
      for (const [param, sid] of parent.paramSeriesIds) {
        this.paramSeriesIds.set(param, sid);
        this.seriesKeys.set(param, parent.seriesKeys.get(param)!);
      }
    }
    program.params.forEach((param, pid) => {
      this.paramIds.set(param, pid);
      if (param.defaultValue?.kind === ParamDefaultKind.Series) {
        this.paramSeriesIds.set(param, nextSid);
        this.seriesKeys.set(param, unique(param.name, inputNames));
        nextSid += 1;
      }
    });
    program.outputs.forEach((output, oid) => this.outputIds.set(output, oid));
    this.topology.frameByFunc.forEach((frame, func) => {
      this.funcIds.set(func, frame.id);
    });
  }

  private ctxFor(
    fid: number,
    directNames: ReadonlyMap<Name, string> = new Map(),
  ): LowerCtx {
    return {
      nameLocations: this.topology.nameLocations,
      directNames,
      seriesIds: this.seriesIds,
      builtinIds: this.builtinIds,
      paramIds: this.paramIds,
      paramSeriesIds: this.paramSeriesIds,
      outputIds: this.outputIds,
      funcIds: this.funcIds,
      requestIds: this.requestIds,
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
      typeOf: type => this.emitter.typeOf(type),
      valueOf: (type, raw) => this.emitter.valueOf(type, raw),
      emptyOf: type => this.emitter.emptyOf(type),
      factoryOf: type => this.emitter.factoryOf(type),
      localKey: name => this.localKeys.get(name) ?? fatal('unmapped local'),
      callKey: (frame, slot) =>
        this.callKeys.get(`${frame}:${slot}`) ?? fatal('unmapped call'),
      functionRef: func => this.functionRef(func),
      seriesKey: series =>
        this.seriesKeys.get(series) ?? fatal('unmapped source'),
      fresh: () => `t${this.tempCounter++}`,
    };
  }

  // The slot of a name in THIS module's program frame \u2014 how a parent learns
  // its child's result slot.
  programFrameSlot(name: Name): number {
    const where = this.topology.nameLocations.get(name);
    if (where === undefined || where.frameId !== 0) {
      return fatal(`'${name.name}' is not a program-frame name`);
    }
    return where.slot;
  }

  // The module object's body lines (between the braces). Every node is a
  // complete Module; request children share the emitted class/enum declarations.
  moduleBody(): string[] {
    // Frame ownership and call sites already come from frameTopologyOf().
    // Lower code first so module construction can reference its declarations.
    const bindLines = this.lowerBind();
    const funcBodies = this.lowerFuncs();
    const mainLines: string[] = [];
    lowerStmts(this.program.body, mainLines, this.ctxFor(0));

    const children = this.requests.map(edge =>
      this.emitter.emitChild(edge.child, edge.resultName, this),
    );
    const data = this.moduleFields(children);

    const context = this.contextName();
    const out = this.declarations();
    for (const lines of funcBodies.values()) out.push(...lines);
    out.push(
      `function ${this.moduleRef}_main(ctx: ${context}): void {`,
      ...indent(mainLines),
      '}',
    );
    out.push(
      `const ${this.moduleRef}: Module<${context}> = new Module<${context}>({`,
    );
    out.push(`  abi: ${RUNTIME_ABI_VERSION},`);
    out.push(
      `  inputs: {\n    schema: ${schemaSource(data.inputs.schema)},\n    series: ${json(data.inputs.series)},\n    builtins: [${data.inputs.builtins.join(', ')}],\n  },`,
    );
    out.push(`  parameters: ${json(data.parameters)},`);
    out.push(`  state: {\n    frames: [${data.frames.join(', ')}],\n  },`);
    out.push(
      `  outputs: {\n    schema: ${schemaSource(data.outputs.schema)},\n  },`,
    );
    out.push(
      `  requests: [${data.requests.map((request, id) => `${request.slice(0, -1)}, "module": ${children[id].ref}}`).join(', ')}],`,
    );
    out.push(
      `}, ${this.moduleRef}_main, (module, contextConstants) => {`,
      ...indent(bindLines),
      '});',
    );
    return out;
  }

  private contextName(): string {
    return this.root ? 'ProgramContext' : `${title(this.moduleRef)}Context`;
  }

  private frameName(fid: number): string {
    const frame = this.topology.frames[fid];
    return `${title(this.moduleRef)}${frame.owner === null ? 'State' : `${title(frame.owner.name)}State${fid}`}`;
  }

  private functionRef(func: IrFunc): string {
    return `${this.moduleRef}_${identifier(func.name)}${this.funcIds.get(func)}`;
  }

  private declarations(): string[] {
    const out = this.topology.frames.map(
      frame =>
        `type ${this.frameName(frame.id)} = {readonly locals: {${frame.locals.map(name => `readonly ${json(this.localKeys.get(name))}: ${this.emitter.typeOf(name.type, 'Series')}`).join('; ')}}; readonly calls: {${frame.children.map(child => `readonly ${json(this.callKeys.get(`${frame.id}:${child.slot}`))}: ${this.frameName(child.frameId)}`).join('; ')}}};`,
    );
    const params = this.globalParams.map(
      param =>
        `readonly ${json(param.name)}: ${param.defaultValue?.kind === ParamDefaultKind.Series ? `Value<string | null, "string">` : this.emitter.typeOf(param.type)}`,
    );
    const series = this.series.map(
      input =>
        `readonly ${json(this.seriesKeys.get(input))}: ${this.emitter.typeOf(input.type, 'Input')}`,
    );
    if (this.root)
      for (const [param] of this.paramSeriesIds)
        series.push(
          `readonly ${json(this.seriesKeys.get(param))}: ${this.emitter.typeOf(param.type, 'Input')}`,
        );
    const builtins = this.builtins.map(
      input =>
        `readonly ${json(`${input.source.domain}.${input.source.field}`)}: ${this.emitter.typeOf(input.type, 'Input')}`,
    );
    const children = this.requests.map(
      request =>
        `readonly ${json(request.name)}: ${this.emitter.typeOf(request.resultType, 'Input')}`,
    );
    const outputs = this.program.outputs.map(
      output =>
        `readonly ${json(output.name)}: {${output.mode}(value: ${this.emitter.typeOf(output.valueType)}): void}`,
    );
    out.push(
      `export type ${this.contextName()} = Context<{${params.join('; ')}}, {readonly series: {${series.join('; ')}}; readonly builtins: {${builtins.join('; ')}}; readonly children: {${children.join('; ')}}}, ${this.frameName(0)}, {${outputs.join('; ')}}};`,
    );
    return out;
  }

  /**
   * Emit preparation code for facts depending on bindings. The caller supplies
   * a private draft of binding facts; expressions use its parameters and context
   * constants, without allocating execution frames or a Heap.
   *
   * @example `close[length]` emits an assignment to
   * `module.inputs.series[0].depth` using `module.parameters[0].value`.
   * A literal `close[3]` needs no preparation code: its depth is already 3.
   */
  private lowerBind(): string[] {
    const roots = this.bindingExpressions();
    const dependencies = this.bindingDependencies(roots);
    const rootNames = new Map<Name, string>();
    for (const name of dependencies.names) {
      const where = this.topology.nameLocations.get(name);
      if (
        where?.frameId === 0 &&
        name.storage === Storage.PerBar &&
        qualifierLE(name.qualifier, Qualifier.Simple)
      ) {
        rootNames.set(name, `b0_${where.slot}`);
      }
    }

    const funcs = [...dependencies.funcs].sort((left, right) => {
      const l = this.funcIds.get(left) ?? fatal('unmapped binding function');
      const r = this.funcIds.get(right) ?? fatal('unmapped binding function');
      return l - r;
    });
    const funcRefs = new Map<IrFunc, string>();
    funcs.forEach(func => {
      const fid = this.funcIds.get(func);
      if (fid === undefined) return fatal('unmapped binding function');
      funcRefs.set(func, `bF${fid}`);
    });

    const resets: string[] = [];
    const lines: string[] = [];
    for (const [name, local] of rootNames) {
      lines.push(`let ${local}!: ${this.emitter.typeOf(name.type)};`);
    }
    for (const func of funcs) {
      lines.push(...this.lowerBindFunc(func, rootNames, funcRefs));
    }

    const ctx = {
      ...this.ctxFor(0, rootNames),
      binding: true,
      bindFuncRefs: funcRefs,
    } satisfies LowerCtx;
    const validationCtx = {...ctx, fresh: () => 'unused'} satisfies LowerCtx;
    const prelude = [...this.program.init, ...this.program.body].filter(
      stmt => {
        const name =
          stmt.kind === IrKind.InitName
            ? stmt.name
            : stmt.kind === IrKind.Assign && stmt.target.kind === IrKind.Read
              ? stmt.target.place.name
              : null;
        return (
          name !== null &&
          dependencies.names.has(name) &&
          qualifierLE(name.qualifier, Qualifier.Simple)
        );
      },
    );
    lowerStmts(prelude, lines, ctx);

    const writeDepth = (target: string, depth: HistoryDepth): void => {
      if (depth.kind !== DepthKind.Bound || depthOf(depth).kind !== 'bound') {
        return;
      }
      resets.push(`${target} = {kind: "bound"};`);
      const expr = lowerExpr(depth.expr, lines, ctx);
      lines.push(
        `${target} = {kind: "const", bars: historyDepth(${expr}).value};`,
      );
    };
    this.series.forEach((series, sid) =>
      writeDepth(`module.inputs.series[${sid}].depth`, series.depth),
    );
    this.builtins.forEach((builtin, bid) =>
      writeDepth(`module.inputs.builtins[${bid}].depth`, builtin.depth),
    );
    if (this.root) {
      for (const [param, sid] of this.paramSeriesIds) {
        writeDepth(`module.inputs.series[${sid}].depth`, param.depth);
      }
    }
    this.requests.forEach((request, rid) =>
      writeDepth(`module.requests[${rid}].depth`, request.depth),
    );
    for (const [name, where] of this.topology.nameLocations) {
      writeDepth(
        `module.state.frames[${where.frameId}].locals[${where.slot}].depth`,
        name.depth,
      );
    }

    if (this.root) {
      this.program.params.forEach(param => {
        if (staticBool(param.active) !== null) return;
        const pid = this.paramIds.get(param);
        if (pid === undefined) return fatal(`unmapped param '${param.name}'`);
        resets.push(`module.parameters[${pid}].active = null;`);
        const active = lowerExpr(param.active, lines, ctx);
        lines.push(`module.parameters[${pid}].active = (${active}).value;`);
      });
    }
    this.requests.forEach((edge, rid) => {
      if (staticRequestContext(edge) !== null) {
        captureArguments(
          [
            edge.merge.availability,
            edge.merge.fill,
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
      resets.push(`module.requests[${rid}].context = null;`);
      const [availability, fill, ignoreInvalidSymbol, calcBarsCount] =
        captureArguments(
          [
            edge.merge.availability,
            edge.merge.fill,
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
        `module.requests[${rid}].context = {symbol: (${symbol}).value!, timeframe: (${timeframe}).value!, availability: (${availability}).value as "start" | "end", fill: (${fill}).value as "carry" | "sparse", ignoreInvalidSymbol: (${ignoreInvalidSymbol}).value, calcBarsCount: (${calcBarsCount}).value};`,
      );
    });
    const missing = this.globalParams.map(
      (_, pid) => `module.parameters[${pid}].value === undefined`,
    );
    return [
      ...resets,
      ...(missing.length ? [`if (${missing.join(' || ')}) return;`] : []),
      ...lines,
    ];
  }

  private bindingExpressions(): IrExpr[] {
    const expressions: IrExpr[] = [];
    const noteDepth = (depth: HistoryDepth): void => {
      if (depth.kind === DepthKind.Bound && depthOf(depth).kind === 'bound') {
        expressions.push(depth.expr);
      }
    };
    this.series.forEach(series => noteDepth(series.depth));
    this.builtins.forEach(builtin => noteDepth(builtin.depth));
    if (this.root) {
      for (const [param] of this.paramSeriesIds) noteDepth(param.depth);
    }
    for (const [name] of this.topology.nameLocations) noteDepth(name.depth);
    if (this.root) {
      this.program.params.forEach(param => {
        if (staticBool(param.active) === null) expressions.push(param.active);
      });
    }
    this.requests.forEach(edge => {
      noteDepth(edge.depth);
      if (staticRequestContext(edge) === null) {
        expressions.push(
          edge.merge.availability,
          edge.merge.fill,
          edge.merge.ignoreInvalidSymbol,
          edge.merge.calcBarsCount,
          edge.symbol,
          edge.timeframe,
        );
      }
    });
    return expressions;
  }

  private bindingDependencies(expressions: readonly IrExpr[]): {
    names: Set<Name>;
    funcs: Set<IrFunc>;
  } {
    const names = new Set<Name>();
    const funcs = new Set<IrFunc>();
    const writes = new Map<Name, IrExpr>();
    for (const stmt of [...this.program.init, ...this.program.body]) {
      if (stmt.kind === IrKind.InitName && !writes.has(stmt.name))
        writes.set(stmt.name, stmt.value);
      if (
        stmt.kind === IrKind.Assign &&
        stmt.target.kind === IrKind.Read &&
        !writes.has(stmt.target.place.name)
      )
        writes.set(stmt.target.place.name, stmt.value);
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
            (nested.kind === IrKind.Read || nested.kind === IrKind.HistRead) &&
            nested.place.kind === PlaceKind.Name
          ) {
            scanName(nested.place.name);
          } else if (nested.kind === IrKind.CallFunc) {
            scanFunc(nested.func);
          }
        },
      });
    };
    expressions.forEach(scanExpr);
    return {names, funcs};
  }

  private lowerBindFunc(
    func: IrFunc,
    rootNames: ReadonlyMap<Name, string>,
    funcRefs: ReadonlyMap<IrFunc, string>,
  ): string[] {
    const frame = this.topology.frameByFunc.get(func);
    const fid = this.funcIds.get(func);
    const ref = funcRefs.get(func);
    if (frame === undefined || fid === undefined || ref === undefined) {
      return fatal(`unmapped binding function '${func.name}'`);
    }
    const receiver = func.callMode === 'free' ? [] : [func.receiver];
    const parameters = [...receiver, ...func.params];
    const parameterNames = argumentNames(parameters);
    const directNames = new Map(rootNames);
    parameters.forEach((param, index) =>
      directNames.set(param, parameterNames[index]),
    );
    const declarations: string[] = [];
    frame.locals.forEach((name, slot) => {
      if (directNames.has(name)) return;
      if (name.storage !== Storage.PerBar) {
        return fatal(`module binding reached persistent local '${name.name}'`);
      }
      const local = `b${fid}_${slot}`;
      directNames.set(name, local);
      declarations.push(`let ${local}!: ${this.emitter.typeOf(name.type)};`);
    });
    const ctx = {
      ...this.ctxFor(fid, directNames),
      currentResultType: func.resultType,
      binding: true,
      bindFuncRefs: funcRefs,
    } satisfies LowerCtx;
    const body: string[] = [];
    const value = lowerExpr(func.body, body, ctx);
    return [
      `function ${ref}(${parameterNames.map((name, i) => `${name}: ${this.emitter.typeOf(parameters[i].type)}`).join(', ')}): ${this.emitter.typeOf(func.resultType)} {`,
      ...indent([
        ...declarations,
        ...body,
        ...(func.body.type.kind === TypeKind.Void
          ? []
          : [`return (${coerce(value, func.body.type, func.resultType)});`]),
      ]),
      '}',
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
      const params = argumentNames(parameters);
      const directNames = new Map<Name, string>();
      parameters.forEach((param, index) => {
        if (
          param.storage === Storage.PerBar &&
          param.depth.kind === DepthKind.None
        ) {
          directNames.set(param, params[index]);
        }
      });
      const ctx = {
        ...this.ctxFor(fid, directNames),
        currentResultType: func.resultType,
      };
      const lines: string[] = [
        `function ${this.functionRef(func)}(ctx: ${this.contextName()}, frame: ${this.frameName(fid)}${params.map((p, i) => `, ${p}: ${this.emitter.typeOf(parameters[i].type)}`).join('')}): ${this.emitter.typeOf(func.resultType)} {`,
      ];
      // Arguments land in the frame so param history works like any name.
      parameters.forEach((param, i) => {
        if (directNames.has(param)) {
          return;
        }
        const where = this.topology.nameLocations.get(param);
        if (where === undefined) {
          return fatal(`unmapped param '${param.name}'`);
        }
        lines.push(
          `  ${property('frame.locals', this.localKeys.get(param)!)}.set(${params[i]});`,
        );
      });
      const bodyLines: string[] = [];
      const value = lowerExpr(func.body, bodyLines, ctx);
      lines.push(...indent(bodyLines));
      if (func.body.type.kind !== TypeKind.Void)
        lines.push(
          `  return (${coerce(value, func.body.type, func.resultType)});`,
        );
      lines.push('}');
      bodies.set(fid, lines);
    });
    return bodies;
  }

  // ---- module data ---------------------------------------------------------------

  /**
   * Describe inputs, parameters, state templates, and outputs independently of
   * any host binding. Arrow schemas are constructed from the existing projection
   * and printed as readable standard constructors in the artifact.
   *
   * @example `plot(close[3])` declares `close` and depth 3 under `inputs`,
   * plus one plot declaration under `outputs`; it allocates no live history.
   */
  private moduleFields(children: readonly {readonly resultSlot: number}[]) {
    const series: Module['inputs']['series'][number][] = this.series.map(s => ({
      id: s.id,
      name: this.seriesKeys.get(s)!,
      depth: depthOf(s.depth),
    }));
    if (this.root) {
      for (const [param] of this.paramSeriesIds) {
        series.push({
          id: null,
          name: this.seriesKeys.get(param)!,
          depth: depthOf(param.depth),
        });
      }
    }

    const builtins = this.builtins.map(
      input =>
        `{source:${json(input.source)},constant:${qualifierLE(input.qualifier, Qualifier.Simple)},empty:${this.emitter.emptyOf(input.type, 'undefined')},depth:${json(depthOf(input.depth))}}`,
    );

    const parameters = parametersOf(
      this.globalParams,
      this.emitter.nominalIds,
    ).map((parameter, pid) => {
      const param = this.globalParams[pid];
      if (param === undefined) return fatal(`missing global parameter ${pid}`);
      return {
        ...parameter,
        seriesSid: this.root ? (this.paramSeriesIds.get(param) ?? null) : null,
        active: this.root ? staticBool(param.active) : true,
      };
    });

    const fields = this.program.outputs.map(output => {
      const value = fieldOf(
        output.name,
        output.mode === 'append'
          ? {kind: TypeKind.Array, elem: output.valueType}
          : output.valueType,
        this.emitter.nominalIds,
      );
      return value.clone({
        nullable: output.mode === 'set',
        metadata: new Map([...value.metadata, ['tea:write', output.mode]]),
      });
    });
    const state = this.topology.frames.map(frame => {
      const slotCount =
        frame.children.length === 0
          ? 0
          : Math.max(...frame.children.map(child => child.slot)) + 1;
      const subs: {fid: number; name: string}[] = [];
      for (let slot = 0; slot < slotCount; slot += 1) {
        const child = frame.children.find(candidate => candidate.slot === slot);
        if (child === undefined) {
          return fatal(
            `frame ${frame.id} call-site slot ${slot} is not a frame`,
          );
        }
        subs.push({
          fid: child.frameId,
          name: this.callKeys.get(`${frame.id}:${slot}`)!,
        });
      }
      return `{locals:[${frame.locals.map(name => `{name:${json(this.localKeys.get(name)!)},storage:${json(name.storage)},depth:${json(depthOf(name.depth))},empty:${this.emitter.emptyOf(name.type, 'undefined')}}`).join(', ')}],subs:${json(subs)}}`;
    });

    const requests = this.requests.map(
      (edge, rid) =>
        `{name:${json(edge.name)},mode:${json(edge.merge.mode)},depth:${json(depthOf(edge.depth))},resultSlot:${children[rid].resultSlot},resultEmpty:${this.emitter.emptyOf(edge.captureType, 'undefined')},empty:${this.emitter.emptyOf(edge.resultType, 'undefined')},context:${json(staticRequestContext(edge))}}`,
    );

    const schema = new Schema(
      [
        ...new Set(
          series
            .map(input => input.id)
            .filter((id): id is string => id !== null),
        ),
      ].map(name => fieldOf(name, FloatType, this.emitter.nominalIds)),
    );
    return {
      inputs: {schema, series, builtins},
      parameters,
      frames: state,
      outputs: {schema: outputSchema(fields)},
      requests,
    };
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function depthOf(depth: HistoryDepth): Depth {
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
  return isHistoryOffset(value) ? value : 0;
}

function staticBool(expr: IrExpr): boolean | null {
  return expr.kind === IrKind.Const && typeof expr.value === 'boolean'
    ? expr.value
    : null;
}

function staticRequestContext(
  edge: RequestEdge,
): NonNullable<Request['context']> | null {
  const expressions = [
    edge.merge.availability,
    edge.merge.fill,
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
    availability,
    fill,
    ignoreInvalidSymbol,
    calcBarsCount,
    symbol,
    timeframe,
  ] = values;
  if (
    (availability !== 'start' && availability !== 'end') ||
    (fill !== 'carry' && fill !== 'sparse') ||
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
    availability,
    fill,
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

function constValue(v: ConstValue): Scalar {
  if (isNaValue(v)) {
    return null;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) {
    return fatal('non-finite constant reached module construction');
  }
  return v;
}

function identifier(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[A-Za-z_$]/.test(safe) ? safe : `_${safe}`;
}

function unique(name: string, used: Set<string>): string {
  let candidate = name;
  for (let index = 1; used.has(candidate); index += 1)
    candidate = `${name}_${index}`;
  used.add(candidate);
  return candidate;
}

function title(name: string): string {
  const value = identifier(name);
  return value[0].toUpperCase() + value.slice(1);
}

function argumentNames(parameters: readonly Name[]): string[] {
  return parameters.map(
    (parameter, index) => `p${index}_${identifier(parameter.name)}`,
  );
}
