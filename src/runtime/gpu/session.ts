// Purpose: Prepare generic runtime bindings and bounded resources for a resumable WGSL execution session.

/// <reference types="@webgpu/types" />

import type {
  CompiledWgslProgram,
  WgslResultChannel,
  WgslValueSchema,
} from '../../codegen/wgsl/types';
import {
  isContextError,
  type BindInputs,
  type BoundInput,
  type ContextError,
  type DataProvider,
  type DenseEmission,
  type EffectEmission,
  type EffectValue,
  type ExecutionDeclaration,
  type ProviderContext,
  type RowPublication,
  type SeriesData,
  type Value,
} from '../abi';
import {resolveParamValues} from '../params';

const MAX_U32 = 0xffff_ffff;
const MAX_I32 = 0x7fff_ffff;
// Large historical executions otherwise spend most of their time in command
// submission and readback. Resource planning remains exact and device limits
// are checked before provider materialization.
const DEFAULT_MAX_ROWS_PER_CHUNK = 65_536;
const DEFAULT_MAX_CACHE_BYTES_PER_WORKGROUP = 16 * 1024;
// The generated cache address lookup is a balanced segment tree. Beyond four
// routing levels, or when a workgroup owns only one execution, the additional
// copy and routing work outweighed storage access in the representative
// historical sweep benchmark.
const MAX_PROFITABLE_CACHE_SEGMENTS = 16;
const MIN_WEBGPU_BUFFER_BYTES = 4;

export interface GpuExecutionOptions {
  readonly maxRowsPerChunk?: number;
  readonly effectRecordsPerExecution?: number;
  readonly maxGpuBytes?: number;
  // Zero forces the storage-only entry point. Other values cap the selected
  // whole-segment workgroup-cache prefix.
  readonly maxCacheBytesPerWorkgroup?: number;
}

export interface GpuChunkResult {
  readonly bindings: readonly GpuBindingProgress[];
  readonly done: boolean;
}

export interface GpuRunSummary {
  readonly bindings: readonly GpuBindingSummary[];
  readonly chunks: number;
  readonly dispatches: number;
  readonly cache: GpuCachePlacement;
  readonly timing: GpuRunTiming;
}

export interface GpuRunTiming {
  // Host-side command encoding through queue submission. This is not GPU
  // execution time: submitted work may begin before this interval ends.
  readonly encodeSubmitMs: number;
  // Waiting for submitted GPU work to complete plus copying and mapping its
  // readback buffers. WebGPU exposes these together through mapAsync here.
  readonly completionReadbackMs: number;
  // Validation, decoding, and synchronous OutputSink publication on the host.
  readonly decodePublicationMs: number;
}

export interface GpuCachePlacement {
  readonly mode: 'storage-only' | 'workgroup-prefix';
  readonly entryPoint: string;
  readonly workgroupSize: number;
  readonly cachedWordsPerExecution: number;
  readonly cachedBytesPerExecution: number;
  readonly bytesPerWorkgroup: number;
  readonly segmentIds: readonly string[];
}

export interface GpuCacheDeviceLimits {
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeWorkgroupStorageSize: number;
}

export interface GpuBindingProgress {
  readonly bindingIndex: number;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly done: boolean;
}

export interface GpuBindingSummary {
  readonly bindingIndex: number;
  readonly rows: number;
  readonly inputs: readonly BoundInput[];
}

export interface GpuExecution {
  readonly done: boolean;
  runChunk(): Promise<GpuChunkResult>;
  runAll(): Promise<GpuRunSummary>;
  dispose(): void;
}

interface GpuBuffers {
  readonly jobs: GPUBuffer;
  readonly series: GPUBuffer;
  readonly executionStates: GPUBuffer;
  readonly results: GPUBuffer;
  readonly effectStatus: GPUBuffer;
  readonly effectRecords: GPUBuffer;
  readonly params: GPUBuffer;
  readonly readbackResults: GPUBuffer;
  readonly readbackEffectStatus: GPUBuffer;
  readonly readbackEffectRecords: GPUBuffer;
}

interface ActiveGpuExecutionInstance {
  readonly executionIndex: number;
  readonly progress: GpuBindingProgress;
}

interface ResolvedContextSeries {
  readonly bindingIndex: number;
  readonly series: readonly SeriesData[];
}

interface GpuBufferDeviceLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
}

export interface PreparedGpuExecutionInstance {
  readonly bindingIndex: number;
  readonly inputs: BindInputs;
  readonly context: ProviderContext;
  readonly rows: number;
  readonly boundInputs: readonly BoundInput[];
  // Scalar-cell offset into `seriesPayload`; every required series occupies
  // one complete, contiguous row span in artifact order.
  readonly seriesOffset: number;
  // Scalar-slot offset into the execution-major parameter payload.
  readonly paramsOffset: number;
  // Result-cell range assigned to this execution. Final-dense sinks own one
  // row of cells; complete sinks own the chunk-sized row stream.
  readonly finalDenseOnly: boolean;
  readonly resultOffset: number;
  readonly resultCapacity: number;
  readonly capturesEffects: boolean;
  readonly effectOffset: number;
  readonly effectCapacity: number;
}

export interface GpuResourceSizes {
  readonly jobs: number;
  readonly series: number;
  readonly executionStates: number;
  readonly results: number;
  readonly effectStatus: number;
  readonly effectRecords: number;
  readonly params: number;
  readonly readbackResults: number;
  readonly readbackEffectStatus: number;
  readonly readbackEffectRecords: number;
  readonly total: number;
}

export interface PreparedGpuExecution {
  readonly artifact: CompiledWgslProgram;
  readonly executions: readonly PreparedGpuExecutionInstance[];
  readonly seriesPayload: Uint8Array;
  readonly descriptorPayload: Uint8Array;
  readonly paramPayload: Uint8Array;
  readonly chunkRows: number;
  readonly effectRecordsPerExecution: number;
  readonly effectRecordCount: number;
  readonly resources: GpuResourceSizes;
}

export class GpuBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpuBindingError';
  }
}

export class GpuExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpuExecutionError';
  }
}

export function planGpuWorkgroupCache(
  artifact: CompiledWgslProgram,
  executionCount: number,
  limits: GpuCacheDeviceLimits,
  options: Pick<GpuExecutionOptions, 'maxCacheBytesPerWorkgroup'> = {},
): GpuCachePlacement {
  validateArtifact(artifact);
  requireU32(executionCount, 'GPU execution count');
  const maxInvocations = deviceLimit(
    limits.maxComputeInvocationsPerWorkgroup,
    'maxComputeInvocationsPerWorkgroup',
  );
  const maxSizeX = deviceLimit(
    limits.maxComputeWorkgroupSizeX,
    'maxComputeWorkgroupSizeX',
  );
  const maxStorageBytes = optionalDeviceLimit(
    limits.maxComputeWorkgroupStorageSize,
    'maxComputeWorkgroupStorageSize',
  );
  const requestedCacheBytes = optionalNonnegativeInteger(
    options.maxCacheBytesPerWorkgroup,
    'maxCacheBytesPerWorkgroup',
  );
  const defaultSize = artifact.cache.overrides.workgroupSize.defaultValue;
  const maximumSize = Math.min(defaultSize, maxInvocations, maxSizeX);
  const desiredSize = Math.min(Math.max(1, executionCount), maximumSize);
  let workgroupSize = 1;
  while (workgroupSize < desiredSize && workgroupSize * 2 <= maximumSize) {
    workgroupSize *= 2;
  }
  const cacheIsProfitable =
    workgroupSize > 1 &&
    artifact.cache.segments.length <= MAX_PROFITABLE_CACHE_SEGMENTS;
  const budget =
    executionCount === 0 || !cacheIsProfitable
      ? 0
      : Math.min(
          requestedCacheBytes ?? DEFAULT_MAX_CACHE_BYTES_PER_WORKGROUP,
          maxStorageBytes,
        );
  let cachedWordsPerExecution = 0;
  let segmentCount = 0;
  for (const segment of artifact.cache.segments) {
    const bytes =
      segment.cacheEnd * workgroupSize * Uint32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(bytes) || bytes > budget) break;
    cachedWordsPerExecution = segment.cacheEnd;
    segmentCount += 1;
  }
  const cachedBytesPerExecution =
    cachedWordsPerExecution * Uint32Array.BYTES_PER_ELEMENT;
  const bytesPerWorkgroup = cachedBytesPerExecution * workgroupSize;
  return {
    mode: cachedWordsPerExecution === 0 ? 'storage-only' : 'workgroup-prefix',
    entryPoint:
      cachedWordsPerExecution === 0
        ? artifact.cache.storageEntryPoint
        : artifact.cache.cachedEntryPoint,
    workgroupSize,
    cachedWordsPerExecution,
    cachedBytesPerExecution,
    bytesPerWorkgroup,
    segmentIds: artifact.cache.segments
      .slice(0, segmentCount)
      .map(segment => segment.id),
  };
}

function deviceLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_U32) {
    throw new GpuExecutionError(`GPU device has invalid ${name} ${value}`);
  }
  return value;
}

function optionalDeviceLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    throw new GpuExecutionError(`GPU device has invalid ${name} ${value}`);
  }
  return value;
}

function cachePipelineConstants(
  artifact: CompiledWgslProgram,
  cache: GpuCachePlacement,
): Record<string, number> {
  const selected = artifact.cache.segments.find(
    segment => segment.cacheEnd === cache.cachedWordsPerExecution,
  );
  if (
    (cache.cachedWordsPerExecution === 0 && cache.segmentIds.length !== 0) ||
    (cache.cachedWordsPerExecution > 0 &&
      (selected === undefined || selected.rank + 1 !== cache.segmentIds.length))
  ) {
    throw new GpuExecutionError(
      'GPU cache placement does not end on a ranked segment boundary',
    );
  }
  const allocationWords =
    cache.cachedWordsPerExecution === 0
      ? 1
      : cache.cachedWordsPerExecution * cache.workgroupSize;
  if (
    !Number.isSafeInteger(allocationWords) ||
    allocationWords <= 0 ||
    (cache.cachedWordsPerExecution === 0
      ? allocationWords !== 1
      : allocationWords * Uint32Array.BYTES_PER_ELEMENT !==
        cache.bytesPerWorkgroup)
  ) {
    throw new GpuExecutionError('GPU cache allocation constants disagree');
  }
  const overrides = artifact.cache.overrides;
  return {
    [String(overrides.workgroupSize.numericId)]: cache.workgroupSize,
    [String(overrides.cacheWordsPerExecution.numericId)]:
      cache.cachedWordsPerExecution,
    [String(overrides.cacheAllocationWords.numericId)]: allocationWords,
  };
}

export async function createGpuExecution(
  device: GPUDevice,
  artifact: CompiledWgslProgram,
  bindings: readonly BindInputs[],
  options: GpuExecutionOptions = {},
): Promise<GpuExecution> {
  const prepared = await prepareGpuExecutionInputsWithLimits(
    artifact,
    bindings,
    options,
    device.limits,
  );
  const declaration = executionDeclaration(artifact);
  const cache = planGpuWorkgroupCache(
    artifact,
    prepared.executions.length,
    device.limits,
    options,
  );
  if (prepared.resources.total === 0) {
    declareBindings(prepared, declaration);
    return new InertGpuExecution(prepared, cache);
  }

  validateDeviceLimits(device, prepared, cache);
  const module = device.createShaderModule({code: artifact.module.source});
  const compilation = await module.getCompilationInfo();
  const diagnostics = compilation.messages.filter(
    message => message.type === 'error',
  );
  if (diagnostics.length > 0) {
    throw new GpuExecutionError(
      diagnostics
        .map(
          message =>
            `${message.lineNum}:${message.linePos}: ${message.message}`,
        )
        .join('\n'),
    );
  }

  const buffers: GPUBuffer[] = [];
  try {
    const make = (
      size: number,
      usage: GPUBufferUsageFlags,
      payload?: Uint8Array,
    ): GPUBuffer => {
      const buffer = device.createBuffer({
        size,
        usage,
        mappedAtCreation: payload !== undefined,
      });
      if (payload !== undefined) {
        new Uint8Array(buffer.getMappedRange()).set(payload);
        buffer.unmap();
      }
      buffers.push(buffer);
      return buffer;
    };
    const resources = prepared.resources;
    const gpuBuffers: GpuBuffers = {
      jobs: make(
        resources.jobs,
        GPUBufferUsage.STORAGE,
        prepared.descriptorPayload,
      ),
      series: make(
        resources.series,
        GPUBufferUsage.STORAGE,
        prepared.seriesPayload,
      ),
      executionStates: make(
        resources.executionStates,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      results: make(
        resources.results,
        GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      ),
      effectStatus: make(
        resources.effectStatus,
        GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      ),
      effectRecords: make(
        resources.effectRecords,
        GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      ),
      params: make(
        resources.params,
        GPUBufferUsage.STORAGE,
        prepared.paramPayload,
      ),
      readbackResults: make(
        resources.readbackResults,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      ),
      readbackEffectStatus: make(
        resources.readbackEffectStatus,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      ),
      readbackEffectRecords: make(
        resources.readbackEffectRecords,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      ),
    };
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module,
        entryPoint: cache.entryPoint,
        constants: cachePipelineConstants(artifact, cache),
      },
    });
    const external = artifact.externalBuffers;
    const entries: GPUBindGroupEntry[] = [
      {binding: external.jobsBinding, resource: {buffer: gpuBuffers.jobs}},
      {
        binding: external.executionStatesBinding,
        resource: {buffer: gpuBuffers.executionStates},
      },
      {
        binding: external.effectStatusBinding,
        resource: {buffer: gpuBuffers.effectStatus},
      },
    ];
    if (artifact.requiredSeries.length > 0) {
      entries.push({
        binding: external.seriesBinding,
        resource: {buffer: gpuBuffers.series},
      });
    }
    if (artifact.resultChannels.length > 0) {
      entries.push({
        binding: external.resultsBinding,
        resource: {buffer: gpuBuffers.results},
      });
    }
    if (artifact.maxEffectsPerRow > 0) {
      entries.push({
        binding: external.effectRecordsBinding,
        resource: {buffer: gpuBuffers.effectRecords},
      });
    }
    if (artifact.params.length > 0) {
      entries.push({
        binding: external.paramsBinding,
        resource: {buffer: gpuBuffers.params},
      });
    }
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(external.group),
      entries,
    });
    declareBindings(prepared, declaration);
    return new DeviceGpuExecution(
      device,
      prepared,
      pipeline,
      bindGroup,
      gpuBuffers,
      cache,
    );
  } catch (error) {
    buffers.forEach(buffer => buffer.destroy());
    throw error;
  }
}

class InertGpuExecution implements GpuExecution {
  private disposed = false;
  constructor(
    private readonly prepared: PreparedGpuExecution,
    private readonly cache: GpuCachePlacement,
  ) {}
  get done(): boolean {
    return true;
  }
  async runChunk(): Promise<GpuChunkResult> {
    if (this.disposed) throw new GpuExecutionError('GPU execution is disposed');
    return {bindings: [], done: true};
  }
  async runAll(): Promise<GpuRunSummary> {
    if (this.disposed) throw new GpuExecutionError('GPU execution is disposed');
    return {
      bindings: this.prepared.executions.map(execution => ({
        bindingIndex: execution.bindingIndex,
        rows: execution.rows,
        inputs: execution.boundInputs,
      })),
      chunks: 0,
      dispatches: 0,
      cache: this.cache,
      timing: emptyGpuRunTiming(),
    };
  }
  dispose(): void {
    this.disposed = true;
  }
}

class DeviceGpuExecution implements GpuExecution {
  private readonly cursors: number[];
  private disposed = false;
  private failed = false;
  private running = false;
  private chunks = 0;
  private dispatches = 0;
  private encodeSubmitMs = 0;
  private completionReadbackMs = 0;
  private decodePublicationMs = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly prepared: PreparedGpuExecution,
    private readonly pipeline: GPUComputePipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly buffers: GpuBuffers,
    private readonly cache: GpuCachePlacement,
  ) {
    this.cursors = prepared.executions.map(() => 0);
  }

  get done(): boolean {
    return this.prepared.executions.every(
      (execution, index) => this.cursors[index] >= execution.rows,
    );
  }

  async runChunk(): Promise<GpuChunkResult> {
    if (this.disposed) throw new GpuExecutionError('GPU execution is disposed');
    if (this.failed)
      throw new GpuExecutionError('GPU execution is terminal-failed');
    if (this.running)
      throw new GpuExecutionError('GPU execution is already running');
    if (this.done) return {bindings: [], done: true};
    this.running = true;
    try {
      return await this.executeChunk();
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.running = false;
    }
  }

  async runAll(): Promise<GpuRunSummary> {
    if (this.disposed) throw new GpuExecutionError('GPU execution is disposed');
    if (this.failed)
      throw new GpuExecutionError('GPU execution is terminal-failed');
    while (!this.done) await this.runChunk();
    return {
      bindings: this.prepared.executions.map(execution => ({
        bindingIndex: execution.bindingIndex,
        rows: execution.rows,
        inputs: execution.boundInputs,
      })),
      chunks: this.chunks,
      dispatches: this.dispatches,
      cache: this.cache,
      timing: {
        encodeSubmitMs: this.encodeSubmitMs,
        completionReadbackMs: this.completionReadbackMs,
        decodePublicationMs: this.decodePublicationMs,
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    Object.values(this.buffers).forEach(buffer => buffer.destroy());
  }

  private async executeChunk(): Promise<GpuChunkResult> {
    const active = this.prepared.executions
      .map((execution, executionIndex): ActiveGpuExecutionInstance => {
        const rowStart = this.cursors[executionIndex];
        const rowCount = Math.min(
          this.prepared.chunkRows,
          execution.rows - rowStart,
        );
        return {
          executionIndex,
          progress: {
            bindingIndex: execution.bindingIndex,
            rowStart,
            rowCount,
            done: rowStart + rowCount >= execution.rows,
          },
        };
      })
      .filter(item => item.progress.rowCount > 0);
    const progress = active.map(item => item.progress);
    const encodeSubmitStarted = globalThis.performance.now();
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.buffers.results);
    if (this.prepared.effectRecordCount > 0) {
      encoder.clearBuffer(this.buffers.effectStatus);
      encoder.clearBuffer(this.buffers.effectRecords);
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(this.prepared.executions.length / this.cache.workgroupSize),
      1,
      1,
    );
    pass.end();
    encoder.copyBufferToBuffer(
      this.buffers.results,
      0,
      this.buffers.readbackResults,
      0,
      this.prepared.resources.results,
    );
    if (this.prepared.effectRecordCount > 0) {
      encoder.copyBufferToBuffer(
        this.buffers.effectStatus,
        0,
        this.buffers.readbackEffectStatus,
        0,
        this.prepared.resources.effectStatus,
      );
      encoder.copyBufferToBuffer(
        this.buffers.effectRecords,
        0,
        this.buffers.readbackEffectRecords,
        0,
        this.prepared.resources.effectRecords,
      );
    }
    this.device.queue.submit([encoder.finish()]);
    this.encodeSubmitMs +=
      globalThis.performance.now() - encodeSubmitStarted;
    const completionReadbackStarted = globalThis.performance.now();
    const [results, effectStatus, effectRecords] = await Promise.all([
      readback(this.buffers.readbackResults),
      this.prepared.effectRecordCount > 0
        ? readback(this.buffers.readbackEffectStatus)
        : Promise.resolve(new Uint8Array()),
      this.prepared.effectRecordCount > 0
        ? readback(this.buffers.readbackEffectRecords)
        : Promise.resolve(new Uint8Array()),
    ]);
    this.completionReadbackMs +=
      globalThis.performance.now() - completionReadbackStarted;
    const decodePublicationStarted = globalThis.performance.now();
    publishChunk(this.prepared, active, results, effectStatus, effectRecords);
    this.decodePublicationMs +=
      globalThis.performance.now() - decodePublicationStarted;
    active.forEach(({executionIndex, progress: item}) => {
      this.cursors[executionIndex] = item.rowStart + item.rowCount;
    });
    this.chunks += 1;
    this.dispatches += 1;
    return {bindings: progress, done: this.done};
  }
}

function emptyGpuRunTiming(): GpuRunTiming {
  return {
    encodeSubmitMs: 0,
    completionReadbackMs: 0,
    decodePublicationMs: 0,
  };
}

async function readback(buffer: GPUBuffer): Promise<Uint8Array> {
  await buffer.mapAsync(GPUMapMode.READ);
  try {
    return new Uint8Array(buffer.getMappedRange()).slice();
  } finally {
    buffer.unmap();
  }
}

function publishChunk(
  prepared: PreparedGpuExecution,
  active: readonly ActiveGpuExecutionInstance[],
  results: Uint8Array,
  effectStatus: Uint8Array,
  effectRecords: Uint8Array,
): void {
  const artifact = prepared.artifact;
  const resultView = dataView(results, 'dense result');
  const capturesAnyEffects = prepared.effectRecordCount > 0;
  const statusView = capturesAnyEffects
    ? dataView(effectStatus, 'effect status')
    : null;
  const recordView = capturesAnyEffects
    ? dataView(effectRecords, 'effect record')
    : null;
  const byBinding = new Map(
    active.map(item => [item.progress.bindingIndex, item.progress]),
  );
  const effectsByExecution = prepared.executions.map(
    () => new Map<number, EffectEmission[]>(),
  );

  for (const [executionIndex, execution] of prepared.executions.entries()) {
    if (!execution.capturesEffects) continue;
    if (statusView === null || recordView === null) {
      throw new GpuExecutionError('GPU effect capture lost its readback');
    }
    const base = executionIndex * artifact.effectStatusByteStride;
    const count = readU32(statusView, base, 'effect count');
    const overflow = readU32(statusView, base + 4, 'effect overflow');
    if (overflow !== 0 && overflow !== 1) {
      throw new GpuExecutionError(
        `GPU binding ${execution.bindingIndex} returned invalid effect overflow flag ${overflow}`,
      );
    }
    if (overflow === 1) {
      const row = readU32(statusView, base + 8, 'first overflow row');
      const effectId = readU32(statusView, base + 12, 'first overflow effect');
      throw new GpuExecutionError(
        `GPU binding ${execution.bindingIndex} effect buffer overflowed at row ${row}, effect ${effectId}`,
      );
    }
    if (count > execution.effectCapacity) {
      throw new GpuExecutionError(
        `GPU binding ${execution.bindingIndex} returned ${count} effects above capacity ${execution.effectCapacity}`,
      );
    }
    const executionProgress = byBinding.get(execution.bindingIndex);
    if (executionProgress === undefined && count !== 0) {
      throw new GpuExecutionError(
        `completed GPU binding ${execution.bindingIndex} returned ${count} effects`,
      );
    }
    for (let index = 0; index < count; index += 1) {
      const recordBase =
        (execution.effectOffset + index) * artifact.effectRecordByteStride;
      const row = readU32(recordView, recordBase, 'effect row');
      const effectId = readU32(recordView, recordBase + 4, 'effect id');
      const schema = artifact.effectSchemas[effectId];
      if (schema === undefined || schema.effectId !== effectId) {
        throw new GpuExecutionError(
          `GPU binding ${execution.bindingIndex} returned unknown effect ${effectId}`,
        );
      }
      if (
        executionProgress === undefined ||
        row < executionProgress.rowStart ||
        row >= executionProgress.rowStart + executionProgress.rowCount
      ) {
        throw new GpuExecutionError(
          `GPU binding ${execution.bindingIndex} returned effect row ${row} outside the current chunk`,
        );
      }
      const emission: EffectEmission = {
        effectId,
        payload: decodeValue(
          schema.payload,
          recordView,
          recordBase + 8,
          recordBase + 8 + schema.payloadWordCount * 4,
          artifact.literalStrings,
          `effect ${effectId}`,
        ),
      };
      const rowEffects = effectsByExecution[executionIndex].get(row) ?? [];
      rowEffects.push(emission);
      effectsByExecution[executionIndex].set(row, rowEffects);
    }
  }

  const publications: Array<{
    readonly executionIndex: number;
    readonly rows: readonly RowPublication[];
  }> = [];
  for (const {executionIndex, progress: item} of active) {
    const execution = prepared.executions[executionIndex];
    if (execution === undefined) {
      throw new GpuExecutionError(
        `GPU chunk refers to unknown execution ${executionIndex}`,
      );
    }
    const finalDenseOnly =
      execution.inputs.sink.capabilities?.denseRows === 'final';
    const rows: RowPublication[] = [];
    for (let localRow = 0; localRow < item.rowCount; localRow += 1) {
      const row = item.rowStart + localRow;
      const effects = effectsByExecution[executionIndex].get(row) ?? [];
      const includeOutputs = !finalDenseOnly || row === execution.rows - 1;
      if (!includeOutputs && effects.length === 0) continue;
      rows.push({
        row,
        outputs: includeOutputs
          ? decodeOutputs(prepared, resultView, executionIndex, localRow)
          : [],
        effects,
        provisional: false,
      });
    }
    publications.push({executionIndex, rows});
  }
  // Nothing externally visible occurs until every execution's complete readback
  // has passed overflow, range, id, and payload validation.
  for (const publication of publications) {
    const sink = prepared.executions[publication.executionIndex].inputs.sink;
    publication.rows.forEach(row => sink.publish(row));
  }
}

function decodeOutputs(
  prepared: PreparedGpuExecution,
  view: DataView,
  executionIndex: number,
  localRow: number,
): DenseEmission[] {
  const artifact = prepared.artifact;
  const execution = prepared.executions[executionIndex];
  if (execution === undefined) {
    throw new GpuExecutionError(
      `GPU result refers to unknown execution ${executionIndex}`,
    );
  }
  const resultRow = execution.finalDenseOnly ? 0 : localRow;
  const channelsByCell = new Map(
    artifact.resultChannels.map(channel => [channel.rowCell, channel]),
  );
  const result: DenseEmission[] = [];
  for (const output of artifact.outputSchemas) {
    const cells = output.channels.map(channel => channel.rowCell);
    if (cells.every(cell => cell === null)) continue;
    if (cells.some(cell => cell === null)) {
      throw new GpuExecutionError(
        `GPU output ${output.outputId} mixes declaration-only and row channels`,
      );
    }
    result.push({
      outputId: output.outputId,
      channels: cells.map(cell => {
        const channel = channelsByCell.get(cell as number);
        if (channel === undefined || channel.outputId !== output.outputId) {
          throw new GpuExecutionError(
            `GPU output ${output.outputId} has an invalid result-cell mapping`,
          );
        }
        const slot =
          execution.resultOffset +
          resultRow * artifact.resultChannels.length +
          channel.rowCell;
        if (slot >= execution.resultOffset + execution.resultCapacity) {
          throw new GpuExecutionError(
            `GPU binding ${execution.bindingIndex} result cell exceeds its assigned range`,
          );
        }
        const offset = slot * artifact.resultCellByteStride;
        return decodeResult(channel, view, offset);
      }),
    });
  }
  return result;
}

function decodeResult(
  channel: WgslResultChannel,
  view: DataView,
  offset: number,
): Value {
  const bits = readU32(view, offset, 'result bits');
  const validWord = readU32(view, offset + 4, 'result validity');
  if (validWord !== 0 && validWord !== 1) {
    throw new GpuExecutionError(
      `GPU result cell ${channel.rowCell} has invalid validity ${validWord}`,
    );
  }
  if (validWord === 0) {
    if (channel.scalar === 'bool') {
      throw new GpuExecutionError(
        `GPU bool result cell ${channel.rowCell} was not written`,
      );
    }
    return channel.scalar === 'enum' ? null : NaN;
  }
  switch (channel.scalar) {
    case 'float': {
      const value = u32AsF32(bits);
      if (!Number.isFinite(value)) {
        throw new GpuExecutionError(
          `GPU result cell ${channel.rowCell} contains non-finite valid f32`,
        );
      }
      return value;
    }
    case 'int':
      return u32AsI32(bits);
    case 'bool':
      if (bits !== 0 && bits !== 1) {
        throw new GpuExecutionError(`invalid GPU bool payload ${bits}`);
      }
      return bits === 1;
    case 'enum': {
      const member = channel.enumMembers?.[bits];
      if (member === undefined) {
        throw new GpuExecutionError(
          `GPU enum result cell ${channel.rowCell} has invalid ordinal ${bits}`,
        );
      }
      return member;
    }
  }
}

function decodeValue(
  schema: WgslValueSchema,
  view: DataView,
  base: number,
  end: number,
  literalStrings: readonly string[],
  owner: string,
): EffectValue {
  const word = (offset: number, label: string): number => {
    const absolute = base + offset;
    if (offset < 0 || offset % 4 !== 0 || absolute + 4 > end) {
      throw new GpuExecutionError(
        `GPU ${owner} ${label} offset ${offset} is outside its payload`,
      );
    }
    return readU32(view, absolute, `${owner} ${label}`);
  };
  const valid = (offset: number): boolean => {
    const value = word(offset, 'validity');
    if (value !== 0 && value !== 1) {
      throw new GpuExecutionError(`GPU ${owner} has invalid validity ${value}`);
    }
    return value === 1;
  };
  switch (schema.kind) {
    case 'bool': {
      const value = word(schema.valueByteOffset, 'bool');
      if (value !== 0 && value !== 1) {
        throw new GpuExecutionError(`GPU ${owner} has invalid bool ${value}`);
      }
      return value === 1;
    }
    case 'int':
      return valid(schema.validByteOffset)
        ? u32AsI32(word(schema.valueByteOffset, 'int'))
        : NaN;
    case 'float': {
      if (!valid(schema.validByteOffset)) return NaN;
      const value = u32AsF32(word(schema.valueByteOffset, 'float'));
      if (!Number.isFinite(value)) {
        throw new GpuExecutionError(`GPU ${owner} has non-finite valid f32`);
      }
      return value;
    }
    case 'string': {
      if (!valid(schema.validByteOffset)) return null;
      const id = word(schema.valueByteOffset, 'string id');
      const value = literalStrings[id];
      if (value === undefined) {
        throw new GpuExecutionError(
          `GPU ${owner} has unknown literal string id ${id}`,
        );
      }
      return value;
    }
    case 'color':
      return valid(schema.validByteOffset)
        ? decodeColor(word(schema.valueByteOffset, 'color'))
        : null;
    case 'enum': {
      if (!valid(schema.validByteOffset)) return null;
      const ordinal = word(schema.ordinalByteOffset, 'enum ordinal');
      const member = schema.members[ordinal];
      if (member === undefined) {
        throw new GpuExecutionError(
          `GPU ${owner} enum '${schema.name}' has invalid ordinal ${ordinal}`,
        );
      }
      return member;
    }
    case 'user-type': {
      if (!valid(schema.validByteOffset)) return null;
      return Object.freeze({
        kind: 'user-type' as const,
        fields: Object.freeze(
          schema.fields.map(field =>
            decodeValue(
              field.value,
              view,
              base + field.byteOffset,
              end,
              literalStrings,
              `${owner}.${field.name}`,
            ),
          ),
        ),
      });
    }
  }
}

function decodeColor(value: number): string {
  const hex = value.toString(16).padStart(8, '0').toUpperCase();
  return hex.endsWith('FF') ? `#${hex.slice(0, 6)}` : `#${hex}`;
}

function dataView(bytes: Uint8Array, owner: string): DataView {
  if (bytes.byteLength % 4 !== 0) {
    throw new GpuExecutionError(
      `GPU ${owner} readback has invalid byte length ${bytes.byteLength}`,
    );
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU32(view: DataView, offset: number, owner: string): number {
  if (offset < 0 || offset % 4 !== 0 || offset + 4 > view.byteLength) {
    throw new GpuExecutionError(
      `GPU ${owner} readback offset ${offset} is out of bounds`,
    );
  }
  return view.getUint32(offset, true);
}

function u32AsF32(value: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setUint32(0, value, true);
  return view.getFloat32(0, true);
}

function u32AsI32(value: number): number {
  return value > 0x7fff_ffff ? value - 0x1_0000_0000 : value;
}

function executionDeclaration(
  artifact: CompiledWgslProgram,
): ExecutionDeclaration {
  return {
    outputs: artifact.outputSchemas.map(schema => ({
      spec: {
        effect: schema.effect,
        staticArgs: schema.staticArgs.map(arg => ({...arg})),
        channels: schema.channels.map(channel => ({
          name: channel.name,
          type: channel.type,
          transport: channel.transport,
        })),
      },
      boundArgs: [],
    })),
    effects: artifact.effectSchemas.map(schema => schema.declaration),
  };
}

function declareBindings(
  prepared: PreparedGpuExecution,
  declaration: ExecutionDeclaration,
): void {
  prepared.executions.forEach(execution =>
    execution.inputs.sink.declare(declaration),
  );
}

function validateDeviceLimits(
  device: GPUDevice,
  prepared: PreparedGpuExecution,
  cache: GpuCachePlacement,
): void {
  validateDeviceBufferLimits(prepared.resources, device.limits);
  const workgroups = Math.ceil(
    prepared.executions.length / cache.workgroupSize,
  );
  if (workgroups > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new GpuExecutionError(
      `GPU dispatch requires ${workgroups} workgroups; device limit is ${device.limits.maxComputeWorkgroupsPerDimension}`,
    );
  }
  const [x, y, z] = [cache.workgroupSize, 1, 1] as const;
  if (
    x > device.limits.maxComputeWorkgroupSizeX ||
    y > device.limits.maxComputeWorkgroupSizeY ||
    z > device.limits.maxComputeWorkgroupSizeZ ||
    x * y * z > device.limits.maxComputeInvocationsPerWorkgroup
  ) {
    throw new GpuExecutionError(
      `GPU workgroup size ${x}x${y}x${z} exceeds device limits`,
    );
  }
  if (cache.bytesPerWorkgroup > device.limits.maxComputeWorkgroupStorageSize) {
    throw new GpuExecutionError(
      `GPU workgroup cache requires ${cache.bytesPerWorkgroup} bytes; device limit is ${device.limits.maxComputeWorkgroupStorageSize}`,
    );
  }
}

function validateDeviceBufferLimits(
  resources: GpuResourceSizes,
  limits: GpuBufferDeviceLimits,
): void {
  const maximumBuffer = Number(limits.maxBufferSize);
  const maximumStorage = Number(limits.maxStorageBufferBindingSize);
  if (!Number.isSafeInteger(maximumBuffer) || maximumBuffer < 0) {
    throw new GpuExecutionError(
      `GPU device has invalid maxBufferSize ${String(limits.maxBufferSize)}`,
    );
  }
  if (!Number.isSafeInteger(maximumStorage) || maximumStorage < 0) {
    throw new GpuExecutionError(
      `GPU device has invalid maxStorageBufferBindingSize ${String(limits.maxStorageBufferBindingSize)}`,
    );
  }
  for (const [name, size] of Object.entries(resources)) {
    if (name === 'total') continue;
    if (size > maximumBuffer) {
      throw new GpuExecutionError(
        `GPU ${name} buffer requires ${size} bytes; device limit is ${maximumBuffer}`,
      );
    }
    if (!name.startsWith('readback') && size > maximumStorage) {
      throw new GpuExecutionError(
        `GPU ${name} storage binding requires ${size} bytes; device limit is ${maximumStorage}`,
      );
    }
  }
}

function resourcesFitDeviceBufferLimits(
  resources: GpuResourceSizes,
  limits: GpuBufferDeviceLimits,
): boolean {
  const maximumBuffer = Number(limits.maxBufferSize);
  const maximumStorage = Number(limits.maxStorageBufferBindingSize);
  for (const [name, size] of Object.entries(resources)) {
    if (name === 'total') continue;
    if (size > maximumBuffer) return false;
    if (!name.startsWith('readback') && size > maximumStorage) return false;
  }
  return true;
}

// This is intentionally target-runtime preparation, not compilation: it
// resolves concrete jobs against an already complete, bind-independent WGSL
// artifact and derives all bounded physical resources.
export async function prepareGpuExecutionInputs(
  artifact: CompiledWgslProgram,
  bindings: readonly BindInputs[],
  options: GpuExecutionOptions = {},
): Promise<PreparedGpuExecution> {
  return prepareGpuExecutionInputsWithLimits(artifact, bindings, options);
}

async function prepareGpuExecutionInputsWithLimits(
  artifact: CompiledWgslProgram,
  bindings: readonly BindInputs[],
  options: GpuExecutionOptions,
  deviceLimits?: GpuBufferDeviceLimits,
): Promise<PreparedGpuExecution> {
  validateArtifact(artifact);
  const requestedRows = positiveInteger(
    options.maxRowsPerChunk ?? DEFAULT_MAX_ROWS_PER_CHUNK,
    'maxRowsPerChunk',
  );
  const requestedEffectCapacity = optionalNonnegativeInteger(
    options.effectRecordsPerExecution,
    'effectRecordsPerExecution',
  );
  const maxGpuBytes = optionalPositiveInteger(
    options.maxGpuBytes,
    'maxGpuBytes',
  );

  // Provider resolution is a property of provider identity and context
  // coordinates, not parameter values. Parameter-only sweep executions therefore
  // share one resolution and one packed series span.
  const contextCache = new Map<
    DataProvider,
    Map<string, Promise<ProviderContext | ContextError>>
  >();
  const resolved = await Promise.all(
    bindings.map(async (inputs, bindingIndex) => {
      let values: readonly Value[];
      try {
        values = resolveParamValues(artifact.params, inputs.params);
      } catch (error) {
        throw new GpuBindingError(
          `GPU binding ${bindingIndex}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const symbol = inputs.symbol ?? '';
      const timeframe = inputs.timeframe ?? '';
      let providerContexts = contextCache.get(inputs.provider);
      if (providerContexts === undefined) {
        providerContexts = new Map();
        contextCache.set(inputs.provider, providerContexts);
      }
      const contextKey = JSON.stringify([symbol, timeframe]);
      let pending = providerContexts.get(contextKey);
      if (pending === undefined) {
        pending = Promise.resolve(
          inputs.provider.resolveContext(symbol, timeframe, {kind: 'full'}),
        );
        providerContexts.set(contextKey, pending);
      }
      const context = await pending;
      if (isContextError(context)) {
        throw new GpuBindingError(
          `GPU binding ${bindingIndex} context failed (${context.error}): ${context.detail}`,
        );
      }
      requireU32(context.rows, `GPU binding ${bindingIndex} row count`);
      if (context.rows > MAX_I32) {
        throw new GpuBindingError(
          `GPU binding ${bindingIndex} row count exceeds the i32 bar_index target profile`,
        );
      }
      const boundInputs = artifact.params.map((spec, pid) => ({
        spec,
        value: values[pid] ?? fatalGpuParamValue(spec.name),
        active: artifact.paramActive[pid] ?? false,
      }));
      return {inputs, bindingIndex, context, boundInputs};
    }),
  );

  const executions: PreparedGpuExecutionInstance[] = [];
  const contextSeriesOffsets = new Map<ProviderContext, number>();
  const resolvedContextSeries = new Map<
    ProviderContext,
    ResolvedContextSeries
  >();
  let scalarCount = 0;
  for (const {inputs, bindingIndex, context, boundInputs} of resolved) {
    let seriesOffset = contextSeriesOffsets.get(context);
    if (seriesOffset === undefined) {
      seriesOffset = scalarCount;
      contextSeriesOffsets.set(context, seriesOffset);
      const series = artifact.requiredSeries.map(required => {
        const handle = context.series(required.id);
        if (handle === null) {
          throw new GpuBindingError(
            `GPU binding ${bindingIndex} is missing required series '${required.id}'`,
          );
        }
        if (handle.length !== context.rows) {
          throw new GpuBindingError(
            `GPU binding ${bindingIndex} series '${required.id}' has ${handle.length} rows; expected ${context.rows}`,
          );
        }
        return handle;
      });
      resolvedContextSeries.set(context, {bindingIndex, series});
      const contextScalars = checkedProduct(
        context.rows,
        artifact.requiredSeries.length,
        `GPU binding ${bindingIndex} series scalar count`,
      );
      scalarCount = checkedSum(
        [scalarCount, contextScalars],
        'GPU series scalar count',
      );
      const seriesBytes = checkedProduct(
        scalarCount,
        artifact.seriesScalarByteStride,
        'GPU series bytes',
      );
      if (maxGpuBytes !== undefined && seriesBytes > maxGpuBytes) {
        throw new GpuBindingError(
          `GPU series payload requires ${seriesBytes} bytes, above maxGpuBytes ${maxGpuBytes}`,
        );
      }
    }
    executions.push({
      bindingIndex,
      inputs,
      context,
      rows: context.rows,
      boundInputs,
      seriesOffset,
      paramsOffset: bindingIndex * artifact.params.length,
      finalDenseOnly: inputs.sink.capabilities?.denseRows === 'final',
      resultOffset: 0,
      resultCapacity: 0,
      capturesEffects:
        artifact.maxEffectsPerRow > 0 &&
        inputs.sink.capabilities?.effects !== 'none',
      effectOffset: 0,
      effectCapacity: 0,
    });
  }

  const seriesBytes = checkedProduct(
    scalarCount,
    artifact.seriesScalarByteStride,
    'GPU series bytes',
  );
  const paramBytes = checkedProduct(
    checkedProduct(
      executions.length,
      artifact.params.length,
      'GPU parameter slots',
    ),
    artifact.parameterByteStride,
    'GPU parameter bytes',
  );
  const maximumRows = executions.reduce(
    (max, execution) => Math.max(max, execution.rows),
    0,
  );
  const plan = planResources(
    artifact,
    executions,
    executions.filter(execution => execution.capturesEffects).length,
    seriesBytes,
    paramBytes,
    maximumRows,
    requestedRows,
    requestedEffectCapacity,
    maxGpuBytes,
    deviceLimits,
  );
  if (deviceLimits !== undefined) {
    validateDeviceBufferLimits(plan.resources, deviceLimits);
  }
  // Budget the complete minimum execution before touching provider cells.
  // A caller-supplied resource ceiling must fail without materializing a
  // dataset that cannot possibly execute.
  const seriesPayload = packSeries(
    artifact,
    contextSeriesOffsets,
    resolvedContextSeries,
    scalarCount,
  );
  let nextResultOffset = 0;
  let nextEffectOffset = 0;
  const plannedExecutions = executions.map(execution => {
    const resultCapacity = resultCapacityForExecution(
      artifact,
      execution.finalDenseOnly,
      plan.chunkRows,
    );
    const planned = {
      ...execution,
      resultOffset: nextResultOffset,
      resultCapacity,
      effectOffset: execution.capturesEffects ? nextEffectOffset : 0,
      effectCapacity: execution.capturesEffects
        ? plan.effectRecordsPerExecution
        : 0,
    };
    nextResultOffset = checkedSum(
      [nextResultOffset, resultCapacity],
      'GPU result cell count',
    );
    if (execution.capturesEffects) {
      nextEffectOffset = checkedSum(
        [nextEffectOffset, plan.effectRecordsPerExecution],
        'GPU effect record count',
      );
    }
    return planned;
  });
  if (nextResultOffset !== plan.resultCellCount) {
    throw new GpuBindingError('GPU result plan disagrees with bindings');
  }
  if (nextEffectOffset !== plan.effectRecordCount) {
    throw new GpuBindingError('GPU effect record plan disagrees with bindings');
  }
  const paramPayload = packParams(plannedExecutions, artifact);
  const descriptorPayload = packInitialDescriptors(
    artifact,
    plannedExecutions,
    plan.chunkRows,
  );
  return {
    artifact,
    executions: plannedExecutions,
    seriesPayload,
    descriptorPayload,
    paramPayload,
    chunkRows: plan.chunkRows,
    effectRecordsPerExecution: plan.effectRecordsPerExecution,
    effectRecordCount: plan.effectRecordCount,
    resources: plan.resources,
  };
}

function planResources(
  artifact: CompiledWgslProgram,
  executions: readonly PreparedGpuExecutionInstance[],
  effectExecutionCount: number,
  seriesBytes: number,
  paramBytes: number,
  maximumRows: number,
  requestedRows: number,
  requestedEffectCapacity: number | undefined,
  maxGpuBytes: number | undefined,
  deviceLimits: GpuBufferDeviceLimits | undefined,
): {
  readonly chunkRows: number;
  readonly effectRecordsPerExecution: number;
  readonly effectRecordCount: number;
  readonly resultCellCount: number;
  readonly resources: GpuResourceSizes;
} {
  const executionCount = executions.length;
  if (executionCount === 0 || maximumRows === 0) {
    const resources: GpuResourceSizes = {
      jobs: 0,
      series: 0,
      executionStates: 0,
      results: 0,
      effectStatus: 0,
      effectRecords: 0,
      params: 0,
      readbackResults: 0,
      readbackEffectStatus: 0,
      readbackEffectRecords: 0,
      total: 0,
    };
    enforceBudget(resources, maxGpuBytes);
    return {
      chunkRows: 0,
      effectRecordsPerExecution: 0,
      effectRecordCount: 0,
      resultCellCount: 0,
      resources,
    };
  }

  let upperRows = Math.min(requestedRows, maximumRows);
  if (
    effectExecutionCount > 0 &&
    artifact.maxEffectsPerRow > 0 &&
    requestedEffectCapacity !== undefined
  ) {
    if (requestedEffectCapacity < artifact.maxEffectsPerRow) {
      throw new GpuBindingError(
        `effectRecordsPerExecution ${requestedEffectCapacity} cannot hold one row's maximum ${artifact.maxEffectsPerRow} effects`,
      );
    }
    upperRows = Math.min(
      upperRows,
      Math.floor(requestedEffectCapacity / artifact.maxEffectsPerRow),
    );
  }

  const makePlan = (chunkRows: number) => {
    const effectRecordsPerExecution =
      effectExecutionCount === 0 || artifact.maxEffectsPerRow === 0
        ? 0
        : (requestedEffectCapacity ??
          checkedProduct(
            chunkRows,
            artifact.maxEffectsPerRow,
            'GPU effect records per execution',
          ));
    const effectRecordCount = checkedProduct(
      effectExecutionCount,
      effectRecordsPerExecution,
      'GPU effect record count',
    );
    const resultCellCount = executions.reduce(
      (total, execution) =>
        checkedSum(
          [
            total,
            resultCapacityForExecution(
              artifact,
              execution.finalDenseOnly,
              chunkRows,
            ),
          ],
          'GPU result cell count',
        ),
      0,
    );
    const resources = resourceSizes(
      artifact,
      executionCount,
      seriesBytes,
      paramBytes,
      chunkRows,
      resultCellCount,
      effectRecordCount,
    );
    return {
      chunkRows,
      effectRecordsPerExecution,
      effectRecordCount,
      resultCellCount,
      resources,
    };
  };

  // Establish that the irreducible resources plus one row fit before provider
  // cells are materialized. Result and default effect transports then grow
  // monotonically with chunkRows, so binary search can select the largest
  // chunk admitted by both the caller budget and the concrete device.
  const minimum = makePlan(1);
  if (maxGpuBytes !== undefined && minimum.resources.total > maxGpuBytes) {
    throw new GpuBindingError(
      `GPU execution cannot fit one row per active execution within maxGpuBytes ${maxGpuBytes}`,
    );
  }
  if (deviceLimits !== undefined) {
    validateDeviceBufferLimits(minimum.resources, deviceLimits);
  }

  let selected = minimum;
  let low = 2;
  let high = upperRows;
  while (low <= high) {
    const chunkRows = Math.floor((low + high) / 2);
    let candidate: ReturnType<typeof makePlan>;
    try {
      candidate = makePlan(chunkRows);
    } catch (error) {
      if (!(error instanceof GpuBindingError)) throw error;
      high = chunkRows - 1;
      continue;
    }
    const fitsBudget =
      maxGpuBytes === undefined || candidate.resources.total <= maxGpuBytes;
    const fitsDevice =
      deviceLimits === undefined ||
      resourcesFitDeviceBufferLimits(candidate.resources, deviceLimits);
    if (fitsBudget && fitsDevice) {
      selected = candidate;
      low = chunkRows + 1;
    } else {
      high = chunkRows - 1;
    }
  }
  return selected;
}

function resultCapacityForExecution(
  artifact: CompiledWgslProgram,
  finalDenseOnly: boolean,
  chunkRows: number,
): number {
  const channels = artifact.resultChannels.length;
  if (channels === 0 || chunkRows === 0) return 0;
  // One result row is the descriptor-level final-only marker. A complete
  // one-row stream reserves a second row so the marker remains unambiguous.
  const resultRows = finalDenseOnly ? 1 : Math.max(chunkRows, 2);
  return checkedProduct(resultRows, channels, 'GPU result cells per execution');
}

function resourceSizes(
  artifact: CompiledWgslProgram,
  executionCount: number,
  seriesBytes: number,
  paramBytes: number,
  chunkRows: number,
  resultCellCount: number,
  effectRecordCount: number,
): GpuResourceSizes {
  const channels = artifact.resultChannels.length;
  const logical = {
    jobs: checkedProduct(
      executionCount,
      artifact.jobDescriptorByteStride,
      'GPU descriptor bytes',
    ),
    series: seriesBytes,
    params: paramBytes,
    executionStates: checkedProduct(
      executionCount,
      artifact.executionStateByteStride,
      'GPU execution-state bytes',
    ),
    results: checkedProduct(
      resultCellCount,
      artifact.resultCellByteStride,
      'GPU result bytes',
    ),
    effectStatus: checkedProduct(
      executionCount,
      artifact.effectStatusByteStride,
      'GPU effect-status bytes',
    ),
    effectRecords: checkedProduct(
      effectRecordCount,
      artifact.effectRecordByteStride,
      'GPU effect-record bytes',
    ),
  };
  const resources = {
    jobs: physicalStorageBufferBytes(
      logical.jobs,
      artifact.jobDescriptorByteStride,
    ),
    series: physicalStorageBufferBytes(
      logical.series,
      artifact.seriesScalarByteStride,
    ),
    params: physicalStorageBufferBytes(
      logical.params,
      artifact.parameterByteStride,
    ),
    executionStates: physicalStorageBufferBytes(
      logical.executionStates,
      artifact.executionStateByteStride,
    ),
    results: physicalStorageBufferBytes(
      logical.results,
      artifact.resultCellByteStride,
    ),
    effectStatus: physicalStorageBufferBytes(
      logical.effectStatus,
      artifact.effectStatusByteStride,
    ),
    effectRecords: physicalStorageBufferBytes(
      logical.effectRecords,
      artifact.effectRecordByteStride,
    ),
    readbackResults: physicalStorageBufferBytes(
      logical.results,
      artifact.resultCellByteStride,
    ),
    readbackEffectStatus: physicalStorageBufferBytes(
      logical.effectStatus,
      artifact.effectStatusByteStride,
    ),
    readbackEffectRecords: physicalStorageBufferBytes(
      logical.effectRecords,
      artifact.effectRecordByteStride,
    ),
    total: 0,
  };
  return {
    ...resources,
    total: checkedSum(
      [
        resources.jobs,
        resources.series,
        resources.params,
        resources.executionStates,
        resources.results,
        resources.effectStatus,
        resources.effectRecords,
        resources.readbackResults,
        resources.readbackEffectStatus,
        resources.readbackEffectRecords,
      ],
      'GPU buffer bytes',
    ),
  };
}

function packSeries(
  artifact: CompiledWgslProgram,
  contextOffsets: ReadonlyMap<ProviderContext, number>,
  resolvedContextSeries: ReadonlyMap<ProviderContext, ResolvedContextSeries>,
  scalarCount: number,
): Uint8Array {
  const bytes = allocateBytes(
    checkedProduct(
      scalarCount,
      artifact.seriesScalarByteStride,
      'GPU series bytes',
    ),
    'GPU series payload',
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [context, contextOffset] of contextOffsets) {
    const resolved = resolvedContextSeries.get(context);
    if (resolved === undefined) {
      throw new GpuBindingError('GPU series context lost its resolved series');
    }
    for (const [seriesIndex, required] of artifact.requiredSeries.entries()) {
      const series = resolved.series[seriesIndex];
      if (series === undefined) {
        throw new GpuBindingError(
          `GPU binding ${resolved.bindingIndex} lost required series '${required.id}'`,
        );
      }
      const seriesOffset = contextOffset + seriesIndex * context.rows;
      for (let row = 0; row < context.rows; row += 1) {
        const value = f32Input(
          series.at(row),
          resolved.bindingIndex,
          required.id,
          row,
        );
        const offset = (seriesOffset + row) * artifact.seriesScalarByteStride;
        if (Number.isNaN(value)) {
          view.setUint32(offset, 0x7fc0_0000, true);
        } else {
          view.setFloat32(offset, value, true);
        }
      }
    }
  }
  return bytes;
}

function packParams(
  executions: readonly PreparedGpuExecutionInstance[],
  artifact: CompiledWgslProgram,
): Uint8Array {
  const slotCount = checkedProduct(
    executions.length,
    artifact.params.length,
    'GPU parameter slots',
  );
  const bytes = allocateBytes(
    checkedProduct(
      slotCount,
      artifact.parameterByteStride,
      'GPU parameter bytes',
    ),
    'GPU parameter payload',
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  executions.forEach(execution => {
    execution.boundInputs.forEach((input, pid) => {
      const offset =
        (execution.paramsOffset + pid) * artifact.parameterByteStride;
      switch (input.spec.type) {
        case 'int': {
          const value = input.value;
          if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < -0x8000_0000 ||
            value > 0x7fff_ffff
          ) {
            throw new GpuBindingError(
              `GPU binding ${execution.bindingIndex} parameter '${input.spec.name}' is outside the i32 target profile`,
            );
          }
          view.setInt32(offset, value, true);
          break;
        }
        case 'float': {
          const value = input.value;
          if (typeof value !== 'number') {
            throw new GpuBindingError(
              `GPU binding ${execution.bindingIndex} parameter '${input.spec.name}' is not numeric`,
            );
          }
          const rounded = Math.fround(value);
          if (!Number.isFinite(rounded)) {
            throw new GpuBindingError(
              `GPU binding ${execution.bindingIndex} parameter '${input.spec.name}' is outside the finite f32 target profile`,
            );
          }
          view.setFloat32(offset, rounded, true);
          break;
        }
        case 'bool':
          view.setUint32(offset, input.value === true ? 1 : 0, true);
          break;
        case 'enum': {
          const ordinal = input.spec.enumType?.members.findIndex(
            member => member.name === input.value,
          );
          if (ordinal === undefined || ordinal < 0) {
            throw new GpuBindingError(
              `GPU binding ${execution.bindingIndex} parameter '${input.spec.name}' has no physical enum ordinal`,
            );
          }
          view.setUint32(offset, ordinal, true);
          break;
        }
        default:
          throw new GpuBindingError(
            `GPU parameter '${input.spec.name}' of type ${input.spec.type} has no fixed-width encoding`,
          );
      }
    });
  });
  return bytes;
}

function fatalGpuParamValue(name: string): never {
  throw new GpuBindingError(
    `compiled WGSL parameter '${name}' has no resolved value`,
  );
}

function packInitialDescriptors(
  artifact: CompiledWgslProgram,
  executions: readonly PreparedGpuExecutionInstance[],
  chunkRows: number,
): Uint8Array {
  const bytes = allocateBytes(
    checkedProduct(
      executions.length,
      artifact.jobDescriptorByteStride,
      'GPU descriptor bytes',
    ),
    'GPU descriptor payload',
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  executions.forEach((execution, executionIndex) => {
    const base = executionIndex * artifact.jobDescriptorByteStride;
    const offsets = artifact.jobDescriptorOffsets;
    view.setUint32(base + offsets.seriesOffset, execution.seriesOffset, true);
    view.setUint32(base + offsets.rowCount, execution.rows, true);
    view.setUint32(
      base + offsets.resultOffset,
      execution.resultOffset,
      true,
    );
    view.setUint32(
      base + offsets.resultCount,
      execution.resultCapacity,
      true,
    );
    view.setUint32(base + offsets.effectOffset, execution.effectOffset, true);
    view.setUint32(
      base + offsets.effectCapacity,
      execution.effectCapacity,
      true,
    );
    view.setUint32(
      base + offsets.chunkRows,
      Math.min(chunkRows, execution.rows),
      true,
    );
    view.setUint32(base + offsets.paramsOffset, execution.paramsOffset, true);
  });
  return bytes;
}

function validateArtifact(artifact: CompiledWgslProgram): void {
  const bindings = [
    artifact.externalBuffers.jobsBinding,
    artifact.externalBuffers.seriesBinding,
    artifact.externalBuffers.executionStatesBinding,
    artifact.externalBuffers.resultsBinding,
    artifact.externalBuffers.effectStatusBinding,
    artifact.externalBuffers.effectRecordsBinding,
    artifact.externalBuffers.paramsBinding,
  ];
  if (
    artifact.target !== 'webgpu-wgsl' ||
    artifact.module.language !== 'wgsl' ||
    artifact.module.entryPoint.length === 0 ||
    artifact.externalBuffers.group !== 0 ||
    bindings.some(value => !Number.isSafeInteger(value) || value < 0) ||
    new Set(bindings).size !== bindings.length
  ) {
    throw new GpuBindingError(
      'compiled WGSL has an invalid external buffer ABI',
    );
  }
  if (
    artifact.workgroupSize.some(
      value => !Number.isSafeInteger(value) || value <= 0 || value > MAX_U32,
    )
  ) {
    throw new GpuBindingError('compiled WGSL has an invalid workgroup size');
  }
  for (const [name, value] of Object.entries({
    jobDescriptorByteStride: artifact.jobDescriptorByteStride,
    seriesScalarByteStride: artifact.seriesScalarByteStride,
    parameterByteStride: artifact.parameterByteStride,
    executionStateByteStride: artifact.executionStateByteStride,
    resultCellByteStride: artifact.resultCellByteStride,
    effectStatusByteStride: artifact.effectStatusByteStride,
    effectRecordByteStride: artifact.effectRecordByteStride,
  })) {
    if (!Number.isSafeInteger(value) || value < 0 || value % 4 !== 0) {
      throw new GpuBindingError(`compiled WGSL has invalid ${name}`);
    }
  }
  requireU32(artifact.maxEffectsPerRow, 'compiled WGSL maxEffectsPerRow');
  if (
    (artifact.maxEffectsPerRow === 0) !==
    (artifact.effectSchemas.length === 0)
  ) {
    throw new GpuBindingError(
      'compiled WGSL effect schemas disagree with maxEffectsPerRow',
    );
  }
  const minimumStrides = {
    jobDescriptorByteStride: 32,
    seriesScalarByteStride: 4,
    parameterByteStride: 4,
    executionStateByteStride: 8,
    resultCellByteStride: 8,
    effectStatusByteStride: 16,
    effectRecordByteStride:
      8 + Math.max(1, artifact.effectPayloadWordCapacity) * 4,
  } as const;
  for (const [name, minimum] of Object.entries(minimumStrides)) {
    const actual = artifact[name as keyof typeof minimumStrides];
    if (actual < minimum) {
      throw new GpuBindingError(
        `compiled WGSL ${name} ${actual} is below minimum ${minimum}`,
      );
    }
  }
  validateStateManifest(artifact);
  validateCacheContract(artifact);
  requireU32(
    artifact.effectPayloadWordCapacity,
    'compiled WGSL effectPayloadWordCapacity',
  );
  if (artifact.effectPayloadWordCapacity < 1) {
    throw new GpuBindingError(
      'compiled WGSL effectPayloadWordCapacity must be positive',
    );
  }
  const offsets = Object.values(artifact.jobDescriptorOffsets);
  if (
    offsets.some(
      offset =>
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset + 4 > artifact.jobDescriptorByteStride ||
        offset % 4 !== 0,
    ) ||
    new Set(offsets).size !== offsets.length
  ) {
    throw new GpuBindingError('compiled WGSL has invalid descriptor offsets');
  }
  const requireLayout = (id: number, owner: string): void => {
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      artifact.layouts[id]?.id !== id
    ) {
      throw new GpuBindingError(
        `compiled WGSL ${owner} refers to invalid physical layout ${id}`,
      );
    }
  };
  artifact.layouts.forEach((layout, index) => {
    if (
      layout.id !== index ||
      !Number.isSafeInteger(layout.byteSize) ||
      layout.byteSize <= 0 ||
      layout.byteSize % 4 !== 0 ||
      !Number.isSafeInteger(layout.byteAlignment) ||
      layout.byteAlignment < 4 ||
      layout.byteAlignment % 4 !== 0 ||
      layout.fields.some(
        field =>
          !Number.isSafeInteger(field.byteOffset) ||
          field.byteOffset < 0 ||
          field.byteOffset % 4 !== 0 ||
          field.byteOffset + 4 > layout.byteSize,
      )
    ) {
      throw new GpuBindingError(
        `compiled WGSL has invalid physical layout ${index}`,
      );
    }
  });
  requireLayout(artifact.jobDescriptorLayout, 'job descriptor');
  requireLayout(artifact.seriesScalarLayout, 'series scalar');
  requireLayout(artifact.parameterLayout, 'parameter scalar');
  requireLayout(artifact.executionStateLayout, 'execution state');
  requireLayout(artifact.resultCellLayout, 'result cell');
  requireLayout(artifact.effectStatusLayout, 'effect status');
  requireLayout(artifact.effectRecordLayout, 'effect record');
  const strideLayouts = [
    [
      artifact.jobDescriptorLayout,
      artifact.jobDescriptorByteStride,
      'job descriptor',
    ],
    [
      artifact.seriesScalarLayout,
      artifact.seriesScalarByteStride,
      'series scalar',
    ],
    [
      artifact.parameterLayout,
      artifact.parameterByteStride,
      'parameter scalar',
    ],
    [
      artifact.executionStateLayout,
      artifact.executionStateByteStride,
      'execution state',
    ],
    [artifact.resultCellLayout, artifact.resultCellByteStride, 'result cell'],
    [
      artifact.effectStatusLayout,
      artifact.effectStatusByteStride,
      'effect status',
    ],
    [
      artifact.effectRecordLayout,
      artifact.effectRecordByteStride,
      'effect record',
    ],
  ] as const;
  strideLayouts.forEach(([layoutId, stride, owner]) => {
    if (artifact.layouts[layoutId]?.byteSize !== stride) {
      throw new GpuBindingError(
        `compiled WGSL ${owner} layout disagrees with its byte stride`,
      );
    }
  });
  if (
    artifact.paramActive.length !== artifact.params.length ||
    artifact.paramActive.some(active => typeof active !== 'boolean') ||
    artifact.params.some(
      spec =>
        spec.name.length === 0 ||
        spec.seriesSid !== null ||
        (spec.type !== 'int' &&
          spec.type !== 'float' &&
          spec.type !== 'bool' &&
          spec.type !== 'enum'),
    ) ||
    new Set(artifact.params.map(spec => spec.name)).size !==
      artifact.params.length ||
    new Set(artifact.requiredSeries.map(series => series.id)).size !==
      artifact.requiredSeries.length ||
    artifact.requiredSeries.some(series => series.id.length === 0) ||
    new Set(artifact.literalStrings).size !== artifact.literalStrings.length
  ) {
    throw new GpuBindingError(
      'compiled WGSL has invalid parameter, literal, or series identities',
    );
  }
  try {
    resolveParamValues(artifact.params, {});
  } catch (error) {
    throw new GpuBindingError(
      `compiled WGSL has an invalid parameter schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const resultCells = new Set<number>();
  artifact.resultChannels.forEach((channel, index) => {
    if (
      channel.rowCell !== index ||
      channel.outputId < 0 ||
      channel.outputId >= artifact.outputSchemas.length ||
      resultCells.has(channel.rowCell)
    ) {
      throw new GpuBindingError(
        `compiled WGSL has invalid result channel ${index}`,
      );
    }
    resultCells.add(channel.rowCell);
  });
  artifact.outputSchemas.forEach((output, outputId) => {
    if (output.outputId !== outputId) {
      throw new GpuBindingError(
        `compiled WGSL has invalid output schema ${outputId}`,
      );
    }
    const rowCells = output.channels.map(channel => channel.rowCell);
    if (
      rowCells.some(cell => cell === null) &&
      rowCells.some(cell => cell !== null)
    ) {
      throw new GpuBindingError(
        `compiled WGSL output ${outputId} mixes declaration and row channels`,
      );
    }
    output.channels.forEach(channel => {
      if (channel.rowCell === null) return;
      const result = artifact.resultChannels[channel.rowCell];
      if (
        result === undefined ||
        result.outputId !== outputId ||
        result.effect !== output.effect ||
        result.channelName !== channel.name ||
        !transportMatchesResult(channel.transport, result)
      ) {
        throw new GpuBindingError(
          `compiled WGSL output ${outputId} disagrees with result cell ${channel.rowCell}`,
        );
      }
    });
  });
  artifact.effectSchemas.forEach((schema, index) => {
    if (
      schema.effectId !== index ||
      schema.payloadWordCount < 1 ||
      schema.payloadWordCount > artifact.effectPayloadWordCapacity
    ) {
      throw new GpuBindingError(
        `compiled WGSL has invalid effect schema ${index}`,
      );
    }
    requireLayout(schema.payloadLayout, `effect schema ${index}`);
    if (
      schema.payload.physicalLayout !== schema.payloadLayout ||
      artifact.layouts[schema.payloadLayout]?.byteSize !==
        schema.payloadWordCount * 4
    ) {
      throw new GpuBindingError(
        `compiled WGSL effect schema ${index} disagrees with its payload layout`,
      );
    }
    validateValueSchema(artifact, schema.payload, `effect schema ${index}`);
    if (
      !logicalSchemaMatchesPhysical(schema.declaration.payload, schema.payload)
    ) {
      throw new GpuBindingError(
        `compiled WGSL effect schema ${index} logical declaration disagrees with its physical payload`,
      );
    }
  });
}

function validateStateManifest(artifact: CompiledWgslProgram): void {
  const {state} = artifact;
  if (
    state.initializedWordOffset !== 0 ||
    state.nextRowWordOffset !== 1 ||
    state.rootFrameWordOffset !== 2 ||
    !Number.isSafeInteger(state.wordsPerExecution) ||
    state.wordsPerExecution < 4 ||
    state.wordsPerExecution * 4 !== artifact.executionStateByteStride ||
    state.frames.length === 0
  ) {
    throw new GpuBindingError(
      'compiled WGSL has an invalid execution-state manifest',
    );
  }
  const frames = state.frames;
  frames.forEach((frame, frameIndex) => {
    if (
      frame.id !== frameIndex ||
      !Number.isSafeInteger(frame.wordCount) ||
      frame.wordCount < 2 ||
      frame.activationEncoding !== 'absolute-row-plus-one'
    ) {
      throw new GpuBindingError(
        `compiled WGSL has an invalid state frame ${frameIndex}`,
      );
    }
    const claimed: Array<{
      readonly start: number;
      readonly end: number;
      readonly owner: string;
    }> = [];
    const claim = (start: number, count: number, owner: string): void => {
      const end = start + count;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        count <= 0 ||
        end > frame.wordCount
      ) {
        throw new GpuBindingError(
          `compiled WGSL state frame ${frameIndex} has invalid ${owner} range`,
        );
      }
      claimed.push({start, end, owner});
    };
    claim(frame.committedActivationWordOffset, 1, 'committed activation');
    claim(frame.tentativeActivationWordOffset, 1, 'tentative activation');
    frame.locals.forEach((local, localIndex) => {
      claim(
        local.scratchWordOffset,
        local.valueWordCount,
        `local ${localIndex} scratch`,
      );
      const persistent = local.storage === 'var';
      if (
        (local.storage !== 'perBar' && local.storage !== 'var') ||
        (local.committedInitWordOffset === null) !==
          (local.tentativeInitWordOffset === null) ||
        persistent !== (local.committedInitWordOffset !== null) ||
        !Number.isSafeInteger(local.historyCapacity) ||
        local.historyCapacity < 0 ||
        (local.historyWordOffset === null) !== (local.historyCapacity === 0) ||
        (persistent &&
          (local.historyCapacity < 1 || local.historyWordOffset === null))
      ) {
        throw new GpuBindingError(
          `compiled WGSL state frame ${frameIndex} has invalid local ${localIndex}`,
        );
      }
      if (
        local.committedInitWordOffset !== null &&
        local.tentativeInitWordOffset !== null
      ) {
        claim(
          local.committedInitWordOffset,
          1,
          `local ${localIndex} committed init`,
        );
        claim(
          local.tentativeInitWordOffset,
          1,
          `local ${localIndex} tentative init`,
        );
      }
      if (local.historyWordOffset !== null) {
        claim(
          local.historyWordOffset,
          local.historyCapacity * local.valueWordCount,
          `local ${localIndex} history`,
        );
      }
    });
    const slots = new Set<number>();
    frame.children.forEach((child, childIndex) => {
      const childFrame = frames[child.templateId];
      if (
        !Number.isSafeInteger(child.slot) ||
        child.slot < 0 ||
        slots.has(child.slot) ||
        childFrame === undefined
      ) {
        throw new GpuBindingError(
          `compiled WGSL state frame ${frameIndex} has invalid child ${childIndex}`,
        );
      }
      slots.add(child.slot);
      claim(child.wordOffset, childFrame.wordCount, `child ${childIndex}`);
    });
    claimed.sort((left, right) => left.start - right.start);
    let claimedEnd = 0;
    for (const range of claimed) {
      if (range.start < claimedEnd) {
        throw new GpuBindingError(
          `compiled WGSL state frame ${frameIndex} has overlapping ${range.owner} range`,
        );
      }
      claimedEnd = range.end;
    }
  });
  const root = frames[0];
  if (
    root === undefined ||
    state.rootFrameWordOffset + root.wordCount !== state.wordsPerExecution
  ) {
    throw new GpuBindingError(
      'compiled WGSL execution-state manifest has an invalid root extent',
    );
  }
}

function validateCacheContract(artifact: CompiledWgslProgram): void {
  const {cache} = artifact;
  const overrides = [
    cache.overrides.workgroupSize,
    cache.overrides.cacheWordsPerExecution,
    cache.overrides.cacheAllocationWords,
  ];
  if (
    cache.storageEntryPoint !== artifact.module.entryPoint ||
    cache.cachedEntryPoint.length === 0 ||
    cache.cachedEntryPoint === cache.storageEntryPoint ||
    overrides.some(
      override =>
        !Number.isSafeInteger(override.numericId) ||
        override.numericId < 0 ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(override.id) ||
        !Number.isSafeInteger(override.defaultValue) ||
        override.defaultValue < 0,
    ) ||
    new Set(overrides.map(override => override.numericId)).size !==
      overrides.length ||
    new Set(overrides.map(override => override.id)).size !== overrides.length ||
    cache.overrides.workgroupSize.numericId !== 0 ||
    cache.overrides.cacheWordsPerExecution.numericId !== 1 ||
    cache.overrides.cacheAllocationWords.numericId !== 2 ||
    cache.overrides.workgroupSize.defaultValue !== artifact.workgroupSize[0] ||
    cache.overrides.cacheWordsPerExecution.defaultValue !== 0 ||
    cache.overrides.cacheAllocationWords.defaultValue !== 1 ||
    cache.segments.length === 0
  ) {
    throw new GpuBindingError('compiled WGSL has an invalid cache contract');
  }
  let cacheEnd = 0;
  const ids = new Set<string>();
  cache.segments.forEach((segment, rank) => {
    if (
      segment.rank !== rank ||
      segment.id.length === 0 ||
      segment.owner.length === 0 ||
      ids.has(segment.id) ||
      (segment.kind !== 'header' &&
        segment.kind !== 'activation' &&
        segment.kind !== 'local') ||
      !Number.isSafeInteger(segment.storageWordOffset) ||
      segment.storageWordOffset < 0 ||
      !Number.isSafeInteger(segment.cacheWordOffset) ||
      segment.cacheWordOffset !== cacheEnd ||
      !Number.isSafeInteger(segment.wordCount) ||
      segment.wordCount <= 0 ||
      segment.cacheEnd !== segment.cacheWordOffset + segment.wordCount ||
      segment.cacheEnd > MAX_U32 ||
      !Number.isSafeInteger(segment.estimatedReadsPerRow) ||
      segment.estimatedReadsPerRow < 0 ||
      !Number.isSafeInteger(segment.estimatedWritesPerRow) ||
      segment.estimatedWritesPerRow < 0
    ) {
      throw new GpuBindingError(
        `compiled WGSL has an invalid cache segment ${rank}`,
      );
    }
    ids.add(segment.id);
    cacheEnd = segment.cacheEnd;
  });
  let storageEnd = 0;
  for (const segment of [...cache.segments].sort(
    (left, right) => left.storageWordOffset - right.storageWordOffset,
  )) {
    if (segment.storageWordOffset !== storageEnd) {
      throw new GpuBindingError(
        'compiled WGSL cache segments do not partition execution state',
      );
    }
    storageEnd += segment.wordCount;
  }
  if (
    cacheEnd !== artifact.state.wordsPerExecution ||
    storageEnd !== artifact.state.wordsPerExecution
  ) {
    throw new GpuBindingError(
      'compiled WGSL cache segments disagree with execution state',
    );
  }
}

function logicalSchemaMatchesPhysical(
  logical: import('../../ir/program').EffectValueSchema,
  physical: WgslValueSchema,
): boolean {
  if (logical.kind !== physical.kind) return false;
  if (logical.kind === 'enum' && physical.kind === 'enum') {
    return (
      logical.typeId === physical.typeId &&
      logical.displayName === physical.name &&
      logical.members.length === physical.members.length &&
      logical.members.every(
        (member, index) => member.name === physical.members[index],
      )
    );
  }
  if (logical.kind === 'user-type' && physical.kind === 'user-type') {
    return (
      logical.typeId === physical.typeId &&
      logical.displayName === physical.name &&
      logical.fields.length === physical.fields.length &&
      logical.fields.every(
        (field, index) =>
          field.name === physical.fields[index]?.name &&
          logicalSchemaMatchesPhysical(
            field.value,
            physical.fields[index]!.value,
          ),
      )
    );
  }
  return true;
}

function transportMatchesResult(
  transport: CompiledWgslProgram['outputSchemas'][number]['channels'][number]['transport'],
  result: WgslResultChannel,
): boolean {
  if (transport.kind !== result.scalar) return false;
  return (
    transport.kind !== 'enum' ||
    (result.enumMembers !== null &&
      transport.members.length === result.enumMembers.length &&
      transport.members.every(
        (member, index) => member === result.enumMembers?.[index],
      ))
  );
}

function validateValueSchema(
  artifact: CompiledWgslProgram,
  schema: WgslValueSchema,
  owner: string,
): void {
  const layout = artifact.layouts[schema.physicalLayout];
  if (layout === undefined) {
    throw new GpuBindingError(`${owner} has an invalid value layout`);
  }
  const offsets: number[] = [];
  switch (schema.kind) {
    case 'bool':
      offsets.push(schema.valueByteOffset);
      break;
    case 'int':
    case 'float':
    case 'string':
    case 'color':
      offsets.push(schema.validByteOffset, schema.valueByteOffset);
      break;
    case 'enum':
      offsets.push(schema.validByteOffset, schema.ordinalByteOffset);
      if (new Set(schema.members).size !== schema.members.length) {
        throw new GpuBindingError(`${owner} has duplicate enum members`);
      }
      break;
    case 'user-type': {
      offsets.push(schema.validByteOffset);
      const intervals: Array<readonly [number, number]> = [];
      schema.fields.forEach(field => {
        const nested = artifact.layouts[field.value.physicalLayout];
        if (
          nested === undefined ||
          !Number.isSafeInteger(field.byteOffset) ||
          field.byteOffset < 0 ||
          field.byteOffset % 4 !== 0 ||
          field.byteOffset + nested.byteSize > layout.byteSize
        ) {
          throw new GpuBindingError(
            `${owner}.${field.name} has an invalid offset`,
          );
        }
        intervals.push([field.byteOffset, field.byteOffset + nested.byteSize]);
        validateValueSchema(artifact, field.value, `${owner}.${field.name}`);
      });
      intervals.sort((left, right) => left[0] - right[0]);
      for (let index = 1; index < intervals.length; index += 1) {
        if (intervals[index][0] < intervals[index - 1][1]) {
          throw new GpuBindingError(`${owner} has overlapping fields`);
        }
      }
      break;
    }
  }
  if (
    offsets.some(
      offset =>
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset % 4 !== 0 ||
        offset + 4 > layout.byteSize,
    )
  ) {
    throw new GpuBindingError(`${owner} has an invalid scalar offset`);
  }
}

function f32Input(
  value: number,
  bindingIndex: number,
  seriesId: string,
  row: number,
): number {
  if (Number.isNaN(value)) return NaN;
  const rounded = Math.fround(value);
  if (!Number.isFinite(value) || !Number.isFinite(rounded)) {
    throw new GpuBindingError(
      `GPU binding ${bindingIndex} series '${seriesId}' row ${row} is not finite f32`,
    );
  }
  return rounded;
}

function physicalStorageBufferBytes(
  logical: number,
  elementByteStride: number,
): number {
  return Math.max(MIN_WEBGPU_BUFFER_BYTES, elementByteStride, logical);
}

function checkedProduct(left: number, right: number, label: string): number {
  const value = left * right;
  requireU32(value, label);
  return value;
}

function checkedSum(values: readonly number[], label: string): number {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) {
      throw new GpuBindingError(`${label} exceeds safe host allocation`);
    }
  }
  return result;
}

function requireU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    throw new GpuBindingError(`${label} exceeds the u32 execution ABI`);
  }
}

function positiveInteger(value: number, label: string): number {
  requireU32(value, label);
  if (value === 0) {
    throw new GpuBindingError(`${label} must be positive`);
  }
  return value;
}

function optionalPositiveInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function optionalNonnegativeInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  requireU32(value, label);
  return value;
}

function enforceBudget(
  resources: GpuResourceSizes,
  maxGpuBytes: number | undefined,
): void {
  if (maxGpuBytes !== undefined && resources.total > maxGpuBytes) {
    throw new GpuBindingError(
      `GPU execution requires ${resources.total} bytes, above maxGpuBytes ${maxGpuBytes}`,
    );
  }
}

function allocateBytes(byteLength: number, label: string): Uint8Array {
  try {
    return new Uint8Array(byteLength);
  } catch {
    throw new GpuBindingError(`${label} cannot allocate ${byteLength} bytes`);
  }
}
