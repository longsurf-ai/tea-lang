// Purpose: Lower one Tea Program to ordinary typed TypeScript using tea/runtime.

import type {Module} from '../runtime/module-binding';

import {Field, Float64, List, Schema, Struct} from 'apache-arrow';
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
  type EffectDecl,
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
  type Type,
} from '../ir/type';
import {
  builtinInputsOf,
  requestsOf,
  seriesInputsOf,
  walkIrExpr,
} from '../ir/visit';
import {isHistoryOffset, RUNTIME_ABI_VERSION} from '../runtime/module-abi';
import type {Builtin, Depth, FrameLayout, Request} from '../runtime/module-abi';
import type {Scalar} from '../runtime/value';
import type {StorageType} from '../runtime/storage-types';
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
    `const layouts = ${json(emitter.layouts)} as const;`,
    ...emitter.factories.values(),
    ...emitter.childDecls,
    ...root,
    'export default program;',
    '',
  ].join('\n');
  const values = [
    'Module',
    'Value',
    'int',
    'float',
    'bool',
    'text',
    'color',
    'enumeration',
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
    'Bool',
    'Utf8',
    'List',
    'Struct',
    'Map_',
    'TimestampMillisecond',
  ];
  const types = [
    'Context',
    'Frame',
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
        substituteNode: (_, node) =>
          ts.isStringLiteral(node) &&
          node.parent !== undefined &&
          (ts.isPropertyAssignment(node.parent) ||
            ts.isPropertySignature(node.parent)) &&
          node.parent.name === node &&
          /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.text)
            ? ts.factory.createIdentifier(node.text)
            : node,
      },
    )
    .printFile(source);
}

class ModuleEmitter {
  readonly childDecls: string[] = [];
  readonly layouts: StorageType[] = [];
  readonly types = new Map<Type, string>();
  readonly factories = new Map<number, string>();
  private readonly layoutTypes: Type[] = [];
  private childCounter = 0;

  constructor(private readonly nominalIds: ReadonlyMap<Type, string>) {}

  kindOf(type: Type): string {
    return type.kind === TypeKind.Enum || type.kind === TypeKind.Struct
      ? (this.nominalIds.get(type) ?? type.name)
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
      case TypeKind.Color:
        return 'string | null';
      case TypeKind.Enum:
        return `${type.members.map(member => json(member.name)).join(' | ')} | null`;
      case TypeKind.Struct: {
        const name = `${identifier(type.name)}Shape${this.layoutOf(type)}`;
        if (!this.types.has(type)) {
          this.types.set(type, '');
          this.types.set(
            type,
            `type ${name} = {${type.fields.map(field => `readonly ${json(field.name)}: ${this.typeOf(field.type)}`).join('; ')}};`,
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
      case TypeKind.Plot:
      case TypeKind.Hline:
        return 'number';
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
      case TypeKind.Enum:
        return `enumeration<${type.members.map(member => json(member.name)).join(' | ')}, ${json(this.kindOf(type))}>(${raw} as ${this.rawType(type)}, ${json(this.kindOf(type))})`;
      case TypeKind.Plot:
      case TypeKind.Hline:
        return `int(${raw})`;
      default:
        return `new ${this.typeOf(type)}(${raw}, ${json(this.kindOf(type))})`;
    }
  }

  emptyOf(type: Type): string {
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
        return `${this.factoryOf(type)}.empty(ctx)`;
      default:
        return this.valueOf(type, 'null');
    }
  }

  factoryOf(type: Type): string {
    const id = this.layoutOf(type);
    const name = `${type.kind === TypeKind.Struct ? identifier(type.name) : type.kind}Type${id}`;
    if (!this.factories.has(id)) {
      let expression: string;
      switch (type.kind) {
        case TypeKind.Struct:
          this.rawType(type);
          expression = `struct<${identifier(type.name)}Shape${id}, ${json(this.kindOf(type))}>(${id}, ${json(this.kindOf(type))})`;
          break;
        case TypeKind.Array:
          expression = `array<${this.typeOf(type.elem)}>(${id})`;
          break;
        case TypeKind.Matrix:
          expression = `matrix<${this.typeOf(type.elem)}>(${id})`;
          break;
        case TypeKind.Map:
          expression = `map<${this.typeOf(type.key)}, ${this.typeOf(type.value)}>(${id})`;
          break;
        case TypeKind.Tuple:
          expression = `tuple<readonly [${type.elems.map(type => this.typeOf(type)).join(', ')}]>(${id})`;
          break;
        default:
          return fatal(`no aggregate factory for ${type.kind}`);
      }
      this.factories.set(id, `const ${name} = ${expression};`);
    }
    return name;
  }

  layoutOf(type: Type): number {
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

  private buildLayout(type: Type): StorageType {
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
          ...(this.nominalIds.has(type)
            ? {typeId: this.nominalIds.get(type)}
            : {}),
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
          ...(this.nominalIds.has(type)
            ? {typeId: this.nominalIds.get(type)}
            : {}),
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
  private readonly outputIds = new Map<OutputDecl | EffectDecl, number>();
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
    program.effects.forEach((effect, eid) =>
      this.outputIds.set(effect, program.outputs.length + eid),
    );
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
  // complete Module; the request tree shares the one emitted layout table.
  moduleBody(): string[] {
    // Frame ownership and call sites already come from frameTopologyOf().
    // Lower code first to collect its helpers and physical value layouts,
    // then assemble the preparation description using those same IDs.
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
      `  inputs: {\n    schema: ${schemaSource(data.inputs.schema)},\n    series: ${json(data.inputs.series)},\n    builtins: ${json(data.inputs.builtins)},\n  },`,
    );
    out.push(`  parameters: ${json(data.parameters)},`);
    out.push(
      `  state: {\n    layout: layouts,\n    frames: ${json(data.frames)},\n  },`,
    );
    out.push(
      `  outputs: {\n    schema: ${schemaSource(data.outputs.schema)},\n    declarations: ${json(data.outputs.declarations)},\n  },`,
    );
    out.push(
      `  requests: [${data.requests.map((request, id) => `${json(request).slice(0, -1)}, "module": ${children[id].ref}}`).join(', ')}],`,
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
        `type ${this.frameName(frame.id)} = Frame<{${frame.locals.map(name => `readonly ${json(this.localKeys.get(name))}: ${this.emitter.typeOf(name.type, 'Series')}`).join('; ')}}, {${frame.children.map(child => `readonly ${json(this.callKeys.get(`${frame.id}:${child.slot}`))}: ${this.frameName(child.frameId)}`).join('; ')}}>;`,
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
    const outputs = [
      ...this.program.outputs.map(
        (output, id) =>
          `readonly output${id}: {set(value: {${output.channels.map(channel => `readonly ${json(channel.name)}: ${this.emitter.typeOf(channel.type)}`).join('; ')}}): void}`,
      ),
      ...this.program.effects.map(
        (effect, id) =>
          `readonly effect${id}: {append(value: ${this.emitter.typeOf(effect.payloadType)}): void}`,
      ),
    ];
    out.push(
      `export type ${this.contextName()} = Context<{${params.join('; ')}}, {readonly series: {${series.join('; ')}}; readonly builtins: {${builtins.join('; ')}}; readonly children: {${children.join('; ')}}}, ${this.frameName(0)}, {${outputs.join('; ')}}>;`,
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
      stmt =>
        (stmt.kind === IrKind.InitName || stmt.kind === IrKind.WriteName) &&
        dependencies.names.has(stmt.name) &&
        qualifierLE(stmt.name.qualifier, Qualifier.Simple),
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
    this.program.outputs.forEach((output, oid) => {
      if (staticOutputArgs(output, this.outputIds) !== null) {
        captureArguments(
          output.bindArgs.map(arg => arg.expr),
          output.bindArgumentEvaluationOrder,
          [],
          validationCtx,
          `output '${output.effect}' bind arguments`,
        );
        return;
      }
      resets.push(`module.outputs.declarations[${oid}].args = null;`);
      const args = captureArguments(
        output.bindArgs.map(arg => arg.expr),
        output.bindArgumentEvaluationOrder,
        lines,
        ctx,
        `output '${output.effect}' bind arguments`,
      );
      const entries = [
        ...output.staticArgs.map(arg =>
          json({name: arg.name, value: constValue(arg.value)}),
        ),
        ...output.bindArgs.map(
          (arg, index) =>
            `{name: ${JSON.stringify(arg.name)}, value: (${args[index]}).value}`,
        ),
      ];
      lines.push(
        `module.outputs.declarations[${oid}].args = [${entries.join(', ')}];`,
      );
    });
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
    this.program.outputs.forEach(output => {
      if (staticOutputArgs(output, this.outputIds) === null) {
        output.bindArgs.forEach(arg => expressions.push(arg.expr));
      }
    });
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
        `return (${coerce(value, func.body.type, func.resultType)});`,
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
      const ctx = this.ctxFor(fid, directNames);
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

    const builtins: Builtin[] = this.builtins.map(input => ({
      source: input.source,
      constant: qualifierLE(input.qualifier, Qualifier.Simple),
      layout: this.emitter.layoutOf(input.type),
      depth: depthOf(input.depth),
    }));

    const parameters = parametersOf(
      this.globalParams,
      this.program.nominalIds,
    ).map((parameter, pid) => {
      const param = this.globalParams[pid];
      if (param === undefined) return fatal(`missing global parameter ${pid}`);
      return {
        ...parameter,
        seriesSid: this.root ? (this.paramSeriesIds.get(param) ?? null) : null,
        active: this.root ? staticBool(param.active) : true,
      };
    });

    const fields = [
      ...this.program.outputs.map(
        (output, oid) =>
          new Field(
            `output${oid}`,
            new Struct(
              output.channels.map(channel =>
                fieldOf(channel.name, channel.type, this.program.nominalIds),
              ),
            ),
            true,
            new Map([
              ['tea:write', 'set'],
              ['tea:kind', output.effect],
            ]),
          ),
      ),
      ...this.program.effects.map(
        (effect, eid) =>
          new Field(
            `effect${eid}`,
            new List(
              new Field(
                'item',
                new Struct([
                  new Field('ordinal', new Float64(), false),
                  fieldOf(
                    'payload',
                    effect.payloadType,
                    this.program.nominalIds,
                  ),
                ]),
                false,
              ),
            ),
            false,
            new Map([
              ['tea:write', 'append'],
              ['tea:kind', 'event'],
            ]),
          ),
      ),
    ];
    const declarations = [
      ...this.program.outputs.map(output => ({
        args: staticOutputArgs(output, this.outputIds),
        layouts: output.channels.map(channel =>
          channel.type.kind === TypeKind.Plot ||
          channel.type.kind === TypeKind.Hline
            ? -1
            : this.emitter.layoutOf(channel.type),
        ),
      })),
      ...this.program.effects.map(effect => ({
        args: [],
        layouts: [this.emitter.layoutOf(effect.payloadType)],
      })),
    ];

    const state: FrameLayout[] = this.topology.frames.map(frame => {
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
      return {
        locals: frame.locals.map(name => ({
          name: this.localKeys.get(name)!,
          storage: name.storage,
          depth: depthOf(name.depth),
          layout: this.emitter.layoutOf(name.type),
        })),
        subs,
      };
    });

    const requests = this.requests.map((edge, rid) => {
      return {
        name: edge.name,
        mode: edge.merge.mode,
        depth: depthOf(edge.depth),
        resultSlot: children[rid].resultSlot,
        resultLayout: this.emitter.layoutOf(edge.captureType),
        layout: this.emitter.layoutOf(edge.resultType),
        context: staticRequestContext(edge),
      };
    });

    const schema = new Schema(
      [
        ...new Set(
          series
            .map(input => input.id)
            .filter((id): id is string => id !== null),
        ),
      ].map(name => fieldOf(name, FloatType, this.program.nominalIds)),
    );
    return {
      inputs: {schema, series, builtins},
      parameters,
      frames: state,
      outputs: {schema: outputSchema(fields), declarations},
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

function staticOutputArgs(
  output: OutputDecl,
  ids: ReadonlyMap<OutputDecl | EffectDecl, number>,
): readonly {readonly name: string; readonly value: Scalar}[] | null {
  const args = output.staticArgs.map(arg => ({
    name: arg.name,
    value: constValue(arg.value),
  }));
  for (const {name, expr} of output.bindArgs) {
    if (expr.kind === IrKind.OutputRef) {
      const value = ids.get(expr.output);
      if (value === undefined) return fatal('unmapped output reference');
      args.push({name, value});
    } else if (
      expr.kind === IrKind.Const &&
      !isNaValue(expr.value) &&
      (typeof expr.value !== 'number' || Number.isFinite(expr.value))
    ) {
      args.push({name, value: constValue(expr.value)});
    } else return null;
  }
  return args;
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
  const used = new Set(
    'ctx frame this super return function const let var new class for while switch if else break continue import export default await yield delete void typeof in instanceof true false null'.split(
      ' ',
    ),
  );
  return parameters.map(parameter => unique(identifier(parameter.name), used));
}
