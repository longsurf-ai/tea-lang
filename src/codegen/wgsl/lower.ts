// Purpose: Compile a generic Tea Program into one reusable, bind-independent WGSL artifact.

import type {Pos} from '../../base/pos';
import {formatPos} from '../../base/pos';
import {fatal} from '../../base/print';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  type HistReadExpr,
  type IrExpr,
  type IrStmt,
  type IrValuePath,
  type Name,
} from '../../ir/node';
import type {
  EffectDecl,
  EffectValueSchema,
  ExecutionInput,
  IrFunc,
  OutputDecl,
  ParamInput,
  Program,
  SeriesInput,
} from '../../ir/program';
import {
  assignable,
  formatType,
  isNaValue,
  TypeKind,
  typesEqual,
  type EnumType,
  type ConstValue,
  type Type,
  type UserType,
} from '../../ir/type';
import {
  executionInputsOf,
  funcsOf,
  namesOf,
  seriesInputsOf,
  slotCountOf,
} from '../../ir/visit';
import {paramSpecsOf} from '../../runtime/params';
import type {
  CompiledWgslProgram,
  WgslCompilationResult,
  WgslEligibilityIssue,
  WgslEligibilityIssueCode,
  WgslNumericContract,
  WgslPhysicalField,
  WgslPhysicalLayout,
  WgslProgramInventory,
  WgslResultChannel,
  WgslEffectSchema,
  WgslModule,
  WgslOutputSchema,
  WgslValueSchema,
} from './types';
import {
  analyzeWgslEffects,
  WgslEffectAnalysisError,
  type WgslEffectAnalysis,
} from './effects-analysis';

const WORKGROUP_SIZE = 64;
const JOB_DESCRIPTOR_BYTES = 32;
const RESULT_CELL_BYTES = 8;
const EFFECT_STATUS_BYTES = 16;
const GPU_BUFFER_GROUP = 0;
const GPU_JOBS_BINDING = 0;
const GPU_SERIES_BINDING = 1;
const GPU_LANE_STATES_BINDING = 2;
const GPU_RESULTS_BINDING = 3;
const GPU_EFFECT_STATUS_BINDING = 4;
const GPU_EFFECT_RECORDS_BINDING = 5;
const GPU_PARAMS_BINDING = 6;
const JOB_SERIES_OFFSET = 0;
const JOB_ROW_COUNT_OFFSET = 4;
const JOB_RESULT_OFFSET = 8;
const JOB_RESULT_COUNT_OFFSET = 12;
const JOB_EFFECT_OFFSET = 16;
const JOB_EFFECT_CAPACITY_OFFSET = 20;
const JOB_CHUNK_ROWS_OFFSET = 24;
const JOB_PARAMS_OFFSET = 28;
const F32_ABSOLUTE_TOLERANCE = 0.0001;
const F32_RELATIVE_TOLERANCE = 0.00002;

export const WGSL_F32_NUMERIC_CONTRACT: WgslNumericContract = Object.freeze({
  float: 'f32',
  integer: 'i32',
  boolean: 'u32-zero-or-one',
  nullable: 'tagged-u32',
  integerOverflow: 'wrap',
  divideByZero: 'tea-na',
  nonFiniteFloat: 'tea-na',
  cpuTolerance: Object.freeze({
    absolute: F32_ABSOLUTE_TOLERANCE,
    relative: F32_RELATIVE_TOLERANCE,
  }),
});

class UnsupportedGpuSubsetError extends Error {
  constructor(
    readonly code: WgslEligibilityIssueCode,
    message: string,
    readonly pos?: Pos,
  ) {
    super(message);
    this.name = 'UnsupportedGpuSubsetError';
  }
}

export function compileProgramToWgsl(program: Program): WgslCompilationResult {
  const inventory = inventoryOf(program);
  try {
    const artifact = new WgslEmitter(program).compile();
    return {
      status: 'compiled',
      eligibility: {eligible: true, inventory, issues: []},
      artifact,
    };
  } catch (error) {
    if (error instanceof WgslEffectAnalysisError) {
      error = new UnsupportedGpuSubsetError(
        'effect-transport-lowering-unimplemented',
        error.message,
        error.pos,
      );
    }
    if (!(error instanceof UnsupportedGpuSubsetError)) {
      throw error;
    }
    return {
      status: 'staged-unsupported',
      eligibility: {
        eligible: false,
        inventory,
        issues: [issueOf(error)],
      },
      artifact: null,
    };
  }
}

function issueOf(error: UnsupportedGpuSubsetError): WgslEligibilityIssue {
  return {
    code: error.code,
    phase: 'wgsl-emission',
    message: error.message,
    occurrences: 1,
    firstLocation:
      error.pos === undefined
        ? null
        : {
            filename: error.pos.base.filename,
            line: error.pos.line,
            column: error.pos.col,
          },
  };
}

function inventoryOf(program: Program): WgslProgramInventory {
  const funcs = funcsOf(program);
  return {
    parameterCount: program.params.length,
    requestCount: program.requests.length,
    seriesInputCount: seriesInputsOf(program).length,
    executionInputCount: executionInputsOf(program).length,
    persistentRootCount: namesOf(program).filter(
      name => name.storage === 'var' || name.storage === 'varip',
    ).length,
    functionCount: funcs.length,
    mutableMethodCount: funcs.filter(func => func.callMode === 'mutable-method')
      .length,
    callSiteSlotCount: slotCountOf(program),
    outputCount: program.outputs.length,
    resultChannelCount: program.body.filter(stmt => stmt.kind === IrKind.Emit)
      .length,
  };
}

// The emitter follows below. It never inspects source package paths or
// component type names; all identities come from canonical Program objects.
class WgslEmitter {
  private readonly program: Program;
  private readonly series: readonly SeriesInput[];
  private readonly seriesIds = new Map<SeriesInput, number>();
  private readonly paramIds = new Map<ParamInput, number>();
  private readonly outputCells = new Map<OutputDecl, number>();
  private readonly effectIds = new Map<EffectDecl, number>();
  private readonly literalStringIds = new Map<string, number>();
  private readonly literalStrings: string[] = [];
  private readonly enumNames = new Map<EnumType, string>();
  private readonly userNames = new Map<UserType, string>();
  private readonly enumTypes: EnumType[] = [];
  private readonly userTypes: UserType[] = [];
  private readonly layouts: WgslPhysicalLayout[] = [];
  private readonly physicalIds = new Map<Type, number>();
  private readonly functionNames = new Set<Name>();
  private readonly persistentRoots: Name[];
  private readonly perBarRoots: Name[];
  private readonly funcs: readonly IrFunc[];
  private readonly funcNames = new Map<IrFunc, string>();
  private readonly mutableResultNames = new Map<IrFunc, string>();
  private readonly effectAnalysis: WgslEffectAnalysis;
  private temp = 0;
  private jobDescriptorLayout = -1;
  private laneStateLayout = -1;
  private seriesScalarLayout = -1;
  private parameterLayout = -1;
  private resultCellLayout = -1;
  private effectStatusLayout = -1;
  private effectRecordLayout = -1;
  private maxEffectPayloadWords = 0;

  constructor(program: Program) {
    this.program = program;
    this.effectAnalysis = analyzeWgslEffects(program);
    this.effectAnalysis.literalStrings.forEach(value =>
      this.internLiteralString(value),
    );
    program.effects.forEach((effect, index) => {
      this.effectIds.set(effect, index);
      this.collectType(effect.payloadType);
    });
    this.funcs = funcsOf(this.program);
    this.funcs.forEach((func, index) => {
      this.funcNames.set(func, `tea_fn_${index}`);
      if (func.callMode === 'mutable-method') {
        this.mutableResultNames.set(func, `TeaMutableResult${index}`);
      }
    });
    this.series = seriesInputsOf(this.program);
    if (this.series.length === 0) {
      this.unsupported(
        'series-row-count-unavailable',
        'the current GPU job contract derives row count from numeric series inputs',
      );
    }
    this.series.forEach((series, index) => this.seriesIds.set(series, index));
    this.program.params.forEach((param, index) => {
      this.paramIds.set(param, index);
      if (param.defaultValue?.kind === 'series') {
        this.unsupported(
          'parameter-packing-unimplemented',
          `GPU fixed-width parameters do not support source parameter '${param.name}'`,
          param.active.pos,
        );
      }
      if (
        param.type.kind !== TypeKind.Int &&
        param.type.kind !== TypeKind.Float &&
        param.type.kind !== TypeKind.Bool &&
        param.type.kind !== TypeKind.Enum
      ) {
        this.unsupported(
          'parameter-packing-unimplemented',
          `GPU fixed-width parameters do not support '${param.name}' of type ${formatType(param.type)}`,
          param.active.pos,
        );
      }
      if (
        param.active.kind !== IrKind.Const ||
        typeof param.active.value !== 'boolean'
      ) {
        this.unsupported(
          'bind-stage-unimplemented',
          `GPU parameters require a const bool active expression; '${param.name}' is bind-computed`,
          param.active.pos,
        );
      }
    });
    for (const func of this.funcs) {
      if (func.callMode !== 'free') {
        this.functionNames.add(func.receiver);
      }
      for (const name of [...func.params, ...func.locals]) {
        this.functionNames.add(name);
      }
    }
    const roots = namesOf(this.program).filter(
      name => !this.functionNames.has(name),
    );
    const packageGlobals = new Set(this.program.packageGlobals);
    this.persistentRoots = [
      ...this.program.packageGlobals,
      ...roots
        .filter(name => name.storage === 'var' && !packageGlobals.has(name))
        .sort(compareInitializers),
    ];
    this.perBarRoots = roots.filter(name => name.storage === 'perBar');
    for (const root of this.persistentRoots) {
      if (root.init !== null && initializerDependsOnCurrentRow(root.init)) {
        this.unsupported(
          'persistent-state-initialization-unimplemented',
          `persistent root '${root.name}' initializer depends on current-row data`,
          root.init.pos,
        );
      }
    }
    for (const name of roots) {
      if (name.storage === 'varip') {
        this.unsupported(
          'persistent-state-initialization-unimplemented',
          'varip execution is not part of the historical one-pass GPU subset',
          name.init?.pos,
        );
      }
      this.requireDepthNone(name.depth.kind, `name '${name.name}'`);
      this.collectType(name.type);
    }
    for (const func of this.funcs) {
      this.collectFunctionTypes(func);
    }
    for (const root of roots) {
      if (root.init !== null) {
        this.collectExpressionTypes(root.init);
      }
    }
    for (const func of this.funcs) {
      this.collectExpressionTypes(func.body);
    }
    for (const stmt of [...this.program.init, ...this.program.body]) {
      walkStmtChildren(
        stmt,
        expr => this.collectExpressionType(expr),
        () => {},
      );
    }
    for (const series of this.series) {
      if (series.type.kind !== TypeKind.Float) {
        this.unsupported(
          'host-value-type-unsupported',
          `GPU numeric series '${series.id}' has unsupported type ${formatType(series.type)}`,
        );
      }
      this.requireDepthNone(series.depth.kind, `series '${series.id}'`);
    }
    this.validateOutputs();
    this.validateCallGraph();
  }

  compile(): CompiledWgslProgram {
    if (this.program.requests.length > 0) {
      this.unsupported(
        'request-execution-unimplemented',
        'GPU request child contexts are not implemented in this subset',
      );
    }
    if (this.program.init.length > 0) {
      this.unsupported(
        'bind-stage-unimplemented',
        'Program.init is not implemented in the one-pass GPU subset',
      );
    }
    this.buildPhysicalLayouts();
    const source = this.emitModule();
    const module: WgslModule = {
      language: 'wgsl',
      source,
      entryPoint: 'tea_main',
    };
    return {
      target: 'webgpu-wgsl',
      numeric: WGSL_F32_NUMERIC_CONTRACT,
      module,
      layouts: this.layouts,
      workgroupSize: [WORKGROUP_SIZE, 1, 1],
      externalBuffers: {
        group: GPU_BUFFER_GROUP,
        jobsBinding: GPU_JOBS_BINDING,
        seriesBinding: GPU_SERIES_BINDING,
        laneStatesBinding: GPU_LANE_STATES_BINDING,
        resultsBinding: GPU_RESULTS_BINDING,
        effectStatusBinding: GPU_EFFECT_STATUS_BINDING,
        effectRecordsBinding: GPU_EFFECT_RECORDS_BINDING,
        paramsBinding: GPU_PARAMS_BINDING,
      },
      jobDescriptorLayout: this.jobDescriptorLayout,
      jobDescriptorByteStride: JOB_DESCRIPTOR_BYTES,
      jobDescriptorOffsets: {
        seriesOffset: JOB_SERIES_OFFSET,
        rowCount: JOB_ROW_COUNT_OFFSET,
        resultOffset: JOB_RESULT_OFFSET,
        resultCount: JOB_RESULT_COUNT_OFFSET,
        effectOffset: JOB_EFFECT_OFFSET,
        effectCapacity: JOB_EFFECT_CAPACITY_OFFSET,
        chunkRows: JOB_CHUNK_ROWS_OFFSET,
        paramsOffset: JOB_PARAMS_OFFSET,
      },
      parameterLayout: this.parameterLayout,
      parameterByteStride: this.layouts[this.parameterLayout].byteSize,
      laneStateLayout: this.laneStateLayout,
      laneStateByteStride: this.layouts[this.laneStateLayout].byteSize,
      seriesScalarLayout: this.seriesScalarLayout,
      seriesScalarByteStride: 4,
      resultCellLayout: this.resultCellLayout,
      resultCellByteStride: RESULT_CELL_BYTES,
      effectStatusLayout: this.effectStatusLayout,
      effectStatusByteStride: EFFECT_STATUS_BYTES,
      effectRecordLayout: this.effectRecordLayout,
      effectRecordByteStride: this.layouts[this.effectRecordLayout].byteSize,
      effectPayloadWordCapacity: Math.max(1, this.maxEffectPayloadWords),
      maxEffectsPerRow: this.effectAnalysis.maxEffectsPerRow,
      literalStrings: this.literalStrings,
      params: paramSpecsOf(this.program.params),
      paramActive: this.program.params.map(param =>
        param.active.kind === IrKind.Const &&
        typeof param.active.value === 'boolean'
          ? param.active.value
          : fatal(
              `GPU parameter '${param.name}' active contract changed after validation`,
            ),
      ),
      requiredSeries: this.series.map(series => ({id: series.id})),
      resultChannels: this.resultChannels(),
      outputSchemas: this.outputSchemas(),
      effectSchemas: this.effectSchemas(),
    };
  }

  private unsupported(
    code: WgslEligibilityIssueCode,
    message: string,
    pos?: Pos,
  ): never {
    throw new UnsupportedGpuSubsetError(code, message, pos);
  }

  private requireDepthNone(kind: string, owner: string): void {
    if (kind !== DepthKind.None) {
      this.unsupported(
        'history-layout-unimplemented',
        `${owner} requires history; the executable GPU subset is current-row only`,
      );
    }
  }

  private collectFunctionTypes(func: IrFunc): void {
    if (func.callMode !== 'free') {
      this.collectType(func.receiver.type);
    }
    for (const name of [...func.params, ...func.locals]) {
      this.collectType(name.type);
      if (name.storage !== 'perBar' || name.init !== null) {
        this.unsupported(
          'function-frame-lowering-unimplemented',
          'inlined GPU functions cannot own persistent locals or initializers',
          name.init?.pos,
        );
      }
      this.requireDepthNone(name.depth.kind, `function name '${name.name}'`);
    }
    this.collectType(func.resultType);
  }

  private collectExpressionTypes(expr: IrExpr): void {
    walkExpr(expr, node => this.collectExpressionType(node));
  }

  private collectExpressionType(expr: IrExpr): void {
    this.collectType(expr.type);
    if (
      expr.kind === IrKind.Const &&
      expr.type.kind === TypeKind.String &&
      typeof expr.value === 'string'
    ) {
      this.internLiteralString(expr.value);
    }
    if (expr.kind === IrKind.NewUserValue) {
      this.collectType(expr.userType);
    }
  }

  private collectType(type: Type, visiting = new Set<Type>()): void {
    switch (type.kind) {
      case TypeKind.Int:
      case TypeKind.Float:
      case TypeKind.Bool:
      case TypeKind.String:
      case TypeKind.Color:
      case TypeKind.Void:
        return;
      case TypeKind.Enum:
        if (!this.enumNames.has(type)) {
          const name = `TeaE${this.enumNames.size}`;
          this.enumNames.set(type, name);
          this.enumTypes.push(type);
        }
        return;
      case TypeKind.UserType:
        if (this.userNames.has(type)) {
          return;
        }
        if (visiting.has(type)) {
          this.unsupported(
            'user-value-layout-unimplemented',
            'recursive by-value user types cannot be lowered to WGSL',
          );
        }
        this.userNames.set(type, `TeaU${this.userNames.size}`);
        visiting.add(type);
        for (const field of type.fields) {
          this.collectType(field.type, visiting);
        }
        visiting.delete(type);
        this.userTypes.push(type);
        return;
      case TypeKind.Na:
        this.unsupported(
          'nullable-value-layout-unimplemented',
          'an uncontextualized na type cannot enter GPU lowering',
        );
      case TypeKind.Array:
      case TypeKind.Matrix:
      case TypeKind.Map:
        this.unsupported(
          'collection-layout-unimplemented',
          `GPU collection layout is unsupported for ${formatType(type)}`,
        );
      case TypeKind.Tuple:
        this.unsupported(
          'tuple-layout-unimplemented',
          `GPU tuple layout is unsupported for ${formatType(type)}`,
        );
      default:
        this.unsupported(
          'host-value-type-unsupported',
          `GPU value layout is unsupported for ${formatType(type)}`,
        );
    }
  }

  private validateOutputs(): void {
    const directEmits = new Map<OutputDecl, number>();
    for (const stmt of this.program.body) {
      if (stmt.kind === IrKind.Emit) {
        directEmits.set(stmt.output, (directEmits.get(stmt.output) ?? 0) + 1);
      } else {
        this.rejectNestedEmit(stmt);
      }
    }
    this.resultOutputs().forEach(({output, outputId}, rowCell) => {
      if (output.bindArgs.length > 0) {
        this.unsupported(
          'result-transport-lowering-unimplemented',
          `output ${outputId} has bind-time arguments`,
        );
      }
      if (output.channels.length !== 1) {
        this.unsupported(
          'result-transport-lowering-unimplemented',
          `output ${outputId} must have exactly one scalar channel`,
        );
      }
      const channel = output.channels[0];
      if (!isGpuResultType(channel.type)) {
        this.unsupported(
          'result-transport-lowering-unimplemented',
          `output ${outputId} channel has unsupported type ${formatType(channel.type)}`,
        );
      }
      this.collectType(channel.type);
      if (directEmits.get(output) !== 1) {
        this.unsupported(
          'result-transport-lowering-unimplemented',
          `output ${outputId} must have one unconditional top-level emission`,
        );
      }
      this.outputCells.set(output, rowCell);
    });
    for (const output of directEmits.keys()) {
      if (!this.outputCells.has(output)) {
        this.unsupported(
          'result-transport-lowering-unimplemented',
          'the Program emits an output outside Program.outputs',
        );
      }
    }
  }

  private rejectNestedEmit(stmt: IrStmt): void {
    walkStmt(stmt, node => {
      if (node.kind === IrKind.Emit) {
        this.unsupported(
          'result-transport-lowering-unimplemented',
          'conditional or nested GPU result emissions are unsupported',
          node.pos,
        );
      }
    });
  }

  private validateCallGraph(): void {
    const state = new Map<IrFunc, 'visiting' | 'done'>();
    const visit = (func: IrFunc): void => {
      const previous = state.get(func);
      if (previous === 'done') {
        return;
      }
      if (previous === 'visiting') {
        this.unsupported(
          'function-frame-lowering-unimplemented',
          `recursive call graph reaches '${func.name}'`,
        );
      }
      state.set(func, 'visiting');
      walkExpr(func.body, expr => {
        if (
          expr.kind === IrKind.CallFunc ||
          expr.kind === IrKind.CallConstMethod ||
          expr.kind === IrKind.CallMutableMethod
        ) {
          if (!this.funcNames.has(expr.func)) {
            this.unsupported(
              'function-frame-lowering-unimplemented',
              `call to '${expr.func.name}' is outside the closed Program call graph`,
              expr.pos,
            );
          }
          visit(expr.func);
        }
      });
      state.set(func, 'done');
    };
    for (const func of this.funcs) {
      visit(func);
    }
  }

  private buildPhysicalLayouts(): void {
    for (const type of this.enumTypes) {
      this.physicalLayoutOf(type);
    }
    for (const type of this.userTypes) {
      this.physicalLayoutOf(type);
    }
    for (const root of this.persistentRoots) {
      this.physicalLayoutOf(root.type);
    }
    for (const effect of this.program.effects) {
      const layout = this.layouts[this.physicalLayoutOf(effect.payloadType)];
      this.maxEffectPayloadWords = Math.max(
        this.maxEffectPayloadWords,
        layout.byteSize / 4,
      );
    }
    const laneFields: WgslPhysicalField[] = [
      {path: 'initialized', scalar: 'u32', byteOffset: 0},
      {path: 'next_row', scalar: 'u32', byteOffset: 4},
    ];
    let laneOffset = 8;
    this.persistentRoots.forEach((root, index) => {
      const layout = this.layouts[this.physicalLayoutOf(root.type)];
      for (const field of layout.fields) {
        laneFields.push({
          path: `r${index}.${field.path}`,
          scalar: field.scalar,
          byteOffset: laneOffset + field.byteOffset,
        });
      }
      laneOffset += layout.byteSize;
    });
    this.laneStateLayout = this.addLayout(
      'TeaLaneState',
      laneOffset,
      laneFields,
    );
    this.jobDescriptorLayout = this.addLayout(
      'TeaJobDescriptor',
      JOB_DESCRIPTOR_BYTES,
      [
        {path: 'series_offset', scalar: 'u32', byteOffset: JOB_SERIES_OFFSET},
        {path: 'row_count', scalar: 'u32', byteOffset: JOB_ROW_COUNT_OFFSET},
        {path: 'result_offset', scalar: 'u32', byteOffset: JOB_RESULT_OFFSET},
        {
          path: 'result_count',
          scalar: 'u32',
          byteOffset: JOB_RESULT_COUNT_OFFSET,
        },
        {
          path: 'effect_offset',
          scalar: 'u32',
          byteOffset: JOB_EFFECT_OFFSET,
        },
        {
          path: 'effect_capacity',
          scalar: 'u32',
          byteOffset: JOB_EFFECT_CAPACITY_OFFSET,
        },
        {
          path: 'chunk_rows',
          scalar: 'u32',
          byteOffset: JOB_CHUNK_ROWS_OFFSET,
        },
        {
          path: 'params_offset',
          scalar: 'u32',
          byteOffset: JOB_PARAMS_OFFSET,
        },
      ],
    );
    this.seriesScalarLayout = this.addLayout('TeaSeriesScalar', 4, [
      {path: 'value', scalar: 'f32', byteOffset: 0},
    ]);
    this.parameterLayout = this.addLayout('TeaParameterScalar', 4, [
      {path: 'bits', scalar: 'u32', byteOffset: 0},
    ]);
    this.resultCellLayout = this.addLayout('TeaResultCell', RESULT_CELL_BYTES, [
      {path: 'bits', scalar: 'u32', byteOffset: 0},
      {path: 'valid', scalar: 'u32', byteOffset: 4},
    ]);
    this.effectStatusLayout = this.addLayout(
      'TeaEffectStatus',
      EFFECT_STATUS_BYTES,
      [
        {path: 'count', scalar: 'u32', byteOffset: 0},
        {path: 'overflow', scalar: 'u32', byteOffset: 4},
        {path: 'first_overflow_row', scalar: 'u32', byteOffset: 8},
        {path: 'first_overflow_effect', scalar: 'u32', byteOffset: 12},
      ],
    );
    const effectFields: WgslPhysicalField[] = [
      {path: 'row', scalar: 'u32', byteOffset: 0},
      {path: 'effect_id', scalar: 'u32', byteOffset: 4},
    ];
    for (
      let index = 0;
      index < Math.max(1, this.maxEffectPayloadWords);
      index += 1
    ) {
      effectFields.push({
        path: `payload.${index}`,
        scalar: 'u32',
        byteOffset: 8 + index * 4,
      });
    }
    this.effectRecordLayout = this.addLayout(
      'TeaEffectRecord',
      8 + Math.max(1, this.maxEffectPayloadWords) * 4,
      effectFields,
    );
  }

  private physicalLayoutOf(type: Type): number {
    const existing = this.physicalIds.get(type);
    if (existing !== undefined) {
      return existing;
    }
    let name: string;
    let byteSize: number;
    let fields: WgslPhysicalField[];
    switch (type.kind) {
      case TypeKind.Bool:
        name = 'TeaBool';
        byteSize = 4;
        fields = [{path: 'value', scalar: 'u32', byteOffset: 0}];
        break;
      case TypeKind.Float:
        name = 'TeaFloat';
        byteSize = 8;
        fields = [
          {path: 'valid', scalar: 'u32', byteOffset: 0},
          {path: 'value', scalar: 'f32', byteOffset: 4},
        ];
        break;
      case TypeKind.Int:
        name = 'TeaInt';
        byteSize = 8;
        fields = [
          {path: 'valid', scalar: 'u32', byteOffset: 0},
          {path: 'value', scalar: 'i32', byteOffset: 4},
        ];
        break;
      case TypeKind.String:
        name = 'TeaString';
        byteSize = 8;
        fields = [
          {path: 'valid', scalar: 'u32', byteOffset: 0},
          {path: 'value', scalar: 'u32', byteOffset: 4},
        ];
        break;
      case TypeKind.Color:
        name = 'TeaColor';
        byteSize = 8;
        fields = [
          {path: 'valid', scalar: 'u32', byteOffset: 0},
          {path: 'value', scalar: 'u32', byteOffset: 4},
        ];
        break;
      case TypeKind.Enum:
        name = this.enumNames.get(type) ?? 'TeaEnum';
        byteSize = 8;
        fields = [
          {path: 'valid', scalar: 'u32', byteOffset: 0},
          {path: 'ordinal', scalar: 'u32', byteOffset: 4},
        ];
        break;
      case TypeKind.UserType: {
        name = this.userNames.get(type) ?? fatal('unmapped GPU user type');
        byteSize = 4;
        fields = [{path: 'valid', scalar: 'u32', byteOffset: 0}];
        type.fields.forEach((field, index) => {
          const nested = this.layouts[this.physicalLayoutOf(field.type)];
          for (const leaf of nested.fields) {
            fields.push({
              path: `f${index}.${leaf.path}`,
              scalar: leaf.scalar,
              byteOffset: byteSize + leaf.byteOffset,
            });
          }
          byteSize += nested.byteSize;
        });
        break;
      }
      default:
        return this.unsupported(
          'host-value-type-unsupported',
          `no GPU physical layout for ${formatType(type)}`,
        );
    }
    const id = this.addLayout(name, byteSize, fields);
    this.physicalIds.set(type, id);
    return id;
  }

  private addLayout(
    name: string,
    byteSize: number,
    fields: readonly WgslPhysicalField[],
  ): number {
    const id = this.layouts.length;
    this.layouts.push({id, name, byteSize, byteAlignment: 4, fields});
    return id;
  }

  private emitModule(): string {
    const out: string[] = [
      'struct TeaFloat { valid: u32, value: f32, }',
      'struct TeaInt { valid: u32, value: i32, }',
      'struct TeaEnum { valid: u32, value: u32, }',
      'struct TeaString { valid: u32, value: u32, }',
      'struct TeaColor { valid: u32, value: u32, }',
    ];
    for (const type of this.userTypes) {
      const name = this.userName(type);
      out.push(`struct ${name} {`);
      out.push('  valid: u32,');
      type.fields.forEach((field, index) => {
        out.push(`  f${index}: ${this.wgslType(field.type)},`);
      });
      out.push('}');
    }
    for (const func of this.funcs) {
      if (func.callMode !== 'mutable-method') {
        continue;
      }
      out.push(
        `struct ${this.mutableResultName(func)} {`,
        `  receiver: ${this.wgslType(func.receiver.type)},`,
        `  result: ${this.wgslType(func.resultType)},`,
        '}',
      );
    }
    out.push('struct TeaLaneState {');
    out.push('  initialized: u32,', '  next_row: u32,');
    this.persistentRoots.forEach((root, index) => {
      out.push(`  r${index}: ${this.wgslType(root.type)},`);
    });
    out.push(
      '}',
      'struct TeaJobDescriptor {',
      '  series_offset: u32,',
      '  row_count: u32,',
      '  result_offset: u32,',
      '  result_count: u32,',
      '  effect_offset: u32,',
      '  effect_capacity: u32,',
      '  chunk_rows: u32,',
      '  params_offset: u32,',
      '}',
      'struct TeaResultCell { bits: u32, valid: u32, }',
      'struct TeaEffectStatus { count: u32, overflow: u32, first_overflow_row: u32, first_overflow_effect: u32, }',
      `struct TeaEffectRecord { row: u32, effect_id: u32, payload: array<u32, ${Math.max(1, this.maxEffectPayloadWords)}>, }`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_JOBS_BINDING}) var<storage, read> tea_jobs: array<TeaJobDescriptor>;`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_SERIES_BINDING}) var<storage, read> tea_series: array<f32>;`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_LANE_STATES_BINDING}) var<storage, read_write> tea_lane_states: array<TeaLaneState>;`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_RESULTS_BINDING}) var<storage, read_write> tea_results: array<TeaResultCell>;`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_EFFECT_STATUS_BINDING}) var<storage, read_write> tea_effect_status: array<TeaEffectStatus>;`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_EFFECT_RECORDS_BINDING}) var<storage, read_write> tea_effect_records: array<TeaEffectRecord>;`,
      ...(this.program.params.length === 0
        ? []
        : [
            `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_PARAMS_BINDING}) var<storage, read> tea_params: array<u32>;`,
          ]),
      ...this.emitHelpers(),
    );
    for (const func of this.funcs) {
      out.push(...this.emitFunction(func));
    }
    out.push(...this.emitKernel());
    return `${out.join('\n')}\n`;
  }

  private emitHelpers(): string[] {
    return [
      'fn tea_finite(x: f32) -> bool {',
      '  return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u;',
      '}',
      'fn tea_float(x: f32) -> TeaFloat {',
      '  if (tea_finite(x)) { return TeaFloat(1u, x); }',
      '  return TeaFloat(0u, 0.0);',
      '}',
      'fn tea_float_from_int(x: TeaInt) -> TeaFloat {',
      '  if (x.valid == 0u) { return TeaFloat(0u, 0.0); }',
      '  return tea_float(f32(x.value));',
      '}',
      'fn tea_add_f32(x: TeaFloat, y: TeaFloat) -> TeaFloat {',
      '  if (x.valid == 0u || y.valid == 0u) { return TeaFloat(0u, 0.0); }',
      '  return tea_float(x.value + y.value);',
      '}',
      'fn tea_sub_f32(x: TeaFloat, y: TeaFloat) -> TeaFloat {',
      '  if (x.valid == 0u || y.valid == 0u) { return TeaFloat(0u, 0.0); }',
      '  return tea_float(x.value - y.value);',
      '}',
      'fn tea_mul_f32(x: TeaFloat, y: TeaFloat) -> TeaFloat {',
      '  if (x.valid == 0u || y.valid == 0u) { return TeaFloat(0u, 0.0); }',
      '  return tea_float(x.value * y.value);',
      '}',
      'fn tea_div_f32(x: TeaFloat, y: TeaFloat) -> TeaFloat {',
      '  if (x.valid == 0u || y.valid == 0u || y.value == 0.0) { return TeaFloat(0u, 0.0); }',
      '  return tea_float(x.value / y.value);',
      '}',
      'fn tea_add_i32(x: TeaInt, y: TeaInt) -> TeaInt {',
      '  if (x.valid == 0u || y.valid == 0u) { return TeaInt(0u, 0); }',
      '  return TeaInt(1u, bitcast<i32>(bitcast<u32>(x.value) + bitcast<u32>(y.value)));',
      '}',
      'fn tea_sub_i32(x: TeaInt, y: TeaInt) -> TeaInt {',
      '  if (x.valid == 0u || y.valid == 0u) { return TeaInt(0u, 0); }',
      '  return TeaInt(1u, bitcast<i32>(bitcast<u32>(x.value) - bitcast<u32>(y.value)));',
      '}',
      'fn tea_mul_i32(x: TeaInt, y: TeaInt) -> TeaInt {',
      '  if (x.valid == 0u || y.valid == 0u) { return TeaInt(0u, 0); }',
      '  return TeaInt(1u, bitcast<i32>(bitcast<u32>(x.value) * bitcast<u32>(y.value)));',
      '}',
      'fn tea_div_i32(x: TeaInt, y: TeaInt) -> TeaInt {',
      '  if (x.valid == 0u || y.valid == 0u || y.value == 0) { return TeaInt(0u, 0); }',
      '  if (x.value == -2147483648 && y.value == -1) { return TeaInt(1u, -2147483648); }',
      '  return TeaInt(1u, x.value / y.value);',
      '}',
      'fn tea_note_effect_overflow(lane: u32, row: u32, effect_id: u32) {',
      '  if (tea_effect_status[lane].overflow == 0u) {',
      '    tea_effect_status[lane].first_overflow_row = row;',
      '    tea_effect_status[lane].first_overflow_effect = effect_id;',
      '  }',
      '  tea_effect_status[lane].overflow = 1u;',
      '}',
    ];
  }

  private emitFunction(func: IrFunc): string[] {
    const fn = this.funcNames.get(func) ?? fatal('unmapped GPU function');
    const parameters =
      func.callMode === 'free'
        ? [...func.params]
        : [func.receiver, ...func.params];
    const explicitSignature = parameters
      .map((name, index) => `p${index}: ${this.wgslType(name.type)}`)
      .join(', ');
    const signature = [
      'tea_state: ptr<storage, TeaLaneState, read_write>',
      'tea_lane: u32',
      'tea_job: TeaJobDescriptor',
      'tea_row: u32',
      explicitSignature,
    ]
      .filter(part => part.length > 0)
      .join(', ');
    const resultType =
      func.callMode === 'mutable-method'
        ? this.mutableResultName(func)
        : this.wgslType(func.resultType);
    const out = [`fn ${fn}(${signature}) -> ${resultType} {`];
    const env = this.rootEnvironment('(*tea_state)');
    parameters.forEach((name, index) => {
      const local = this.fresh('v');
      env.set(name, local);
      out.push(`  var ${local}: ${this.wgslType(name.type)} = p${index};`);
    });
    for (const local of func.locals) {
      if (env.has(local)) {
        continue;
      }
      const variable = this.fresh('v');
      env.set(local, variable);
      out.push(
        `  var ${variable}: ${this.wgslType(local.type)} = ${this.empty(local.type)};`,
      );
    }
    const body: string[] = [];
    const value = this.emitExpr(
      func.body,
      {
        env,
        allowDenseEmit: false,
        allowEffect: true,
        state: 'tea_state',
        lane: 'tea_lane',
        job: 'tea_job',
        row: 'tea_row',
        chunkRow: '0u',
      },
      body,
    );
    out.push(...indent(body, 1));
    const result = this.coerce(value, func.body.type, func.resultType);
    if (func.callMode === 'mutable-method') {
      const receiver =
        env.get(func.receiver) ?? fatal('unmapped method receiver');
      out.push(`  return ${resultType}(${receiver}, ${result});`);
    } else {
      out.push(`  return ${result};`);
    }
    out.push('}');
    return out;
  }

  private emitKernel(): string[] {
    const out = [
      `@compute @workgroup_size(${WORKGROUP_SIZE}, 1, 1)`,
      'fn tea_main(@builtin(global_invocation_id) tea_gid: vec3<u32>) {',
      '  let tea_job_index = tea_gid.x;',
      '  if (tea_job_index >= arrayLength(&tea_jobs) || tea_job_index >= arrayLength(&tea_lane_states) || tea_job_index >= arrayLength(&tea_effect_status)) { return; }',
      '  let tea_job = tea_jobs[tea_job_index];',
      '  if (tea_job.chunk_rows == 0u) { return; }',
      ...(this.outputCells.size === 0
        ? ['  if (tea_job.result_count != 0u) { return; }']
        : [
            `  if (tea_job.result_count / ${this.outputCells.size}u < tea_job.chunk_rows) { return; }`,
          ]),
      '  tea_effect_status[tea_job_index] = TeaEffectStatus(0u, 0u, 0u, 0u);',
    ];
    const rootEnv = this.rootEnvironment('tea_lane_states[tea_job_index]');
    const initCtx: WgslContext = {
      env: rootEnv,
      allowDenseEmit: false,
      allowEffect: false,
      state: '&tea_lane_states[tea_job_index]',
      lane: 'tea_job_index',
      job: 'tea_job',
      row: 'tea_lane_states[tea_job_index].next_row',
      chunkRow: '0u',
    };
    out.push('  if (tea_lane_states[tea_job_index].initialized == 0u) {');
    for (const root of this.persistentRoots) {
      if (root.init === null) {
        this.unsupported(
          'persistent-state-initialization-unimplemented',
          `persistent root '${root.name}' has no initializer`,
        );
      }
      const lines: string[] = [];
      const value = this.emitExpr(root.init, initCtx, lines);
      out.push(...indent(lines, 2));
      out.push(
        `    ${rootEnv.get(root) ?? fatal('unmapped persistent root')} = ${this.coerce(value, root.init.type, root.type)};`,
      );
    }
    out.push(
      '    tea_lane_states[tea_job_index].initialized = 1u;',
      '  }',
      '  let tea_start_row = tea_lane_states[tea_job_index].next_row;',
      '  if (tea_start_row >= tea_job.row_count) { return; }',
      '  let tea_chunk_count = min(tea_job.chunk_rows, tea_job.row_count - tea_start_row);',
      '  for (var tea_chunk_row = 0u; tea_chunk_row < tea_chunk_count; tea_chunk_row = tea_chunk_row + 1u) {',
      '    let tea_row = tea_start_row + tea_chunk_row;',
    );
    const env = new Map(rootEnv);
    for (const root of this.perBarRoots) {
      const variable = this.fresh('v');
      env.set(root, variable);
      out.push(
        `    var ${variable}: ${this.wgslType(root.type)} = ${this.empty(root.type)};`,
      );
    }
    const body: string[] = [];
    const ctx: WgslContext = {
      env,
      allowDenseEmit: true,
      allowEffect: true,
      state: '&tea_lane_states[tea_job_index]',
      lane: 'tea_job_index',
      job: 'tea_job',
      row: 'tea_row',
      chunkRow: 'tea_chunk_row',
    };
    for (const stmt of this.program.body) {
      this.emitStmt(stmt, ctx, body);
    }
    out.push(
      ...indent(body, 2),
      '  }',
      '  tea_lane_states[tea_job_index].next_row = tea_start_row + tea_chunk_count;',
      '}',
    );
    return out;
  }

  private emitExpr(expr: IrExpr, ctx: WgslContext, out: string[]): string {
    switch (expr.kind) {
      case IrKind.Const:
        return this.constant(expr.type, expr.value, expr.pos);
      case IrKind.OutputRef:
        return this.unsupported(
          'host-value-type-unsupported',
          'output references cannot enter the executable GPU value plane',
          expr.pos,
        );
      case IrKind.HistRead:
        return this.emitRead(expr, ctx, out);
      case IrKind.Binary:
        return this.emitBinary(expr, ctx, out);
      case IrKind.Unary: {
        const x = this.capture(expr.x, ctx, out);
        const result = this.fresh();
        if (expr.op === IrOp.Not) {
          out.push(`let ${result}: u32 = select(1u, 0u, ${x} != 0u);`);
          return result;
        }
        if (expr.op !== IrOp.Neg) {
          return this.unsupported(
            'native-call-lowering-unimplemented',
            `unsupported unary ${expr.op}`,
            expr.pos,
          );
        }
        if (expr.type.kind === TypeKind.Float) {
          out.push(`var ${result}: TeaFloat = TeaFloat(0u, 0.0);`);
          out.push(
            `if (${x}.valid != 0u) { ${result} = tea_float(-${x}.value); }`,
          );
        } else if (expr.type.kind === TypeKind.Int) {
          out.push(`var ${result}: TeaInt = TeaInt(0u, 0);`);
          out.push(
            `if (${x}.valid != 0u) { ${result} = TeaInt(1u, bitcast<i32>(0u - bitcast<u32>(${x}.value))); }`,
          );
        } else {
          return this.unsupported(
            'host-value-type-unsupported',
            `numeric negation reached ${formatType(expr.type)}`,
            expr.pos,
          );
        }
        return result;
      }
      case IrKind.Cond: {
        const condition = this.capture(expr.cond, ctx, out);
        const thenValue = this.capture(expr.then, ctx, out);
        const elseValue = this.capture(expr.else, ctx, out);
        const result = this.fresh();
        out.push(
          `var ${result}: ${this.wgslType(expr.type)} = ${this.empty(expr.type)};`,
        );
        out.push(`if (${condition} != 0u) {`);
        out.push(
          `  ${result} = ${this.coerce(thenValue, expr.then.type, expr.type)};`,
        );
        out.push('} else {');
        out.push(
          `  ${result} = ${this.coerce(elseValue, expr.else.type, expr.type)};`,
        );
        out.push('}');
        return result;
      }
      case IrKind.CallFunc:
        return this.emitCall(expr, null, null, ctx, out);
      case IrKind.CallConstMethod:
        return this.emitCall(expr, expr.receiver, null, ctx, out);
      case IrKind.CallMutableMethod:
        return this.emitCall(expr, expr.receiver, expr.path, ctx, out);
      case IrKind.CallNative:
        return this.emitNative(
          expr.native,
          expr.args,
          expr.argumentEvaluationOrder,
          expr.type,
          expr.pos,
          ctx,
          out,
        );
      case IrKind.MutateCollection:
        return this.unsupported(
          'collection-operation-lowering-unimplemented',
          'GPU collections are outside the executable subset',
          expr.pos,
        );
      case IrKind.NewUserValue: {
        if (
          !typesEqual(expr.type, expr.userType) ||
          expr.args.length !== expr.userType.fields.length
        ) {
          return fatal('malformed user constructor reached GPU lowering');
        }
        const args = this.captureArguments(
          expr.args,
          expr.argumentEvaluationOrder,
          ctx,
          out,
        );
        const values = args.map((arg, index) =>
          this.coerce(
            arg,
            expr.args[index].type,
            expr.userType.fields[index].type,
          ),
        );
        const result = this.fresh();
        out.push(
          `let ${result}: ${this.userName(expr.userType)} = ${this.userName(expr.userType)}(1u${values.map(value => `, ${value}`).join('')});`,
        );
        return result;
      }
      case IrKind.MakeTuple:
      case IrKind.TupleGet:
        return this.unsupported(
          'tuple-operation-lowering-unimplemented',
          'GPU tuples are outside the executable subset',
          expr.pos,
        );
      case IrKind.FieldGet: {
        if (expr.x.type.kind !== TypeKind.UserType) {
          return fatal('non-user field read reached GPU lowering');
        }
        const field = expr.x.type.fields[expr.fieldIndex];
        if (field === undefined || !typesEqual(field.type, expr.type)) {
          return fatal('malformed user field read reached GPU lowering');
        }
        const parent = this.capture(expr.x, ctx, out);
        const result = this.fresh();
        out.push(
          `var ${result}: ${this.wgslType(expr.type)} = ${this.empty(expr.type)};`,
        );
        out.push(
          `if (${parent}.valid != 0u) { ${result} = ${parent}.f${expr.fieldIndex}; }`,
        );
        return result;
      }
      case IrKind.IfExpr: {
        const condition = this.capture(expr.cond, ctx, out);
        const result = this.fresh();
        out.push(
          `var ${result}: ${this.wgslType(expr.type)} = ${this.empty(expr.type)};`,
        );
        const thenLines: string[] = [];
        const thenValue = this.emitBlock(expr.then, ctx, thenLines);
        if (thenValue !== null) {
          thenLines.push(
            `${result} = ${this.coerce(thenValue, expr.then.value?.type ?? expr.then.type, expr.type)};`,
          );
        }
        out.push(`if (${condition} != 0u) {`, ...indent(thenLines, 1));
        if (expr.else !== null) {
          const elseLines: string[] = [];
          const elseValue = this.emitBlock(expr.else, ctx, elseLines);
          if (elseValue !== null) {
            elseLines.push(
              `${result} = ${this.coerce(elseValue, expr.else.value?.type ?? expr.else.type, expr.type)};`,
            );
          }
          out.push('} else {', ...indent(elseLines, 1));
        }
        out.push('}');
        return result;
      }
      case IrKind.SwitchExpr:
        return this.unsupported(
          'loop-lowering-unimplemented',
          'GPU switch expressions are outside the executable subset',
          expr.pos,
        );
      case IrKind.ForExpr:
      case IrKind.ForInExpr:
      case IrKind.WhileExpr:
        return this.unsupported(
          'loop-lowering-unimplemented',
          'Tea loops are outside the executable GPU subset',
          expr.pos,
        );
      case IrKind.BlockExpr:
        return this.emitBlock(expr, ctx, out) ?? this.empty(expr.type);
      default:
        return unreachableGpuExpr(expr);
    }
  }

  private emitBlock(
    expr: Extract<IrExpr, {kind: typeof IrKind.BlockExpr}>,
    ctx: WgslContext,
    out: string[],
  ): string | null {
    for (const stmt of expr.stmts) {
      this.emitStmt(stmt, ctx, out);
    }
    return expr.value === null ? null : this.emitExpr(expr.value, ctx, out);
  }

  private emitStmt(stmt: IrStmt, ctx: WgslContext, out: string[]): void {
    switch (stmt.kind) {
      case IrKind.ExprStmt:
        this.emitExpr(stmt.x, ctx, out);
        return;
      case IrKind.WriteName: {
        const target = ctx.env.get(stmt.name);
        if (target === undefined) {
          this.unsupported(
            'function-frame-lowering-unimplemented',
            `name '${stmt.name.name}' is outside the active GPU frame`,
            stmt.pos,
          );
        }
        const value = this.emitExpr(stmt.value, ctx, out);
        out.push(
          `${target} = ${this.coerce(value, stmt.value.type, stmt.name.type)};`,
        );
        return;
      }
      case IrKind.UpdateValuePath: {
        if (stmt.path.fieldIndices.length > 1) {
          this.unsupported(
            'mutable-method-copyout-unimplemented',
            'multi-level rooted updates require recursive pre-RHS rebuilding and are outside the current WGSL subset',
            stmt.pos,
          );
        }
        if (stmt.path.fieldIndices.length === 0) {
          const value = this.emitExpr(stmt.value, ctx, out);
          this.emitPathWrite(
            stmt.path,
            value,
            stmt.value.type,
            ctx,
            out,
            stmt.pos,
          );
          return;
        }
        const root = ctx.env.get(stmt.path.root);
        if (
          root === undefined ||
          stmt.path.root.type.kind !== TypeKind.UserType
        ) {
          return fatal('malformed rooted user update reached WGSL lowering');
        }
        const fieldIndex = stmt.path.fieldIndices[0];
        const field = stmt.path.root.type.fields[fieldIndex];
        if (field === undefined || !assignable(stmt.value.type, field.type)) {
          return fatal('ill-typed rooted user update reached WGSL lowering');
        }
        // Validate writeability before evaluating the RHS, matching the JS
        // backend. Rebase the replacement onto the then-current root so RHS
        // side effects on sibling fields are retained.
        const capturedRoot = this.fresh();
        out.push(
          `let ${capturedRoot}: ${this.wgslType(stmt.path.root.type)} = ${root};`,
        );
        const rhs: string[] = [];
        const value = this.emitExpr(stmt.value, ctx, rhs);
        const rebuilt = this.fresh();
        rhs.push(
          `var ${rebuilt}: ${this.wgslType(stmt.path.root.type)} = ${root};`,
          `${rebuilt}.f${fieldIndex} = ${this.coerce(value, stmt.value.type, field.type)};`,
          `${root} = ${rebuilt};`,
        );
        out.push(`if (${capturedRoot}.valid != 0u) {`, ...indent(rhs, 1), '}');
        return;
      }
      case IrKind.Emit: {
        if (!ctx.allowDenseEmit) {
          this.unsupported(
            'result-transport-lowering-unimplemented',
            'a function attempted to emit a GPU result',
            stmt.pos,
          );
        }
        const values = this.captureArguments(
          stmt.args,
          stmt.argumentEvaluationOrder,
          ctx,
          out,
        );
        if (values.length !== 1) {
          this.unsupported(
            'result-transport-lowering-unimplemented',
            'the executable GPU subset requires one scalar emission channel',
            stmt.pos,
          );
        }
        const rowCell = this.outputCells.get(stmt.output);
        if (rowCell === undefined) {
          fatal('unmapped GPU output emission');
        }
        const slot = this.fresh();
        out.push(
          `let ${slot}: u32 = ${ctx.job}.result_offset + ${ctx.chunkRow} * ${this.outputCells.size}u + ${rowCell}u;`,
        );
        out.push(
          `if (${slot} < arrayLength(&tea_results) && ${slot} < ${ctx.job}.result_offset + ${ctx.job}.result_count) {`,
        );
        const encoded = this.encodeResult(values[0], stmt.args[0].type);
        out.push(`  tea_results[${slot}] = ${encoded};`, '}');
        return;
      }
      case IrKind.EmitEffect: {
        if (!ctx.allowEffect) {
          this.unsupported(
            'effect-transport-lowering-unimplemented',
            'effect emission reached a GPU initialization context',
            stmt.pos,
          );
        }
        const effectId = this.effectIds.get(stmt.effect);
        if (effectId === undefined) {
          return fatal('unmapped GPU effect emission');
        }
        const payload = this.capture(stmt.payload, ctx, out);
        this.emitEffectAppend(
          effectId,
          stmt.effect.payloadType,
          payload,
          ctx,
          out,
        );
        return;
      }
      case IrKind.Break:
      case IrKind.Continue:
        this.unsupported(
          'loop-lowering-unimplemented',
          'break/continue cannot appear outside a supported loop',
          stmt.pos,
        );
      default:
        return unreachableGpuStmt(stmt);
    }
  }

  private emitEffectAppend(
    effectId: number,
    payloadType: Type,
    payload: string,
    ctx: WgslContext,
    out: string[],
  ): void {
    const cursor = this.fresh('effect_cursor');
    const slot = this.fresh('effect_slot');
    const record = this.fresh('effect_record');
    const payloadWords = Math.max(1, this.maxEffectPayloadWords);
    out.push(
      `let ${cursor}: u32 = tea_effect_status[${ctx.lane}].count;`,
      `if (${cursor} < ${ctx.job}.effect_capacity) {`,
      `  let ${slot}: u32 = ${ctx.job}.effect_offset + ${cursor};`,
      `  if (${slot} >= ${ctx.job}.effect_offset && ${slot} < arrayLength(&tea_effect_records)) {`,
      `    var ${record}: TeaEffectRecord = TeaEffectRecord(${ctx.row}, ${effectId}u, array<u32, ${payloadWords}>(${new Array(payloadWords).fill('0u').join(', ')}));`,
    );
    const assignments: string[] = [];
    this.emitEffectPayloadWords(payloadType, payload, record, 0, assignments);
    out.push(
      ...indent(assignments, 2),
      `    tea_effect_records[${slot}] = ${record};`,
      `    tea_effect_status[${ctx.lane}].count = ${cursor} + 1u;`,
      '  } else {',
      `    tea_note_effect_overflow(${ctx.lane}, ${ctx.row}, ${effectId}u);`,
      '  }',
      '} else {',
      `  tea_note_effect_overflow(${ctx.lane}, ${ctx.row}, ${effectId}u);`,
      '}',
    );
  }

  private emitEffectPayloadWords(
    type: Type,
    value: string,
    record: string,
    wordOffset: number,
    out: string[],
  ): number {
    const set = (offset: number, bits: string) =>
      out.push(`${record}.payload[${offset}] = ${bits};`);
    switch (type.kind) {
      case TypeKind.Bool:
        set(wordOffset, value);
        return wordOffset + 1;
      case TypeKind.Int:
      case TypeKind.Float:
        set(wordOffset, `${value}.valid`);
        set(wordOffset + 1, `bitcast<u32>(${value}.value)`);
        return wordOffset + 2;
      case TypeKind.Enum:
      case TypeKind.String:
      case TypeKind.Color:
        set(wordOffset, `${value}.valid`);
        set(wordOffset + 1, `${value}.value`);
        return wordOffset + 2;
      case TypeKind.UserType: {
        set(wordOffset, `${value}.valid`);
        let next = wordOffset + 1;
        type.fields.forEach((field, index) => {
          next = this.emitEffectPayloadWords(
            field.type,
            `${value}.f${index}`,
            record,
            next,
            out,
          );
        });
        return next;
      }
      default:
        return this.unsupported(
          'effect-transport-lowering-unimplemented',
          `cannot encode GPU effect payload ${formatType(type)}`,
        );
    }
  }

  private emitRead(
    expr: HistReadExpr,
    ctx: WgslContext,
    out: string[],
  ): string {
    // Scalar parameters are constant over the full row axis, so their history
    // reads are the same bound value (the JS lowering has the same rule).
    if (expr.offset !== null && expr.place.kind !== PlaceKind.Param) {
      return this.unsupported(
        'history-layout-unimplemented',
        'only current-row reads lower to WGSL',
        expr.pos,
      );
    }
    switch (expr.place.kind) {
      case PlaceKind.Name: {
        const value = ctx.env.get(expr.place.name);
        if (value === undefined) {
          return this.unsupported(
            'function-frame-lowering-unimplemented',
            `name '${expr.place.name.name}' is outside the active GPU frame`,
            expr.pos,
          );
        }
        return value;
      }
      case PlaceKind.Series: {
        const ordinal = this.seriesIds.get(expr.place.series);
        if (ordinal === undefined) {
          return fatal(`unmapped series '${expr.place.series.id}'`);
        }
        const result = this.fresh();
        out.push(
          `let ${result}: TeaFloat = tea_float(tea_series[${ctx.job}.series_offset + ${ordinal}u * ${ctx.job}.row_count + ${ctx.row}]);`,
        );
        return result;
      }
      case PlaceKind.Execution:
        return this.emitExecution(expr.place.execution, expr.pos, ctx, out);
      case PlaceKind.Param: {
        const pid = this.paramIds.get(expr.place.param);
        if (pid === undefined) {
          return fatal(`unmapped GPU parameter '${expr.place.param.name}'`);
        }
        const bits = `tea_params[${ctx.job}.params_offset + ${pid}u]`;
        switch (expr.place.param.type.kind) {
          case TypeKind.Int:
            return `TeaInt(1u, bitcast<i32>(${bits}))`;
          case TypeKind.Float:
            return `TeaFloat(1u, bitcast<f32>(${bits}))`;
          case TypeKind.Bool:
            return bits;
          case TypeKind.Enum:
            return `TeaEnum(1u, ${bits})`;
          default:
            return this.unsupported(
              'parameter-packing-unimplemented',
              `GPU cannot read parameter '${expr.place.param.name}' of type ${formatType(expr.place.param.type)}`,
              expr.pos,
            );
        }
      }
      case PlaceKind.Request:
        return this.unsupported(
          'request-execution-unimplemented',
          'GPU request reads are not implemented',
          expr.pos,
        );
      default:
        return unreachableGpuPlace(expr.place);
    }
  }

  private emitExecution(
    execution: ExecutionInput,
    pos: Pos,
    ctx: WgslContext,
    out: string[],
  ): string {
    const result = this.fresh();
    if (
      execution.source.domain === 'bar' &&
      execution.source.field === 'bar_index'
    ) {
      if (execution.type.kind !== TypeKind.Int) {
        return fatal('bar_index execution input is not int');
      }
      out.push(`let ${result}: TeaInt = TeaInt(1u, i32(${ctx.row}));`);
      return result;
    }
    if (
      execution.source.domain === 'barstate' &&
      execution.source.field === 'islast'
    ) {
      if (execution.type.kind !== TypeKind.Bool) {
        return fatal('barstate.islast execution input is not bool');
      }
      out.push(
        `let ${result}: u32 = select(0u, 1u, ${ctx.row} + 1u == ${ctx.job}.row_count);`,
      );
      return result;
    }
    return this.unsupported(
      'execution-input-mapping-unimplemented',
      `execution input ${execution.source.domain}.${execution.source.field} is not derived by this GPU target`,
      pos,
    );
  }

  private emitCall(
    expr: Extract<
      IrExpr,
      {
        kind:
          | typeof IrKind.CallFunc
          | typeof IrKind.CallConstMethod
          | typeof IrKind.CallMutableMethod;
      }
    >,
    receiverExpr: IrExpr | null,
    path: IrValuePath | null,
    ctx: WgslContext,
    out: string[],
  ): string {
    const fn = this.funcNames.get(expr.func);
    if (fn === undefined) {
      return this.unsupported(
        'function-frame-lowering-unimplemented',
        `function '${expr.func.name}' is outside the closed GPU graph`,
        expr.pos,
      );
    }
    const receiver =
      receiverExpr === null ? null : this.capture(receiverExpr, ctx, out);
    const args = this.captureArguments(
      expr.args,
      expr.argumentEvaluationOrder,
      ctx,
      out,
    );
    const explicitArgs = receiver === null ? args : [receiver, ...args];
    const callArgs = [ctx.state, ctx.lane, ctx.job, ctx.row, ...explicitArgs];
    const result = this.fresh();
    if (expr.kind === IrKind.CallMutableMethod) {
      if (path === null) {
        return fatal('mutable GPU call lost its writeback path');
      }
      const returnType = this.mutableResultName(expr.func);
      out.push(`let ${result}: ${returnType} = ${fn}(${callArgs.join(', ')});`);
      this.emitPathWrite(
        path,
        `${result}.receiver`,
        expr.func.receiver.type,
        ctx,
        out,
        expr.pos,
      );
      return `${result}.result`;
    }
    out.push(
      `let ${result}: ${this.wgslType(expr.type)} = ${fn}(${callArgs.join(', ')});`,
    );
    return result;
  }

  private emitNative(
    native: string,
    args: readonly IrExpr[],
    order: readonly number[],
    resultType: Type,
    pos: Pos,
    ctx: WgslContext,
    out: string[],
  ): string {
    const values = this.captureArguments(args, order, ctx, out);
    if (native === 'na') {
      if (args.length !== 1 || resultType.kind !== TypeKind.Bool) {
        return fatal('malformed na call reached GPU lowering');
      }
      const result = this.fresh();
      const valid = this.validity(values[0], args[0].type);
      out.push(`let ${result}: u32 = select(1u, 0u, ${valid});`);
      return result;
    }
    if (native === 'float') {
      if (args.length !== 1 || resultType.kind !== TypeKind.Float) {
        return fatal('malformed float call reached GPU lowering');
      }
      const result = this.fresh();
      out.push(
        `let ${result}: TeaFloat = ${this.coerce(values[0], args[0].type, resultType)};`,
      );
      return result;
    }
    return this.unsupported(
      'native-call-lowering-unimplemented',
      `native '${native}' has no GPU rule`,
      pos,
    );
  }

  private emitBinary(
    expr: Extract<IrExpr, {kind: typeof IrKind.Binary}>,
    ctx: WgslContext,
    out: string[],
  ): string {
    if (expr.op === IrOp.And || expr.op === IrOp.Or) {
      const left = this.capture(expr.x, ctx, out);
      const result = this.fresh();
      out.push(`var ${result}: u32 = ${left};`);
      const test = expr.op === IrOp.And ? `${result} != 0u` : `${result} == 0u`;
      const rightLines: string[] = [];
      const right = this.capture(expr.y, ctx, rightLines);
      rightLines.push(`${result} = ${right};`);
      out.push(`if (${test}) {`, ...indent(rightLines, 1), '}');
      return result;
    }
    if (expr.op === IrOp.Add && expr.type.kind === TypeKind.String) {
      return this.unsupported(
        'host-value-type-unsupported',
        'dynamic GPU strings are unsupported; effect strings must be interned literals',
        expr.pos,
      );
    }
    const left = this.capture(expr.x, ctx, out);
    const right = this.capture(expr.y, ctx, out);
    const result = this.fresh();
    if (expr.op === IrOp.Eq || expr.op === IrOp.Ne || isComparison(expr.op)) {
      const compareType = commonComparableType(expr.x.type, expr.y.type);
      if (
        compareType.kind !== TypeKind.Float &&
        compareType.kind !== TypeKind.Int &&
        compareType.kind !== TypeKind.Bool &&
        compareType.kind !== TypeKind.Enum &&
        compareType.kind !== TypeKind.String &&
        compareType.kind !== TypeKind.Color
      ) {
        return this.unsupported(
          'aggregate-operation-lowering-unimplemented',
          `comparison for ${formatType(compareType)} has no GPU rule`,
          expr.pos,
        );
      }
      const x = this.coerce(left, expr.x.type, compareType);
      const y = this.coerce(right, expr.y.type, compareType);
      const valid = `${this.validity(x, compareType)} && ${this.validity(y, compareType)}`;
      const xPayload = this.payload(x, compareType);
      const yPayload = this.payload(y, compareType);
      const operator = wgslComparison(expr.op);
      out.push(`var ${result}: u32 = 0u;`);
      out.push(
        `if (${valid}) { ${result} = select(0u, 1u, ${xPayload} ${operator} ${yPayload}); }`,
      );
      return result;
    }
    if (expr.type.kind === TypeKind.Float) {
      const x = this.coerce(left, expr.x.type, expr.type);
      const y = this.coerce(right, expr.y.type, expr.type);
      const helper = numericHelper(expr.op, 'f32');
      out.push(`let ${result}: TeaFloat = ${helper}(${x}, ${y});`);
      return result;
    }
    if (expr.type.kind === TypeKind.Int) {
      const helper = numericHelper(expr.op, 'i32');
      out.push(`let ${result}: TeaInt = ${helper}(${left}, ${right});`);
      return result;
    }
    return this.unsupported(
      'host-value-type-unsupported',
      `binary ${expr.op} has unsupported result ${formatType(expr.type)}`,
      expr.pos,
    );
  }

  private capture(expr: IrExpr, ctx: WgslContext, out: string[]): string {
    const value = this.emitExpr(expr, ctx, out);
    const result = this.fresh();
    out.push(`let ${result}: ${this.wgslType(expr.type)} = ${value};`);
    return result;
  }

  private captureArguments(
    args: readonly IrExpr[],
    order: readonly number[],
    ctx: WgslContext,
    out: string[],
  ): string[] {
    if (!isPermutation(order, args.length)) {
      return fatal('malformed argument evaluation order reached GPU lowering');
    }
    const values = new Array<string>(args.length);
    for (const index of order) {
      values[index] = this.capture(args[index], ctx, out);
    }
    return values;
  }

  private emitPathWrite(
    path: IrValuePath,
    value: string,
    valueType: Type,
    ctx: WgslContext,
    out: string[],
    pos: Pos,
  ): void {
    const root = ctx.env.get(path.root);
    if (root === undefined) {
      this.unsupported(
        'mutable-method-copyout-unimplemented',
        `path root '${path.root.name}' is outside the active GPU frame`,
        pos,
      );
    }
    let type = path.root.type;
    let target = root;
    const guards: string[] = [];
    for (const index of path.fieldIndices) {
      if (type.kind !== TypeKind.UserType || type.fields[index] === undefined) {
        fatal('malformed user path reached GPU lowering');
      }
      guards.push(`${target}.valid != 0u`);
      target += `.f${index}`;
      type = type.fields[index].type;
    }
    if (!assignable(valueType, type)) {
      fatal('ill-typed user path write reached GPU lowering');
    }
    const assignment = `${target} = ${this.coerce(value, valueType, type)};`;
    if (guards.length === 0) {
      out.push(assignment);
    } else {
      out.push(`if (${guards.join(' && ')}) { ${assignment} }`);
    }
  }

  private constant(type: Type, value: unknown, pos: Pos): string {
    if (isNaValue(value as never)) {
      return this.empty(type);
    }
    switch (type.kind) {
      case TypeKind.Bool:
        return value === true ? '1u' : '0u';
      case TypeKind.Int: {
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < -0x8000_0000 ||
          value > 0x7fff_ffff
        ) {
          return this.unsupported(
            'numeric-contract-unresolved',
            `int constant '${String(value)}' is outside i32`,
            pos,
          );
        }
        return `TeaInt(1u, ${wgslInt(value)})`;
      }
      case TypeKind.Float: {
        if (typeof value !== 'number') {
          return fatal('non-number float constant reached GPU lowering');
        }
        const rounded = Math.fround(value);
        if (!Number.isFinite(rounded)) {
          return this.unsupported(
            'numeric-contract-unresolved',
            `float constant '${String(value)}' is outside finite f32`,
            pos,
          );
        }
        return `TeaFloat(1u, ${wgslFloat(rounded)})`;
      }
      case TypeKind.Enum: {
        if (typeof value !== 'string') {
          return fatal('non-string enum constant reached GPU lowering');
        }
        const ordinal = type.members.findIndex(member => member.name === value);
        if (ordinal < 0) {
          return fatal(`unknown enum member '${value}' reached GPU lowering`);
        }
        return `TeaEnum(1u, ${ordinal}u)`;
      }
      case TypeKind.String: {
        if (typeof value !== 'string') {
          return fatal('non-string string constant reached GPU lowering');
        }
        return `TeaString(1u, ${this.internLiteralString(value)}u)`;
      }
      case TypeKind.Color: {
        if (typeof value !== 'string') {
          return fatal('non-string color constant reached GPU lowering');
        }
        return `TeaColor(1u, ${wgslColor(value, pos)})`;
      }
      case TypeKind.Void:
        return '0u';
      default:
        return fatal(
          `non-scalar constant reached GPU lowering at ${formatPos(pos)}`,
        );
    }
  }

  private wgslType(type: Type): string {
    switch (type.kind) {
      case TypeKind.Bool:
      case TypeKind.Void:
        return 'u32';
      case TypeKind.Int:
        return 'TeaInt';
      case TypeKind.Float:
        return 'TeaFloat';
      case TypeKind.Enum:
        return 'TeaEnum';
      case TypeKind.String:
        return 'TeaString';
      case TypeKind.Color:
        return 'TeaColor';
      case TypeKind.UserType:
        return this.userName(type);
      default:
        return this.unsupported(
          'host-value-type-unsupported',
          `no WGSL value type for ${formatType(type)}`,
        );
    }
  }

  private empty(type: Type): string {
    switch (type.kind) {
      case TypeKind.Bool:
      case TypeKind.Void:
        return '0u';
      case TypeKind.Int:
        return 'TeaInt(0u, 0)';
      case TypeKind.Float:
        return 'TeaFloat(0u, 0.0)';
      case TypeKind.Enum:
        return 'TeaEnum(0u, 0u)';
      case TypeKind.String:
        return 'TeaString(0u, 0u)';
      case TypeKind.Color:
        return 'TeaColor(0u, 0u)';
      case TypeKind.UserType:
        return `${this.userName(type)}(0u${type.fields.map(field => `, ${this.empty(field.type)}`).join('')})`;
      default:
        return this.unsupported(
          'host-value-type-unsupported',
          `no empty GPU value for ${formatType(type)}`,
        );
    }
  }

  private coerce(value: string, from: Type, to: Type): string {
    if (typesEqual(from, to)) {
      return value;
    }
    if (from.kind === TypeKind.Int && to.kind === TypeKind.Float) {
      return `tea_float_from_int(${value})`;
    }
    return fatal(
      `GPU lowering cannot coerce ${formatType(from)} to ${formatType(to)}`,
    );
  }

  private validity(value: string, type: Type): string {
    return type.kind === TypeKind.Bool || type.kind === TypeKind.Void
      ? 'true'
      : `${value}.valid != 0u`;
  }

  private payload(value: string, type: Type): string {
    return type.kind === TypeKind.Bool || type.kind === TypeKind.Void
      ? value
      : `${value}.value`;
  }

  private encodeResult(value: string, type: Type): string {
    switch (type.kind) {
      case TypeKind.Float:
        return `TeaResultCell(bitcast<u32>(${value}.value), ${value}.valid)`;
      case TypeKind.Int:
        return `TeaResultCell(bitcast<u32>(${value}.value), ${value}.valid)`;
      case TypeKind.Bool:
        return `TeaResultCell(${value}, 1u)`;
      case TypeKind.Enum:
        return `TeaResultCell(${value}.value, ${value}.valid)`;
      default:
        return this.unsupported(
          'result-transport-lowering-unimplemented',
          `cannot encode result ${formatType(type)}`,
        );
    }
  }

  private resultOutputs(): readonly {
    readonly output: OutputDecl;
    readonly outputId: number;
  }[] {
    const emitted = new Set(
      this.program.body
        .filter(
          (stmt): stmt is Extract<IrStmt, {kind: typeof IrKind.Emit}> =>
            stmt.kind === IrKind.Emit,
        )
        .map(stmt => stmt.output),
    );
    return this.program.outputs.flatMap((output, outputId) =>
      emitted.has(output) ? [{output, outputId}] : [],
    );
  }

  private resultChannels(): readonly WgslResultChannel[] {
    return this.resultOutputs().map(({output, outputId}, rowCell) => {
      const channel =
        output.channels[0] ?? fatal('missing WGSL result channel');
      return {
        outputId,
        effect: output.effect,
        channelName: channel.name,
        scalar: resultScalar(channel.type),
        enumMembers:
          channel.type.kind === TypeKind.Enum
            ? channel.type.members.map(member => member.name)
            : null,
        rowCell,
      };
    });
  }

  private outputSchemas(): readonly WgslOutputSchema[] {
    return this.program.outputs.map((output, outputId) => {
      if (output.bindArgs.length > 0) {
        this.unsupported(
          'result-transport-lowering-unimplemented',
          `output ${outputId} has bind-time arguments that cannot enter the GPU declaration schema`,
        );
      }
      const rowCell = this.outputCells.get(output) ?? null;
      return {
        outputId,
        effect: output.effect,
        staticArgs: output.staticArgs.map(arg => ({
          name: arg.name,
          value: manifestValue(arg.value),
        })),
        channels: output.channels.map(channel => {
          if (!isGpuResultType(channel.type)) {
            this.unsupported(
              'result-transport-lowering-unimplemented',
              `output ${outputId} channel has unsupported type ${formatType(channel.type)}`,
            );
          }
          return {
            name: channel.name,
            type: formatType(channel.type),
            transport: outputTransport(channel.type),
            rowCell,
          };
        }),
      };
    });
  }

  private effectSchemas(): readonly WgslEffectSchema[] {
    return this.program.effects.map((effect, effectId) => ({
      effectId,
      payloadLayout: this.physicalLayoutOf(effect.payloadType),
      payloadWordCount:
        this.layouts[this.physicalLayoutOf(effect.payloadType)].byteSize / 4,
      payload: this.valueSchema(effect.payloadType, effect.payloadSchema),
      declaration: {payload: effect.payloadSchema},
    }));
  }

  private valueSchema(type: Type, logical: EffectValueSchema): WgslValueSchema {
    const physicalLayout = this.physicalLayoutOf(type);
    const requireLogical = <K extends EffectValueSchema['kind']>(
      kind: K,
    ): Extract<EffectValueSchema, {readonly kind: K}> => {
      if (logical.kind !== kind) {
        return fatal(
          `effect logical schema '${logical.kind}' disagrees with physical type '${formatType(type)}'`,
        );
      }
      return logical as Extract<EffectValueSchema, {readonly kind: K}>;
    };
    switch (type.kind) {
      case TypeKind.Bool:
        requireLogical('bool');
        return {kind: 'bool', physicalLayout, valueByteOffset: 0};
      case TypeKind.Int:
        requireLogical('int');
        return {
          kind: 'int',
          physicalLayout,
          validByteOffset: 0,
          valueByteOffset: 4,
        };
      case TypeKind.Float:
        requireLogical('float');
        return {
          kind: 'float',
          physicalLayout,
          validByteOffset: 0,
          valueByteOffset: 4,
        };
      case TypeKind.String:
        requireLogical('string');
        return {
          kind: 'string',
          physicalLayout,
          validByteOffset: 0,
          valueByteOffset: 4,
        };
      case TypeKind.Color:
        requireLogical('color');
        return {
          kind: 'color',
          physicalLayout,
          validByteOffset: 0,
          valueByteOffset: 4,
        };
      case TypeKind.Enum:
        const enumLogical = requireLogical('enum');
        return {
          kind: 'enum',
          physicalLayout,
          validByteOffset: 0,
          ordinalByteOffset: 4,
          name: type.name,
          typeId: enumLogical.typeId,
          members: type.members.map(member => member.name),
        };
      case TypeKind.UserType: {
        const userLogical = requireLogical('user-type');
        const layout = this.layouts[physicalLayout];
        let byteOffset = 4;
        return {
          kind: 'user-type',
          physicalLayout,
          validByteOffset: 0,
          name: type.name,
          typeId: userLogical.typeId,
          fields: type.fields.map(field => {
            const logicalField = userLogical.fields.find(
              candidate => candidate.name === field.name,
            );
            if (logicalField === undefined) {
              return fatal(
                `effect logical schema '${userLogical.typeId}' has no field '${field.name}'`,
              );
            }
            const nested = this.layouts[this.physicalLayoutOf(field.type)];
            const schema = {
              name: field.name,
              byteOffset,
              value: this.valueSchema(field.type, logicalField.value),
            };
            byteOffset += nested.byteSize;
            return schema;
          }),
        };
      }
      default:
        return this.unsupported(
          'effect-transport-lowering-unimplemented',
          `cannot describe GPU effect payload ${formatType(type)}`,
        );
    }
  }

  private userName(type: UserType): string {
    return (
      this.userNames.get(type) ?? fatal(`unmapped user type '${type.name}'`)
    );
  }

  private internLiteralString(value: string): number {
    const existing = this.literalStringIds.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.literalStrings.length;
    this.literalStringIds.set(value, id);
    this.literalStrings.push(value);
    return id;
  }

  private rootEnvironment(owner: string): Map<Name, string> {
    return new Map(
      this.persistentRoots.map((root, index) => [root, `${owner}.r${index}`]),
    );
  }

  private mutableResultName(func: IrFunc): string {
    return (
      this.mutableResultNames.get(func) ??
      fatal(`unmapped mutable function '${func.name}'`)
    );
  }

  private fresh(prefix = 't'): string {
    return `${prefix}${this.temp++}`;
  }
}

interface WgslContext {
  readonly env: Map<Name, string>;
  readonly allowDenseEmit: boolean;
  readonly allowEffect: boolean;
  readonly state: string;
  readonly lane: string;
  readonly job: string;
  readonly row: string;
  readonly chunkRow: string;
}

function compareInitializers(left: Name, right: Name): number {
  const a = left.init?.pos;
  const b = right.init?.pos;
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  return (
    a.base.filename.localeCompare(b.base.filename) ||
    a.line - b.line ||
    a.col - b.col
  );
}

function isGpuResultType(type: Type): boolean {
  return (
    type.kind === TypeKind.Float ||
    type.kind === TypeKind.Int ||
    type.kind === TypeKind.Bool ||
    type.kind === TypeKind.Enum
  );
}

function resultScalar(type: Type): WgslResultChannel['scalar'] {
  switch (type.kind) {
    case TypeKind.Float:
      return 'float';
    case TypeKind.Int:
      return 'int';
    case TypeKind.Bool:
      return 'bool';
    case TypeKind.Enum:
      return 'enum';
    default:
      return fatal(`non-scalar GPU result ${formatType(type)}`);
  }
}

function outputTransport(
  type: Type,
): WgslOutputSchema['channels'][number]['transport'] {
  switch (type.kind) {
    case TypeKind.Int:
      return {kind: 'int'};
    case TypeKind.Float:
      return {kind: 'float'};
    case TypeKind.Bool:
      return {kind: 'bool'};
    case TypeKind.Enum:
      return {
        kind: 'enum',
        name: type.name,
        members: type.members.map(member => member.name),
      };
    default:
      return fatal(`unsupported WGSL output transport ${formatType(type)}`);
  }
}

function indent(lines: readonly string[], levels: number): string[] {
  const prefix = '  '.repeat(levels);
  return lines.map(line => (line.length === 0 ? line : `${prefix}${line}`));
}

function isPermutation(order: readonly number[], count: number): boolean {
  return (
    order.length === count &&
    new Set(order).size === count &&
    order.every(index => Number.isInteger(index) && index >= 0 && index < count)
  );
}

function isComparison(op: string): boolean {
  return op === IrOp.Lt || op === IrOp.Le || op === IrOp.Gt || op === IrOp.Ge;
}

function commonComparableType(left: Type, right: Type): Type {
  if (left.kind === TypeKind.Float && right.kind === TypeKind.Int) {
    return left;
  }
  if (right.kind === TypeKind.Float && left.kind === TypeKind.Int) {
    return right;
  }
  if (typesEqual(left, right)) {
    return left;
  }
  return fatal(
    `GPU comparison cannot join ${formatType(left)} and ${formatType(right)}`,
  );
}

function wgslComparison(op: string): string {
  switch (op) {
    case IrOp.Eq:
      return '==';
    case IrOp.Ne:
      return '!=';
    case IrOp.Lt:
      return '<';
    case IrOp.Le:
      return '<=';
    case IrOp.Gt:
      return '>';
    case IrOp.Ge:
      return '>=';
    default:
      return fatal(`non-comparison GPU operation ${op}`);
  }
}

function numericHelper(op: string, scalar: 'f32' | 'i32'): string {
  const suffix = scalar;
  switch (op) {
    case IrOp.Add:
      return `tea_add_${suffix}`;
    case IrOp.Sub:
      return `tea_sub_${suffix}`;
    case IrOp.Mul:
      return `tea_mul_${suffix}`;
    case IrOp.Div:
      return `tea_div_${suffix}`;
    default:
      throw new UnsupportedGpuSubsetError(
        'native-call-lowering-unimplemented',
        `numeric operation ${op} has no ${scalar} GPU rule`,
      );
  }
}

function wgslInt(value: number): string {
  return value < 0 ? `(${value})` : String(value);
}

function wgslFloat(value: number): string {
  if (Object.is(value, -0)) {
    return '-0.0';
  }
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

function wgslColor(value: string, pos: Pos): string {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value);
  if (match === null) {
    return fatal(
      `invalid color constant reached GPU lowering at ${formatPos(pos)}`,
    );
  }
  return `0x${match[1]}${match[2] ?? 'ff'}u`;
}

function manifestValue(value: ConstValue): number | string | boolean | null {
  if (isNaValue(value)) {
    return null;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return fatal('non-finite constant reached WGSL output schema');
  }
  return value;
}

function walkStmt(stmt: IrStmt, visit: (stmt: IrStmt) => void): void {
  visit(stmt);
  switch (stmt.kind) {
    case IrKind.ExprStmt:
      walkExpr(stmt.x, () => {}, visit);
      return;
    case IrKind.WriteName:
      walkExpr(stmt.value, () => {}, visit);
      return;
    case IrKind.UpdateValuePath:
      walkExpr(stmt.value, () => {}, visit);
      return;
    case IrKind.Emit:
      stmt.args.forEach(arg => walkExpr(arg, () => {}, visit));
      return;
    case IrKind.EmitEffect:
      walkExpr(stmt.payload, () => {}, visit);
      return;
    case IrKind.Break:
    case IrKind.Continue:
      return;
    default:
      return unreachableGpuStmt(stmt);
  }
}

function walkExpr(
  expr: IrExpr,
  visit: (expr: IrExpr) => void,
  visitStmt: (stmt: IrStmt) => void = () => {},
): void {
  visit(expr);
  const child = (value: IrExpr): void => walkExpr(value, visit, visitStmt);
  switch (expr.kind) {
    case IrKind.Const:
    case IrKind.OutputRef:
      return;
    case IrKind.HistRead:
      if (expr.offset !== null) {
        child(expr.offset);
      }
      return;
    case IrKind.Binary:
      child(expr.x);
      child(expr.y);
      return;
    case IrKind.Unary:
      child(expr.x);
      return;
    case IrKind.Cond:
      child(expr.cond);
      child(expr.then);
      child(expr.else);
      return;
    case IrKind.CallFunc:
    case IrKind.CallNative:
      expr.args.forEach(child);
      return;
    case IrKind.CallConstMethod:
    case IrKind.CallMutableMethod:
      child(expr.receiver);
      expr.args.forEach(child);
      return;
    case IrKind.MutateCollection:
      child(expr.receiver);
      expr.args.forEach(child);
      return;
    case IrKind.NewUserValue:
      expr.args.forEach(child);
      return;
    case IrKind.MakeTuple:
      expr.elems.forEach(child);
      return;
    case IrKind.TupleGet:
    case IrKind.FieldGet:
      child(expr.x);
      return;
    case IrKind.IfExpr:
      child(expr.cond);
      child(expr.then);
      if (expr.else !== null) {
        child(expr.else);
      }
      return;
    case IrKind.SwitchExpr:
      if (expr.subject !== null) {
        child(expr.subject);
      }
      expr.arms.forEach(arm => {
        if (arm.pattern !== null) {
          child(arm.pattern);
        }
        child(arm.body);
      });
      return;
    case IrKind.ForExpr:
      child(expr.from);
      child(expr.to);
      if (expr.step !== null) {
        child(expr.step);
      }
      child(expr.body);
      return;
    case IrKind.ForInExpr:
      child(expr.x);
      child(expr.body);
      return;
    case IrKind.WhileExpr:
      child(expr.cond);
      child(expr.body);
      return;
    case IrKind.BlockExpr:
      for (const stmt of expr.stmts) {
        visitStmt(stmt);
        walkStmtChildren(stmt, visit, visitStmt);
      }
      if (expr.value !== null) {
        child(expr.value);
      }
      return;
    default:
      return unreachableGpuExpr(expr);
  }
}

function walkStmtChildren(
  stmt: IrStmt,
  visitExpr: (expr: IrExpr) => void,
  visitStmt: (stmt: IrStmt) => void,
): void {
  const child = (expr: IrExpr): void => walkExpr(expr, visitExpr, visitStmt);
  switch (stmt.kind) {
    case IrKind.ExprStmt:
      child(stmt.x);
      return;
    case IrKind.WriteName:
    case IrKind.UpdateValuePath:
      child(stmt.value);
      return;
    case IrKind.Emit:
      stmt.args.forEach(child);
      return;
    case IrKind.EmitEffect:
      child(stmt.payload);
      return;
    case IrKind.Break:
    case IrKind.Continue:
      return;
    default:
      return unreachableGpuStmt(stmt);
  }
}

function initializerDependsOnCurrentRow(
  expr: IrExpr,
  allowedNames: ReadonlySet<Name> = new Set(),
  activeFuncs: ReadonlySet<IrFunc> = new Set(),
): boolean {
  let depends = false;
  walkExpr(expr, node => {
    if (node.kind === IrKind.HistRead) {
      if (
        node.place.kind === PlaceKind.Series ||
        node.place.kind === PlaceKind.Execution ||
        node.place.kind === PlaceKind.Request ||
        (node.place.kind === PlaceKind.Name &&
          node.place.name.storage === 'perBar' &&
          !allowedNames.has(node.place.name))
      ) {
        depends = true;
      }
      return;
    }
    if (
      node.kind !== IrKind.CallFunc &&
      node.kind !== IrKind.CallConstMethod &&
      node.kind !== IrKind.CallMutableMethod
    ) {
      return;
    }
    if (activeFuncs.has(node.func)) {
      depends = true;
      return;
    }
    const nextFuncs = new Set(activeFuncs);
    nextFuncs.add(node.func);
    const names = new Set<Name>([...node.func.params, ...node.func.locals]);
    if (node.func.callMode !== 'free') {
      names.add(node.func.receiver);
    }
    if (initializerDependsOnCurrentRow(node.func.body, names, nextFuncs)) {
      depends = true;
    }
  });
  return depends;
}

function unreachableGpuExpr(expr: never): never {
  return fatal(`unhandled GPU expression ${JSON.stringify(expr)}`);
}

function unreachableGpuStmt(stmt: never): never {
  return fatal(`unhandled GPU statement ${JSON.stringify(stmt)}`);
}

function unreachableGpuPlace(place: never): never {
  return fatal(`unhandled GPU place ${JSON.stringify(place)}`);
}
