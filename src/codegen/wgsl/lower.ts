// Purpose: Compile a generic Tea Program into one reusable, bind-independent WGSL artifact.

import type {Pos} from '../../base/pos';
import {formatPos} from '../../base/pos';
import {fatal} from '../../base/print';
import {paramSpecsOf} from '../params';
import {
  GPU_ARTIFACT_ABI_VERSION,
  GPU_BUFFER_GROUP,
  GPU_EFFECT_STATUS_BYTE_STRIDE,
  GPU_EXTERNAL_BUFFER_BINDINGS,
  GPU_JOB_DESCRIPTOR_BYTE_STRIDE,
  GPU_JOB_DESCRIPTOR_OFFSETS,
  GPU_RESULT_CELL_BYTE_STRIDE,
  GPU_SERIES_SCALAR_BYTE_STRIDE,
  type CompiledWgslProgram,
  type WgslEffectSchema,
  type WgslModule,
  type WgslNumericContract,
  type WgslOutputSchema,
  type WgslPhysicalField,
  type WgslPhysicalLayout,
  type WgslResultChannel,
  type WgslValueSchema,
} from '../../gpu/contract';
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
  walkIrExpr,
  walkIrStmt,
} from '../../ir/visit';
import type {
  WgslCompilationResult,
  WgslEligibilityIssue,
  WgslEligibilityIssueCode,
  WgslProgramInventory,
} from './types';
import {
  analyzeWgslEffects,
  WgslEffectAnalysisError,
  type WgslEffectAnalysis,
} from './effects-analysis';
import {
  MAX_WGSL_HISTORY_OFFSET,
  projectWgslFrames,
  WgslFrameProjectionError,
  type WgslFrameProjection,
  type WgslFrameLocalLayout,
  type WgslFrameTemplateLayout,
} from './frames';

const WORKGROUP_SIZE = 64;
const STORAGE_ENTRY_POINT = 'tea_main_storage';
const CACHED_ENTRY_POINT = 'tea_main_cached';
const WORKGROUP_SIZE_OVERRIDE = 'tea_workgroup_size';
const CACHE_WORDS_OVERRIDE = 'tea_cache_words_per_execution';
const CACHE_ALLOCATION_OVERRIDE = 'tea_cache_allocation_words';
const JOB_DESCRIPTOR_BYTES = GPU_JOB_DESCRIPTOR_BYTE_STRIDE;
const RESULT_CELL_BYTES = GPU_RESULT_CELL_BYTE_STRIDE;
const EFFECT_STATUS_BYTES = GPU_EFFECT_STATUS_BYTE_STRIDE;
const {
  jobs: GPU_JOBS_BINDING,
  series: GPU_SERIES_BINDING,
  executionStates: GPU_EXECUTION_STATES_BINDING,
  results: GPU_RESULTS_BINDING,
  effectStatus: GPU_EFFECT_STATUS_BINDING,
  effectRecords: GPU_EFFECT_RECORDS_BINDING,
  params: GPU_PARAMS_BINDING,
} = GPU_EXTERNAL_BUFFER_BINDINGS;
const {
  seriesOffset: JOB_SERIES_OFFSET,
  rowCount: JOB_ROW_COUNT_OFFSET,
  resultOffset: JOB_RESULT_OFFSET,
  resultCount: JOB_RESULT_COUNT_OFFSET,
  effectOffset: JOB_EFFECT_OFFSET,
  effectCapacity: JOB_EFFECT_CAPACITY_OFFSET,
  chunkRows: JOB_CHUNK_ROWS_OFFSET,
  paramsOffset: JOB_PARAMS_OFFSET,
} = GPU_JOB_DESCRIPTOR_OFFSETS;
const F32_ABSOLUTE_TOLERANCE = 0.0001;
const F32_RELATIVE_TOLERANCE = 0.00002;
const MAX_GPU_ROW = MAX_WGSL_HISTORY_OFFSET;
const MAX_U32 = 0xffff_ffff;

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
  private executionStateLayout = -1;
  private seriesScalarLayout = -1;
  private parameterLayout = -1;
  private resultCellLayout = -1;
  private effectStatusLayout = -1;
  private effectRecordLayout = -1;
  private maxEffectPayloadWords = 0;
  private frames: WgslFrameProjection | null = null;

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
      ...roots.filter(
        name => name.storage === 'var' && !packageGlobals.has(name),
      ),
    ];
    this.perBarRoots = roots.filter(name => name.storage === 'perBar');
    for (const name of roots) {
      if (name.storage === 'varip') {
        this.unsupported(
          'persistent-state-initialization-unimplemented',
          'varip execution is not part of the historical one-pass GPU subset',
        );
      }
      this.requireStaticDepth(name.depth, `name '${name.name}'`);
      this.collectType(name.type);
    }
    for (const func of this.funcs) {
      this.collectFunctionTypes(func);
    }
    for (const func of this.funcs) {
      this.collectExpressionTypes(func.body);
    }
    for (const stmt of [...this.program.init, ...this.program.body]) {
      walkIrStmt(stmt, {expr: expr => this.collectExpressionType(expr)});
    }
    for (const series of this.series) {
      if (series.type.kind !== TypeKind.Float) {
        this.unsupported(
          'host-value-type-unsupported',
          `GPU numeric series '${series.id}' has unsupported type ${formatType(series.type)}`,
        );
      }
      this.requireStaticDepth(series.depth, `series '${series.id}'`);
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
      entryPoint: STORAGE_ENTRY_POINT,
    };
    return {
      abi: GPU_ARTIFACT_ABI_VERSION,
      target: 'webgpu-wgsl',
      numeric: WGSL_F32_NUMERIC_CONTRACT,
      module,
      layouts: this.layouts,
      workgroupSize: [WORKGROUP_SIZE, 1, 1],
      externalBuffers: {
        group: GPU_BUFFER_GROUP,
        jobsBinding: GPU_EXTERNAL_BUFFER_BINDINGS.jobs,
        seriesBinding: GPU_EXTERNAL_BUFFER_BINDINGS.series,
        executionStatesBinding: GPU_EXTERNAL_BUFFER_BINDINGS.executionStates,
        resultsBinding: GPU_EXTERNAL_BUFFER_BINDINGS.results,
        effectStatusBinding: GPU_EXTERNAL_BUFFER_BINDINGS.effectStatus,
        effectRecordsBinding: GPU_EXTERNAL_BUFFER_BINDINGS.effectRecords,
        paramsBinding: GPU_EXTERNAL_BUFFER_BINDINGS.params,
      },
      jobDescriptorLayout: this.jobDescriptorLayout,
      jobDescriptorByteStride: GPU_JOB_DESCRIPTOR_BYTE_STRIDE,
      jobDescriptorOffsets: GPU_JOB_DESCRIPTOR_OFFSETS,
      parameterLayout: this.parameterLayout,
      parameterByteStride: this.layouts[this.parameterLayout].byteSize,
      executionStateLayout: this.executionStateLayout,
      executionStateByteStride:
        this.layouts[this.executionStateLayout].byteSize,
      state: this.stateManifest(),
      cache: this.cacheManifest(),
      seriesScalarLayout: this.seriesScalarLayout,
      seriesScalarByteStride: GPU_SERIES_SCALAR_BYTE_STRIDE,
      resultCellLayout: this.resultCellLayout,
      resultCellByteStride: GPU_RESULT_CELL_BYTE_STRIDE,
      effectStatusLayout: this.effectStatusLayout,
      effectStatusByteStride: GPU_EFFECT_STATUS_BYTE_STRIDE,
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

  private mustFrames(): WgslFrameProjection {
    return this.frames ?? fatal('WGSL frame projection is not built');
  }

  private stateManifest(): CompiledWgslProgram['state'] {
    const frames = this.mustFrames();
    return {
      initializedWordOffset: 0,
      nextRowWordOffset: 1,
      rootFrameWordOffset: 2,
      wordsPerExecution: 2 + frames.root.wordCount,
      frames: frames.templates.map(template => ({
        id: template.id,
        owner: template.ownerName,
        committedActivationWordOffset: template.committedActivationWordOffset,
        tentativeActivationWordOffset: template.tentativeActivationWordOffset,
        activationEncoding: template.activationEncoding,
        wordCount: template.wordCount,
        locals: template.locals.map(local => ({
          name: local.name.name,
          storage: local.name.storage === 'perBar' ? 'perBar' : 'var',
          scratchWordOffset: local.scratchWordOffset,
          valueWordCount: local.valueWordCount,
          committedInitWordOffset: local.committedInitWordOffset,
          tentativeInitWordOffset: local.tentativeInitWordOffset,
          historyWordOffset: local.historyWordOffset,
          historyCapacity: local.historyCapacity,
        })),
        children: template.children.map(child => ({
          slot: child.slot,
          templateId: child.templateId,
          wordOffset: child.wordOffset,
        })),
      })),
    };
  }

  private cacheManifest(): CompiledWgslProgram['cache'] {
    const frames = this.mustFrames();
    type PendingSegment = Omit<
      CompiledWgslProgram['cache']['segments'][number],
      'rank' | 'cacheWordOffset' | 'cacheEnd'
    >;
    const pending: PendingSegment[] = [];
    const add = (
      id: string,
      owner: string,
      kind: 'header' | 'activation' | 'local',
      storageWordOffset: number,
      wordCount: number,
      estimatedReadsPerRow: number,
      estimatedWritesPerRow: number,
    ): void => {
      if (wordCount <= 0) fatal(`empty WGSL cache segment '${id}'`);
      pending.push({
        id,
        owner,
        kind,
        storageWordOffset,
        wordCount,
        estimatedReadsPerRow,
        estimatedWritesPerRow,
      });
    };
    add('execution.header', '<execution>', 'header', 0, 2, 1, 1);
    const visit = (
      frame: WgslFrameTemplateLayout,
      frameBase: number,
      path: string,
    ): void => {
      add(
        `${path}.activation`,
        frame.ownerName,
        'activation',
        frameBase + frame.committedActivationWordOffset,
        2,
        2,
        2,
      );
      frame.locals.forEach((local, localIndex) => {
        let end = local.scratchWordOffset + local.valueWordCount;
        if (
          local.committedInitWordOffset !== null &&
          local.tentativeInitWordOffset !== null
        ) {
          end = Math.max(
            end,
            local.committedInitWordOffset + 1,
            local.tentativeInitWordOffset + 1,
          );
        }
        if (local.historyWordOffset !== null) {
          end = Math.max(
            end,
            local.historyWordOffset +
              local.historyCapacity * local.valueWordCount,
          );
        }
        const persistent = local.name.storage !== 'perBar';
        add(
          `${path}.local.${localIndex}`,
          `${frame.ownerName}.${local.name.name}`,
          'local',
          frameBase + local.scratchWordOffset,
          end - local.scratchWordOffset,
          persistent ? 4 : local.historyCapacity > 0 ? 2 : 1,
          persistent ? 4 : local.historyCapacity > 0 ? 2 : 1,
        );
      });
      frame.children.forEach(child => {
        const childFrame = frames.templates[child.templateId];
        if (childFrame === undefined) {
          fatal(`unmapped WGSL child frame template ${child.templateId}`);
        }
        visit(
          childFrame,
          frameBase + child.wordOffset,
          `${path}.call.${child.slot}`,
        );
      });
    };
    visit(frames.root, 2, 'root');
    const state = this.stateManifest();
    let storageEnd = 0;
    for (const segment of [...pending].sort(
      (left, right) => left.storageWordOffset - right.storageWordOffset,
    )) {
      if (segment.storageWordOffset !== storageEnd) {
        fatal(`non-contiguous WGSL state segment '${segment.id}'`);
      }
      storageEnd += segment.wordCount;
    }
    if (storageEnd !== state.wordsPerExecution) {
      fatal(
        `WGSL cache segments cover ${storageEnd} words; state owns ${state.wordsPerExecution}`,
      );
    }
    let cacheEnd = 0;
    const segments = pending
      .sort((left, right) => {
        const leftAccesses =
          left.estimatedReadsPerRow + left.estimatedWritesPerRow;
        const rightAccesses =
          right.estimatedReadsPerRow + right.estimatedWritesPerRow;
        return (
          rightAccesses - leftAccesses ||
          left.wordCount - right.wordCount ||
          left.storageWordOffset - right.storageWordOffset
        );
      })
      .map((segment, rank) => {
        const cacheWordOffset = cacheEnd;
        cacheEnd += segment.wordCount;
        return {...segment, rank, cacheWordOffset, cacheEnd};
      });
    return {
      storageEntryPoint: STORAGE_ENTRY_POINT,
      cachedEntryPoint: CACHED_ENTRY_POINT,
      overrides: {
        workgroupSize: {
          numericId: 0,
          id: WORKGROUP_SIZE_OVERRIDE,
          defaultValue: WORKGROUP_SIZE,
        },
        cacheWordsPerExecution: {
          numericId: 1,
          id: CACHE_WORDS_OVERRIDE,
          defaultValue: 0,
        },
        cacheAllocationWords: {
          numericId: 2,
          id: CACHE_ALLOCATION_OVERRIDE,
          defaultValue: 1,
        },
      },
      segments,
    };
  }

  private requireStaticDepth(
    depth: Name['depth'] | SeriesInput['depth'],
    owner: string,
  ): void {
    if (depth.kind === DepthKind.None) return;
    if (
      depth.kind === DepthKind.Const &&
      Number.isSafeInteger(depth.bars) &&
      depth.bars >= 0
    ) {
      return;
    }
    this.unsupported(
      'history-layout-unimplemented',
      `${owner} requires bind-computed or invalid history depth`,
    );
  }

  private collectFunctionTypes(func: IrFunc): void {
    if (func.callMode !== 'free') {
      this.collectType(func.receiver.type);
    }
    for (const name of [...func.params, ...func.locals]) {
      this.collectType(name.type);
      if (name.storage === 'varip') {
        this.unsupported(
          'function-frame-lowering-unimplemented',
          'varip function locals are outside the historical GPU subset',
        );
      }
      this.requireStaticDepth(name.depth, `function name '${name.name}'`);
    }
    this.collectType(func.resultType);
  }

  private collectExpressionTypes(expr: IrExpr): void {
    walkIrExpr(expr, {expr: node => this.collectExpressionType(node)});
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
    walkIrStmt(stmt, {
      stmt: node => {
        if (node.kind === IrKind.Emit) {
          this.unsupported(
            'result-transport-lowering-unimplemented',
            'conditional or nested GPU result emissions are unsupported',
            node.pos,
          );
        }
      },
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
      walkIrExpr(func.body, {
        expr: expr => {
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
        },
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
    for (const name of namesOf(this.program)) this.physicalLayoutOf(name.type);
    for (const effect of this.program.effects) {
      const layout = this.layouts[this.physicalLayoutOf(effect.payloadType)];
      this.maxEffectPayloadWords = Math.max(
        this.maxEffectPayloadWords,
        layout.byteSize / 4,
      );
    }
    try {
      this.frames = projectWgslFrames(
        this.program,
        name => this.layouts[this.physicalLayoutOf(name.type)].byteSize / 4,
      );
    } catch (error) {
      if (error instanceof WgslFrameProjectionError) {
        this.unsupported(
          error.message.includes('history')
            ? 'history-layout-unimplemented'
            : 'function-frame-lowering-unimplemented',
          error.message,
        );
      }
      throw error;
    }
    const frames = this.frames;
    const wordsPerExecution = 2 + frames.root.wordCount;
    const executionStateByteSize = wordsPerExecution * 4;
    if (
      !Number.isSafeInteger(wordsPerExecution) ||
      wordsPerExecution > MAX_U32 ||
      !Number.isSafeInteger(executionStateByteSize) ||
      executionStateByteSize > MAX_U32
    ) {
      this.unsupported(
        'history-layout-unimplemented',
        `GPU execution history state requires ${wordsPerExecution} words (${executionStateByteSize} bytes), exceeding the u32 physical-layout limit`,
      );
    }
    const stateFields: WgslPhysicalField[] = [
      {path: 'initialized', scalar: 'u32', byteOffset: 0},
      {path: 'next_row', scalar: 'u32', byteOffset: 4},
    ];
    this.executionStateLayout = this.addLayout(
      'TeaExecutionState',
      executionStateByteSize,
      stateFields,
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
    out.push(
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
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_EXECUTION_STATES_BINDING}) var<storage, read_write> tea_execution_states: array<u32>;`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_RESULTS_BINDING}) var<storage, read_write> tea_results: array<TeaResultCell>;`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_EFFECT_STATUS_BINDING}) var<storage, read_write> tea_effect_status: array<TeaEffectStatus>;`,
      `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_EFFECT_RECORDS_BINDING}) var<storage, read_write> tea_effect_records: array<TeaEffectRecord>;`,
      ...(this.program.params.length === 0
        ? []
        : [
            `@group(${GPU_BUFFER_GROUP}) @binding(${GPU_PARAMS_BINDING}) var<storage, read> tea_params: array<u32>;`,
          ]),
      `@id(0) override ${WORKGROUP_SIZE_OVERRIDE}: u32 = ${WORKGROUP_SIZE}u;`,
      `@id(1) override ${CACHE_WORDS_OVERRIDE}: u32 = 0u;`,
      `@id(2) override ${CACHE_ALLOCATION_OVERRIDE}: u32 = 1u;`,
      `var<workgroup> tea_execution_state_cache: array<u32, ${CACHE_ALLOCATION_OVERRIDE}>;`,
      'var<private> tea_execution_state_base: u32;',
      'var<private> tea_execution_cache_base: u32;',
      ...this.emitCacheHelpers(),
      ...this.emitHelpers(),
      ...this.emitFrameHelpers(),
    );
    for (const func of this.funcs) {
      out.push(...this.emitFunction(func));
    }
    out.push(...this.emitKernel());
    return `${out.join('\n')}\n`;
  }

  private emitCacheHelpers(): string[] {
    const segments = this.cacheManifest().segments;
    const storageSegments = [...segments].sort(
      (left, right) => left.storageWordOffset - right.storageWordOffset,
    );
    const storageWords = storageSegments.reduce(
      (end, segment) =>
        Math.max(end, segment.storageWordOffset + segment.wordCount),
      0,
    );
    const out = [
      'fn tea_state_cache_index(tea_word: u32) -> u32 {',
      `  if (${CACHE_WORDS_OVERRIDE} == 0u) { return 0xffffffffu; }`,
      '  if (tea_word < tea_execution_state_base) { return 0xffffffffu; }',
      '  let tea_local_word = tea_word - tea_execution_state_base;',
      `  if (tea_local_word >= ${storageWords}u) { return 0xffffffffu; }`,
    ];
    const emitLookup = (
      candidates: typeof storageSegments,
      indentLevel: number,
    ): void => {
      if (candidates.length === 1) {
        const segment = candidates[0];
        if (segment === undefined) fatal('empty WGSL cache lookup leaf');
        const padding = '  '.repeat(indentLevel);
        out.push(
          `${padding}if (${CACHE_WORDS_OVERRIDE} >= ${segment.cacheEnd}u) {`,
          `${padding}  return tea_execution_cache_base + ${segment.cacheWordOffset}u + tea_local_word - ${segment.storageWordOffset}u;`,
          `${padding}}`,
        );
        return;
      }
      const middle = Math.floor(candidates.length / 2);
      const right = candidates.slice(middle);
      const boundary = right[0]?.storageWordOffset;
      if (boundary === undefined) fatal('empty WGSL cache lookup branch');
      const padding = '  '.repeat(indentLevel);
      out.push(`${padding}if (tea_local_word < ${boundary}u) {`);
      emitLookup(candidates.slice(0, middle), indentLevel + 1);
      out.push(`${padding}} else {`);
      emitLookup(right, indentLevel + 1);
      out.push(`${padding}}`);
    };
    emitLookup(storageSegments, 1);
    out.push(
      '  return 0xffffffffu;',
      '}',
      'fn tea_state_load(tea_word: u32) -> u32 {',
      '  let tea_cache_index = tea_state_cache_index(tea_word);',
      '  if (tea_cache_index != 0xffffffffu) {',
      '    return tea_execution_state_cache[tea_cache_index];',
      '  }',
      '  return tea_execution_states[tea_word];',
      '}',
      'fn tea_state_store(tea_word: u32, tea_value: u32) {',
      '  let tea_cache_index = tea_state_cache_index(tea_word);',
      '  if (tea_cache_index != 0xffffffffu) {',
      '    tea_execution_state_cache[tea_cache_index] = tea_value;',
      '  } else {',
      '    tea_execution_states[tea_word] = tea_value;',
      '  }',
      '}',
      'fn tea_cache_load() {',
    );
    segments.forEach((segment, index) => {
      out.push(
        `  if (${CACHE_WORDS_OVERRIDE} >= ${segment.cacheEnd}u) {`,
        `    for (var tea_segment_word_${index} = 0u; tea_segment_word_${index} < ${segment.wordCount}u; tea_segment_word_${index} = tea_segment_word_${index} + 1u) {`,
        `      tea_execution_state_cache[tea_execution_cache_base + ${segment.cacheWordOffset}u + tea_segment_word_${index}] = tea_execution_states[tea_execution_state_base + ${segment.storageWordOffset}u + tea_segment_word_${index}];`,
        '    }',
        '  }',
      );
    });
    out.push('}', 'fn tea_cache_flush() {');
    segments.forEach((segment, index) => {
      out.push(
        `  if (${CACHE_WORDS_OVERRIDE} >= ${segment.cacheEnd}u) {`,
        `    for (var tea_segment_word_${index} = 0u; tea_segment_word_${index} < ${segment.wordCount}u; tea_segment_word_${index} = tea_segment_word_${index} + 1u) {`,
        `      tea_execution_states[tea_execution_state_base + ${segment.storageWordOffset}u + tea_segment_word_${index}] = tea_execution_state_cache[tea_execution_cache_base + ${segment.cacheWordOffset}u + tea_segment_word_${index}];`,
        '    }',
        '  }',
      );
    });
    out.push('}');
    return out;
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
      'fn tea_note_effect_overflow(execution_index: u32, row: u32, effect_id: u32) {',
      '  if (tea_effect_status[execution_index].overflow == 0u) {',
      '    tea_effect_status[execution_index].first_overflow_row = row;',
      '    tea_effect_status[execution_index].first_overflow_effect = effect_id;',
      '  }',
      '  tea_effect_status[execution_index].overflow = 1u;',
      '}',
    ];
  }

  private emitFrameHelpers(): string[] {
    const out: string[] = [];
    for (const frame of [...this.mustFrames().templates].reverse()) {
      out.push(
        `fn tea_reset_frame_${frame.id}(tea_frame_base: u32, tea_row: u32) {`,
        `  let tea_activation: u32 = tea_state_load(tea_frame_base + ${frame.committedActivationWordOffset}u);`,
        `  tea_state_store(tea_frame_base + ${frame.tentativeActivationWordOffset}u, tea_activation);`,
        '  if (tea_activation != 0u) {',
      );
      for (const local of frame.locals) {
        if (
          local.committedInitWordOffset !== null &&
          local.tentativeInitWordOffset !== null
        ) {
          out.push(
            `    tea_state_store(tea_frame_base + ${local.tentativeInitWordOffset}u, tea_state_load(tea_frame_base + ${local.committedInitWordOffset}u));`,
          );
        }
        if (local.name.storage === 'perBar') {
          this.emitStateStore(
            local.name.type,
            `tea_frame_base + ${local.scratchWordOffset}u`,
            this.empty(local.name.type),
            out,
            2,
          );
          continue;
        }
        const reset: string[] = [];
        this.emitStateStore(
          local.name.type,
          `tea_frame_base + ${local.scratchWordOffset}u`,
          this.empty(local.name.type),
          reset,
          0,
        );
        if (
          local.committedInitWordOffset === null ||
          local.historyWordOffset === null ||
          local.historyCapacity < 1
        ) {
          return fatal(
            `persistent WGSL local '${local.name.name}' lacks state`,
          );
        }
        out.push(
          `    if (tea_state_load(tea_frame_base + ${local.committedInitWordOffset}u) != 0u && tea_row > 0u) {`,
          `      let tea_ring_${frame.id}_${local.scratchWordOffset}: u32 = (tea_row - 1u) % ${local.historyCapacity}u;`,
        );
        this.emitStateCopy(
          local.name.type,
          `tea_frame_base + ${local.scratchWordOffset}u`,
          `tea_frame_base + ${local.historyWordOffset}u + tea_ring_${frame.id}_${local.scratchWordOffset} * ${local.valueWordCount}u`,
          out,
          3,
        );
        out.push('    } else {', ...indent(reset, 3), '    }');
      }
      out.push('  }');
      for (const child of frame.children) {
        out.push(
          `  tea_reset_frame_${child.templateId}(tea_frame_base + ${child.wordOffset}u, tea_row);`,
        );
      }
      out.push('}');

      out.push(
        `fn tea_commit_frame_${frame.id}(tea_frame_base: u32, tea_row: u32) {`,
        `  let tea_activation: u32 = tea_state_load(tea_frame_base + ${frame.tentativeActivationWordOffset}u);`,
        '  if (tea_activation != 0u) {',
        `    tea_state_store(tea_frame_base + ${frame.committedActivationWordOffset}u, tea_activation);`,
      );
      for (const local of frame.locals) {
        if (
          local.committedInitWordOffset !== null &&
          local.tentativeInitWordOffset !== null
        ) {
          out.push(
            `    tea_state_store(tea_frame_base + ${local.committedInitWordOffset}u, tea_state_load(tea_frame_base + ${local.tentativeInitWordOffset}u));`,
          );
        }
        if (local.historyWordOffset !== null && local.historyCapacity > 0) {
          out.push(
            `    let tea_ring_${frame.id}_${local.scratchWordOffset}: u32 = tea_row % ${local.historyCapacity}u;`,
          );
          this.emitStateCopy(
            local.name.type,
            `tea_frame_base + ${local.historyWordOffset}u + tea_ring_${frame.id}_${local.scratchWordOffset} * ${local.valueWordCount}u`,
            `tea_frame_base + ${local.scratchWordOffset}u`,
            out,
            2,
          );
        }
      }
      out.push('  }');
      for (const child of frame.children) {
        out.push(
          `  tea_commit_frame_${child.templateId}(tea_frame_base + ${child.wordOffset}u, tea_row);`,
        );
      }
      out.push('}');
    }
    return out;
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
      'tea_root_base: u32',
      'tea_frame_base: u32',
      'tea_execution_index: u32',
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
    const frame =
      this.mustFrames().templateByFunc.get(func) ??
      fatal(`unmapped frame template for '${func.name}'`);
    const ephemeralFormals =
      this.mustFrames().ephemeralFormalsByFunc.get(func) ??
      fatal(`unmapped ephemeral formals for '${func.name}'`);
    const functionLocals = new Map<Name, string>();
    out.push(
      `  if (tea_state_load(tea_frame_base + ${frame.tentativeActivationWordOffset}u) == 0u) {`,
      `    tea_state_store(tea_frame_base + ${frame.tentativeActivationWordOffset}u, tea_row + 1u);`,
      '  }',
    );
    parameters.forEach((name, index) => {
      if (ephemeralFormals.has(name)) {
        const localName = `tea_arg_${index}`;
        functionLocals.set(name, localName);
        out.push(
          `  var ${localName}: ${this.wgslType(name.type)} = p${index};`,
        );
        return;
      }
      const local =
        frame.locals.find(candidate => candidate.name === name) ??
        fatal(`unmapped frame parameter '${name.name}'`);
      this.emitStateStore(
        name.type,
        `tea_frame_base + ${local.scratchWordOffset}u`,
        `p${index}`,
        out,
        1,
      );
    });
    const body: string[] = [];
    const ctx: WgslContext = {
      frame,
      frameBase: 'tea_frame_base',
      rootBase: 'tea_root_base',
      functionLocals,
      allowDenseEmit: false,
      allowEffect: true,
      executionIndex: 'tea_execution_index',
      job: 'tea_job',
      row: 'tea_row',
      chunkRow: '0u',
    };
    const value = this.emitExpr(func.body, ctx, body);
    out.push(...indent(body, 1));
    const result = this.coerce(value, func.body.type, func.resultType);
    if (func.callMode === 'mutable-method') {
      const receiver = this.emitCurrentNameRead(func.receiver, ctx);
      out.push(`  return ${resultType}(${receiver}, ${result});`);
    } else {
      out.push(`  return ${result};`);
    }
    out.push('}');
    return out;
  }

  private locateName(name: Name, ctx: WgslContext): WgslNameLocation {
    const local = ctx.frame.locals.find(candidate => candidate.name === name);
    if (local !== undefined) {
      return {frame: ctx.frame, frameBase: ctx.frameBase, local};
    }
    const root = this.mustFrames().root;
    const rootLocal = root.locals.find(candidate => candidate.name === name);
    if (rootLocal !== undefined) {
      return {frame: root, frameBase: ctx.rootBase, local: rootLocal};
    }
    return this.unsupported(
      'function-frame-lowering-unimplemented',
      `name '${name.name}' is outside the active GPU frame`,
    );
  }

  private emitCurrentNameRead(name: Name, ctx: WgslContext): string {
    const functionLocal = ctx.functionLocals.get(name);
    if (functionLocal !== undefined) return functionLocal;
    const location = this.locateName(name, ctx);
    return this.emitStateLoad(
      name.type,
      `${location.frameBase} + ${location.local.scratchWordOffset}u`,
    );
  }

  private emitCurrentNameStore(
    name: Name,
    value: string,
    ctx: WgslContext,
    out: string[],
    indentLevel = 0,
  ): void {
    const functionLocal = ctx.functionLocals.get(name);
    if (functionLocal !== undefined) {
      out.push(`${'  '.repeat(indentLevel)}${functionLocal} = ${value};`);
      return;
    }
    const location = this.locateName(name, ctx);
    this.emitStateStore(
      name.type,
      `${location.frameBase} + ${location.local.scratchWordOffset}u`,
      value,
      out,
      indentLevel,
    );
  }

  private emitKernel(): string[] {
    const frames = this.mustFrames();
    const state = this.stateManifest();
    const out = [
      'fn tea_execute(tea_job_index: u32) {',
      '  if (tea_job_index >= arrayLength(&tea_jobs) || tea_job_index >= arrayLength(&tea_effect_status)) { return; }',
      '  let tea_execution_base: u32 = tea_execution_state_base;',
      `  let tea_root_base: u32 = tea_execution_base + ${state.rootFrameWordOffset}u;`,
      '  let tea_job = tea_jobs[tea_job_index];',
      '  if (tea_job.chunk_rows == 0u) { return; }',
      ...(this.outputCells.size === 0
        ? ['  if (tea_job.result_count != 0u) { return; }']
        : [
            `  let tea_final_dense_only = tea_job.result_count == ${this.outputCells.size}u;`,
            `  if (!tea_final_dense_only && tea_job.result_count / ${this.outputCells.size}u < tea_job.chunk_rows) { return; }`,
          ]),
      '  tea_effect_status[tea_job_index] = TeaEffectStatus(0u, 0u, 0u, 0u);',
      `  if (tea_state_load(tea_execution_base + ${state.initializedWordOffset}u) == 0u) {`,
      `    tea_state_store(tea_execution_base + ${state.initializedWordOffset}u, 1u);`,
      `    tea_state_store(tea_execution_base + ${state.nextRowWordOffset}u, 0u);`,
      `    tea_state_store(tea_root_base + ${frames.root.committedActivationWordOffset}u, 1u);`,
      `    tea_state_store(tea_root_base + ${frames.root.tentativeActivationWordOffset}u, 1u);`,
      '  }',
    ];
    out.push(
      `  let tea_start_row = tea_state_load(tea_execution_base + ${state.nextRowWordOffset}u);`,
      '  if (tea_start_row >= tea_job.row_count) { return; }',
      '  let tea_chunk_count = min(tea_job.chunk_rows, tea_job.row_count - tea_start_row);',
      '  for (var tea_chunk_row = 0u; tea_chunk_row < tea_chunk_count; tea_chunk_row = tea_chunk_row + 1u) {',
      '    let tea_row = tea_start_row + tea_chunk_row;',
      `    tea_reset_frame_${frames.root.id}(tea_root_base, tea_row);`,
    );
    const body: string[] = [];
    const ctx: WgslContext = {
      frame: frames.root,
      frameBase: 'tea_root_base',
      rootBase: 'tea_root_base',
      functionLocals: new Map(),
      allowDenseEmit: true,
      allowEffect: true,
      executionIndex: 'tea_job_index',
      job: 'tea_job',
      row: 'tea_row',
      chunkRow: 'tea_chunk_row',
    };
    for (const stmt of this.program.body) {
      this.emitStmt(stmt, ctx, body);
    }
    out.push(
      ...indent(body, 2),
      `    tea_commit_frame_${frames.root.id}(tea_root_base, tea_row);`,
      '  }',
      `  tea_state_store(tea_execution_base + ${state.nextRowWordOffset}u, tea_start_row + tea_chunk_count);`,
      '}',
      `@compute @workgroup_size(${WORKGROUP_SIZE_OVERRIDE}, 1, 1)`,
      `fn ${STORAGE_ENTRY_POINT}(@builtin(global_invocation_id) tea_gid: vec3<u32>) {`,
      `  tea_execution_state_base = tea_gid.x * ${state.wordsPerExecution}u;`,
      '  tea_execution_cache_base = 0u;',
      '  if (tea_execution_state_base > arrayLength(&tea_execution_states) || arrayLength(&tea_execution_states) - tea_execution_state_base < ' +
        `${state.wordsPerExecution}u) { return; }`,
      '  tea_execute(tea_gid.x);',
      '}',
      `@compute @workgroup_size(${WORKGROUP_SIZE_OVERRIDE}, 1, 1)`,
      `fn ${CACHED_ENTRY_POINT}(`,
      '  @builtin(global_invocation_id) tea_gid: vec3<u32>,',
      '  @builtin(local_invocation_id) tea_local_id: vec3<u32>,',
      ') {',
      `  tea_execution_state_base = tea_gid.x * ${state.wordsPerExecution}u;`,
      `  tea_execution_cache_base = tea_local_id.x * ${CACHE_WORDS_OVERRIDE};`,
      '  if (tea_execution_state_base > arrayLength(&tea_execution_states) || arrayLength(&tea_execution_states) - tea_execution_state_base < ' +
        `${state.wordsPerExecution}u) { return; }`,
      '  tea_cache_load();',
      '  tea_execute(tea_gid.x);',
      '  tea_cache_flush();',
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
      case IrKind.InitName: {
        const location = this.locateName(stmt.name, ctx);
        if (location.local.tentativeInitWordOffset === null) {
          return fatal(
            `per-bar name '${stmt.name.name}' reached persistent WGSL initialization`,
          );
        }
        out.push(
          `if (tea_state_load(${location.frameBase} + ${location.local.tentativeInitWordOffset}u) == 0u) {`,
        );
        const initializer: string[] = [];
        const value = this.emitExpr(stmt.value, ctx, initializer);
        out.push(...indent(initializer, 1));
        this.emitCurrentNameStore(
          stmt.name,
          this.coerce(value, stmt.value.type, stmt.name.type),
          ctx,
          out,
          1,
        );
        out.push(
          `  tea_state_store(${location.frameBase} + ${location.local.tentativeInitWordOffset}u, 1u);`,
          '}',
        );
        return;
      }
      case IrKind.WriteName: {
        const value = this.emitExpr(stmt.value, ctx, out);
        this.emitCurrentNameStore(
          stmt.name,
          this.coerce(value, stmt.value.type, stmt.name.type),
          ctx,
          out,
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
        if (stmt.path.root.type.kind !== TypeKind.UserType) {
          return fatal('malformed rooted user update reached WGSL lowering');
        }
        const root = this.emitCurrentNameRead(stmt.path.root, ctx);
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
        );
        this.emitCurrentNameStore(stmt.path.root, rebuilt, ctx, rhs);
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
        const resultRow = this.fresh();
        out.push(
          `let ${resultRow}: u32 = select(${ctx.chunkRow}, 0u, ${ctx.job}.result_count == ${this.outputCells.size}u);`,
          `let ${slot}: u32 = ${ctx.job}.result_offset + ${resultRow} * ${this.outputCells.size}u + ${rowCell}u;`,
        );
        out.push(
          `if ((${ctx.job}.result_count != ${this.outputCells.size}u || ${ctx.row} + 1u == ${ctx.job}.row_count) && ${slot} < arrayLength(&tea_results) && ${slot} < ${ctx.job}.result_offset + ${ctx.job}.result_count) {`,
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
      `let ${cursor}: u32 = tea_effect_status[${ctx.executionIndex}].count;`,
      `if (${ctx.job}.effect_capacity > 0u) {`,
      `  if (${cursor} < ${ctx.job}.effect_capacity) {`,
      `  let ${slot}: u32 = ${ctx.job}.effect_offset + ${cursor};`,
      `  if (${slot} >= ${ctx.job}.effect_offset && ${slot} < arrayLength(&tea_effect_records)) {`,
      `    var ${record}: TeaEffectRecord = TeaEffectRecord(${ctx.row}, ${effectId}u, array<u32, ${payloadWords}>(${new Array(payloadWords).fill('0u').join(', ')}));`,
    );
    const assignments: string[] = [];
    this.emitEffectPayloadWords(payloadType, payload, record, 0, assignments);
    out.push(
      ...indent(assignments, 2),
      `    tea_effect_records[${slot}] = ${record};`,
      `    tea_effect_status[${ctx.executionIndex}].count = ${cursor} + 1u;`,
      '  } else {',
      `    tea_note_effect_overflow(${ctx.executionIndex}, ${ctx.row}, ${effectId}u);`,
      '  }',
      '} else {',
      `  tea_note_effect_overflow(${ctx.executionIndex}, ${ctx.row}, ${effectId}u);`,
      '  }',
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
    const offset = this.historyOffset(expr.offset, expr.pos);
    if (offset === null) return this.empty(expr.type);
    switch (expr.place.kind) {
      case PlaceKind.Name: {
        if (offset === 0) {
          return this.emitCurrentNameRead(expr.place.name, ctx);
        }
        const location = this.locateName(expr.place.name, ctx);
        if (
          location.local.historyWordOffset === null ||
          location.local.historyCapacity < offset
        ) {
          return fatal(
            `WGSL history layout for '${expr.place.name.name}' is shallower than offset ${offset}`,
          );
        }
        const result = this.fresh('history');
        const activation = this.fresh('activation');
        const ring = this.fresh('ring');
        out.push(
          `var ${result}: ${this.wgslType(expr.type)} = ${this.empty(expr.type)};`,
          `let ${activation}: u32 = tea_state_load(${location.frameBase} + ${location.frame.committedActivationWordOffset}u);`,
          `if (${activation} != 0u && ${ctx.row} + 1u >= ${activation} + ${offset}u) {`,
          `  let ${ring}: u32 = (${ctx.row} - ${offset}u) % ${location.local.historyCapacity}u;`,
          `  ${result} = ${this.emitStateLoad(
            expr.place.name.type,
            `${location.frameBase} + ${location.local.historyWordOffset}u + ${ring} * ${location.local.valueWordCount}u`,
          )};`,
          '}',
        );
        return result;
      }
      case PlaceKind.Series: {
        const ordinal = this.seriesIds.get(expr.place.series);
        if (ordinal === undefined) {
          return fatal(`unmapped series '${expr.place.series.id}'`);
        }
        const result = this.fresh();
        if (offset === 0) {
          out.push(
            `let ${result}: TeaFloat = tea_float(tea_series[${ctx.job}.series_offset + ${ordinal}u * ${ctx.job}.row_count + ${ctx.row}]);`,
          );
        } else {
          out.push(
            `var ${result}: TeaFloat = TeaFloat(0u, 0.0);`,
            `if (${ctx.row} >= ${offset}u) {`,
            `  ${result} = tea_float(tea_series[${ctx.job}.series_offset + ${ordinal}u * ${ctx.job}.row_count + ${ctx.row} - ${offset}u]);`,
            '}',
          );
        }
        return result;
      }
      case PlaceKind.Execution:
        if (offset > 0) {
          return this.unsupported(
            'history-layout-unimplemented',
            'historical execution-input reads are outside the current GPU subset',
            expr.pos,
          );
        }
        return this.emitExecution(expr.place.execution, expr.pos, ctx, out);
      case PlaceKind.Param: {
        // Bind-time parameters are constant over the full row axis, so every
        // valid historical read is the same fixed value.
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

  private historyOffset(offset: IrExpr | null, pos: Pos): number | null {
    if (offset === null) return 0;
    if (offset.kind !== IrKind.Const) {
      return this.unsupported(
        'history-layout-unimplemented',
        'GPU history offsets require a non-negative const int',
        pos,
      );
    }
    if (
      offset.type.kind !== TypeKind.Int ||
      isNaValue(offset.value) ||
      typeof offset.value !== 'number' ||
      !Number.isSafeInteger(offset.value) ||
      offset.value < 0 ||
      offset.value > MAX_GPU_ROW
    ) {
      return null;
    }
    return offset.value;
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
    const child = ctx.frame.children.find(
      candidate =>
        candidate.slot === expr.slot && candidate.callee === expr.func,
    );
    if (child === undefined) {
      return fatal(
        `WGSL call slot ${expr.slot} for '${expr.func.name}' has no child frame`,
      );
    }
    const callArgs = [
      ctx.rootBase,
      `${ctx.frameBase} + ${child.wordOffset}u`,
      ctx.executionIndex,
      ctx.job,
      ctx.row,
      ...explicitArgs,
    ];
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
    let type = path.root.type;
    if (path.fieldIndices.length === 0) {
      if (!assignable(valueType, type)) {
        fatal('ill-typed root write reached GPU lowering');
      }
      this.emitCurrentNameStore(
        path.root,
        this.coerce(value, valueType, type),
        ctx,
        out,
      );
      return;
    }
    const root = this.fresh('path_root');
    out.push(
      `var ${root}: ${this.wgslType(path.root.type)} = ${this.emitCurrentNameRead(path.root, ctx)};`,
    );
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
    const update = [assignment];
    this.emitCurrentNameStore(path.root, root, ctx, update);
    out.push(`if (${guards.join(' && ')}) {`, ...indent(update, 1), '}');
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

  private stateIndex(base: string, offset: number): string {
    return offset === 0 ? base : `${base} + ${offset}u`;
  }

  private emitStateLoad(type: Type, base: string, wordOffset = 0): string {
    const word = (offset: number): string =>
      `tea_state_load(${this.stateIndex(base, wordOffset + offset)})`;
    switch (type.kind) {
      case TypeKind.Bool:
      case TypeKind.Void:
        return word(0);
      case TypeKind.Int:
        return `TeaInt(${word(0)}, bitcast<i32>(${word(1)}))`;
      case TypeKind.Float:
        return `TeaFloat(${word(0)}, bitcast<f32>(${word(1)}))`;
      case TypeKind.Enum:
        return `TeaEnum(${word(0)}, ${word(1)})`;
      case TypeKind.String:
        return `TeaString(${word(0)}, ${word(1)})`;
      case TypeKind.Color:
        return `TeaColor(${word(0)}, ${word(1)})`;
      case TypeKind.UserType: {
        let nestedOffset = wordOffset + 1;
        const fields = type.fields.map(field => {
          const value = this.emitStateLoad(field.type, base, nestedOffset);
          nestedOffset +=
            this.layouts[this.physicalLayoutOf(field.type)].byteSize / 4;
          return value;
        });
        return `${this.userName(type)}(${word(0)}${fields.map(value => `, ${value}`).join('')})`;
      }
      default:
        return this.unsupported(
          'host-value-type-unsupported',
          `cannot load ${formatType(type)} from GPU frame state`,
        );
    }
  }

  private emitStateStore(
    type: Type,
    base: string,
    value: string,
    out: string[],
    indentLevel = 0,
    wordOffset = 0,
  ): void {
    const line = (text: string): void => {
      out.push(`${'  '.repeat(indentLevel)}${text}`);
    };
    const target = (offset: number): string =>
      this.stateIndex(base, wordOffset + offset);
    switch (type.kind) {
      case TypeKind.Bool:
      case TypeKind.Void:
        line(`tea_state_store(${target(0)}, ${value});`);
        return;
      case TypeKind.Int:
      case TypeKind.Float:
        line(`tea_state_store(${target(0)}, ${value}.valid);`);
        line(`tea_state_store(${target(1)}, bitcast<u32>(${value}.value));`);
        return;
      case TypeKind.Enum:
      case TypeKind.String:
      case TypeKind.Color:
        line(`tea_state_store(${target(0)}, ${value}.valid);`);
        line(`tea_state_store(${target(1)}, ${value}.value);`);
        return;
      case TypeKind.UserType: {
        line(`tea_state_store(${target(0)}, ${value}.valid);`);
        let nestedOffset = wordOffset + 1;
        type.fields.forEach((field, index) => {
          this.emitStateStore(
            field.type,
            base,
            `${value}.f${index}`,
            out,
            indentLevel,
            nestedOffset,
          );
          nestedOffset +=
            this.layouts[this.physicalLayoutOf(field.type)].byteSize / 4;
        });
        return;
      }
      default:
        this.unsupported(
          'host-value-type-unsupported',
          `cannot store ${formatType(type)} in GPU frame state`,
        );
    }
  }

  private emitStateCopy(
    type: Type,
    targetBase: string,
    sourceBase: string,
    out: string[],
    indentLevel = 0,
  ): void {
    const value = this.fresh('state_copy');
    out.push(
      `${'  '.repeat(indentLevel)}let ${value}: ${this.wgslType(type)} = ${this.emitStateLoad(type, sourceBase)};`,
    );
    this.emitStateStore(type, targetBase, value, out, indentLevel);
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
  readonly frame: WgslFrameTemplateLayout;
  readonly frameBase: string;
  readonly rootBase: string;
  readonly functionLocals: ReadonlyMap<Name, string>;
  readonly allowDenseEmit: boolean;
  readonly allowEffect: boolean;
  readonly executionIndex: string;
  readonly job: string;
  readonly row: string;
  readonly chunkRow: string;
}

interface WgslNameLocation {
  readonly frame: WgslFrameTemplateLayout;
  readonly frameBase: string;
  readonly local: WgslFrameLocalLayout;
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

function unreachableGpuExpr(expr: never): never {
  return fatal(`unhandled GPU expression ${JSON.stringify(expr)}`);
}

function unreachableGpuStmt(stmt: never): never {
  return fatal(`unhandled GPU statement ${JSON.stringify(stmt)}`);
}

function unreachableGpuPlace(place: never): never {
  return fatal(`unhandled GPU place ${JSON.stringify(place)}`);
}
