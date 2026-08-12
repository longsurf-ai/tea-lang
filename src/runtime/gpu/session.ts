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
  type Value,
} from '../abi';
import {resolveParamValues} from '../params';

const MAX_U32 = 0xffff_ffff;
const MAX_I32 = 0x7fff_ffff;
const DEFAULT_MAX_ROWS_PER_CHUNK = 1024;
const MIN_WEBGPU_BUFFER_BYTES = 4;

export interface GpuExecutionOptions {
  readonly maxRowsPerChunk?: number;
  readonly effectRecordsPerLane?: number;
  readonly maxGpuBytes?: number;
}

export interface GpuChunkResult {
  readonly bindings: readonly GpuBindingProgress[];
  readonly done: boolean;
}

export interface GpuRunSummary {
  readonly bindings: readonly GpuBindingSummary[];
  readonly chunks: number;
  readonly dispatches: number;
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
  readonly laneStates: GPUBuffer;
  readonly results: GPUBuffer;
  readonly effectStatus: GPUBuffer;
  readonly effectRecords: GPUBuffer;
  readonly params: GPUBuffer;
  readonly readbackResults: GPUBuffer;
  readonly readbackEffectStatus: GPUBuffer;
  readonly readbackEffectRecords: GPUBuffer;
}

interface ActiveGpuLane {
  readonly laneIndex: number;
  readonly progress: GpuBindingProgress;
}

export interface PreparedGpuLane {
  readonly bindingIndex: number;
  readonly inputs: BindInputs;
  readonly context: ProviderContext;
  readonly rows: number;
  readonly boundInputs: readonly BoundInput[];
  // Scalar-cell offset into `seriesPayload`; every required series occupies
  // one complete, contiguous row span in artifact order.
  readonly seriesOffset: number;
  // Scalar-slot offset into the lane-major parameter payload.
  readonly paramsOffset: number;
}

export interface GpuResourceSizes {
  readonly jobs: number;
  readonly series: number;
  readonly laneStates: number;
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
  readonly lanes: readonly PreparedGpuLane[];
  readonly seriesPayload: Uint8Array;
  readonly descriptorPayload: Uint8Array;
  readonly paramPayload: Uint8Array;
  readonly chunkRows: number;
  readonly effectRecordsPerLane: number;
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

export async function createGpuExecution(
  device: GPUDevice,
  artifact: CompiledWgslProgram,
  bindings: readonly BindInputs[],
  options: GpuExecutionOptions = {},
): Promise<GpuExecution> {
  const prepared = await prepareGpuExecutionInputs(artifact, bindings, options);
  const declaration = executionDeclaration(artifact);
  if (prepared.resources.total === 0) {
    declareBindings(prepared, declaration);
    return new InertGpuExecution(prepared);
  }

  validateDeviceLimits(device, prepared);
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
      laneStates: make(
        resources.laneStates,
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
      compute: {module, entryPoint: artifact.module.entryPoint},
    });
    const external = artifact.externalBuffers;
    const entries: GPUBindGroupEntry[] = [
      {binding: external.jobsBinding, resource: {buffer: gpuBuffers.jobs}},
      {
        binding: external.laneStatesBinding,
        resource: {buffer: gpuBuffers.laneStates},
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
    );
  } catch (error) {
    buffers.forEach(buffer => buffer.destroy());
    throw error;
  }
}

class InertGpuExecution implements GpuExecution {
  private disposed = false;
  constructor(private readonly prepared: PreparedGpuExecution) {}
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
      bindings: this.prepared.lanes.map(lane => ({
        bindingIndex: lane.bindingIndex,
        rows: lane.rows,
        inputs: lane.boundInputs,
      })),
      chunks: 0,
      dispatches: 0,
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

  constructor(
    private readonly device: GPUDevice,
    private readonly prepared: PreparedGpuExecution,
    private readonly pipeline: GPUComputePipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly buffers: GpuBuffers,
  ) {
    this.cursors = prepared.lanes.map(() => 0);
  }

  get done(): boolean {
    return this.prepared.lanes.every(
      (lane, index) => this.cursors[index] >= lane.rows,
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
      bindings: this.prepared.lanes.map(lane => ({
        bindingIndex: lane.bindingIndex,
        rows: lane.rows,
        inputs: lane.boundInputs,
      })),
      chunks: this.chunks,
      dispatches: this.dispatches,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    Object.values(this.buffers).forEach(buffer => buffer.destroy());
  }

  private async executeChunk(): Promise<GpuChunkResult> {
    const active = this.prepared.lanes
      .map((lane, laneIndex): ActiveGpuLane => {
        const rowStart = this.cursors[laneIndex];
        const rowCount = Math.min(
          this.prepared.chunkRows,
          lane.rows - rowStart,
        );
        return {
          laneIndex,
          progress: {
            bindingIndex: lane.bindingIndex,
            rowStart,
            rowCount,
            done: rowStart + rowCount >= lane.rows,
          },
        };
      })
      .filter(item => item.progress.rowCount > 0);
    const progress = active.map(item => item.progress);
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.buffers.results);
    encoder.clearBuffer(this.buffers.effectStatus);
    encoder.clearBuffer(this.buffers.effectRecords);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(
        this.prepared.lanes.length / this.prepared.artifact.workgroupSize[0],
      ),
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
    this.device.queue.submit([encoder.finish()]);
    const [results, effectStatus, effectRecords] = await Promise.all([
      readback(this.buffers.readbackResults),
      readback(this.buffers.readbackEffectStatus),
      readback(this.buffers.readbackEffectRecords),
    ]);
    publishChunk(this.prepared, active, results, effectStatus, effectRecords);
    active.forEach(({laneIndex, progress: item}) => {
      this.cursors[laneIndex] = item.rowStart + item.rowCount;
    });
    this.chunks += 1;
    this.dispatches += 1;
    return {bindings: progress, done: this.done};
  }
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
  active: readonly ActiveGpuLane[],
  results: Uint8Array,
  effectStatus: Uint8Array,
  effectRecords: Uint8Array,
): void {
  const artifact = prepared.artifact;
  const resultView = dataView(results, 'dense result');
  const statusView = dataView(effectStatus, 'effect status');
  const recordView = dataView(effectRecords, 'effect record');
  const byBinding = new Map(
    active.map(item => [item.progress.bindingIndex, item.progress]),
  );
  const effectsByLane = prepared.lanes.map(
    () => new Map<number, EffectEmission[]>(),
  );

  for (const [laneIndex, lane] of prepared.lanes.entries()) {
    const base = laneIndex * artifact.effectStatusByteStride;
    const count = readU32(statusView, base, 'effect count');
    const overflow = readU32(statusView, base + 4, 'effect overflow');
    if (overflow !== 0 && overflow !== 1) {
      throw new GpuExecutionError(
        `GPU binding ${lane.bindingIndex} returned invalid effect overflow flag ${overflow}`,
      );
    }
    if (overflow === 1) {
      const row = readU32(statusView, base + 8, 'first overflow row');
      const effectId = readU32(statusView, base + 12, 'first overflow effect');
      throw new GpuExecutionError(
        `GPU binding ${lane.bindingIndex} effect buffer overflowed at row ${row}, effect ${effectId}`,
      );
    }
    if (count > prepared.effectRecordsPerLane) {
      throw new GpuExecutionError(
        `GPU binding ${lane.bindingIndex} returned ${count} effects above capacity ${prepared.effectRecordsPerLane}`,
      );
    }
    const laneProgress = byBinding.get(lane.bindingIndex);
    if (laneProgress === undefined && count !== 0) {
      throw new GpuExecutionError(
        `completed GPU binding ${lane.bindingIndex} returned ${count} effects`,
      );
    }
    for (let index = 0; index < count; index += 1) {
      const recordBase =
        (laneIndex * prepared.effectRecordsPerLane + index) *
        artifact.effectRecordByteStride;
      const row = readU32(recordView, recordBase, 'effect row');
      const effectId = readU32(recordView, recordBase + 4, 'effect id');
      const schema = artifact.effectSchemas[effectId];
      if (schema === undefined || schema.effectId !== effectId) {
        throw new GpuExecutionError(
          `GPU binding ${lane.bindingIndex} returned unknown effect ${effectId}`,
        );
      }
      if (
        laneProgress === undefined ||
        row < laneProgress.rowStart ||
        row >= laneProgress.rowStart + laneProgress.rowCount
      ) {
        throw new GpuExecutionError(
          `GPU binding ${lane.bindingIndex} returned effect row ${row} outside the current chunk`,
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
      const rowEffects = effectsByLane[laneIndex].get(row) ?? [];
      rowEffects.push(emission);
      effectsByLane[laneIndex].set(row, rowEffects);
    }
  }

  const publications: Array<{
    readonly laneIndex: number;
    readonly rows: readonly RowPublication[];
  }> = [];
  for (const {laneIndex, progress: item} of active) {
    const rows: RowPublication[] = [];
    for (let localRow = 0; localRow < item.rowCount; localRow += 1) {
      const row = item.rowStart + localRow;
      rows.push({
        row,
        outputs: decodeOutputs(prepared, resultView, laneIndex, localRow),
        effects: effectsByLane[laneIndex].get(row) ?? [],
        provisional: false,
      });
    }
    publications.push({laneIndex, rows});
  }
  // Nothing externally visible occurs until every lane's complete readback
  // has passed overflow, range, id, and payload validation.
  for (const publication of publications) {
    const sink = prepared.lanes[publication.laneIndex].inputs.sink;
    publication.rows.forEach(row => sink.publish(row));
  }
}

function decodeOutputs(
  prepared: PreparedGpuExecution,
  view: DataView,
  laneIndex: number,
  localRow: number,
): DenseEmission[] {
  const artifact = prepared.artifact;
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
          laneIndex * prepared.chunkRows * artifact.resultChannels.length +
          localRow * artifact.resultChannels.length +
          channel.rowCell;
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
  prepared.lanes.forEach(lane => lane.inputs.sink.declare(declaration));
}

function validateDeviceLimits(
  device: GPUDevice,
  prepared: PreparedGpuExecution,
): void {
  const maximumBuffer = Number(device.limits.maxBufferSize);
  const maximumStorage = Number(device.limits.maxStorageBufferBindingSize);
  for (const [name, size] of Object.entries(prepared.resources)) {
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
  const workgroups = Math.ceil(
    prepared.lanes.length / prepared.artifact.workgroupSize[0],
  );
  if (workgroups > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new GpuExecutionError(
      `GPU dispatch requires ${workgroups} workgroups; device limit is ${device.limits.maxComputeWorkgroupsPerDimension}`,
    );
  }
  const [x, y, z] = prepared.artifact.workgroupSize;
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
}

// This is intentionally target-runtime preparation, not compilation: it
// resolves concrete jobs against an already complete, bind-independent WGSL
// artifact and derives all bounded physical resources.
export async function prepareGpuExecutionInputs(
  artifact: CompiledWgslProgram,
  bindings: readonly BindInputs[],
  options: GpuExecutionOptions = {},
): Promise<PreparedGpuExecution> {
  validateArtifact(artifact);
  const requestedRows = positiveInteger(
    options.maxRowsPerChunk ?? DEFAULT_MAX_ROWS_PER_CHUNK,
    'maxRowsPerChunk',
  );
  const requestedEffectCapacity = optionalNonnegativeInteger(
    options.effectRecordsPerLane,
    'effectRecordsPerLane',
  );
  const maxGpuBytes = optionalPositiveInteger(
    options.maxGpuBytes,
    'maxGpuBytes',
  );

  // Provider resolution is a property of provider identity and context
  // coordinates, not parameter values. Parameter-only sweep lanes therefore
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

  const scalarValues: number[] = [];
  const lanes: PreparedGpuLane[] = [];
  const contextSeriesOffsets = new Map<ProviderContext, number>();
  for (const {inputs, bindingIndex, context, boundInputs} of resolved) {
    let seriesOffset = contextSeriesOffsets.get(context);
    if (seriesOffset === undefined) {
      seriesOffset = scalarValues.length;
      contextSeriesOffsets.set(context, seriesOffset);
      for (const required of artifact.requiredSeries) {
        const series = context.series(required.id);
        if (series === null) {
          throw new GpuBindingError(
            `GPU binding ${bindingIndex} is missing required series '${required.id}'`,
          );
        }
        if (series.length !== context.rows) {
          throw new GpuBindingError(
            `GPU binding ${bindingIndex} series '${required.id}' has ${series.length} rows; expected ${context.rows}`,
          );
        }
        for (let row = 0; row < context.rows; row += 1) {
          scalarValues.push(
            f32Input(series.at(row), bindingIndex, required.id, row),
          );
        }
      }
    }
    lanes.push({
      bindingIndex,
      inputs,
      context,
      rows: context.rows,
      boundInputs,
      seriesOffset,
      paramsOffset: bindingIndex * artifact.params.length,
    });
  }

  const seriesPayload = packSeries(scalarValues, artifact);
  const paramPayload = packParams(lanes, artifact);
  const maximumRows = lanes.reduce((max, lane) => Math.max(max, lane.rows), 0);
  const plan = planResources(
    artifact,
    lanes.length,
    seriesPayload.byteLength,
    paramPayload.byteLength,
    maximumRows,
    requestedRows,
    requestedEffectCapacity,
    maxGpuBytes,
  );
  const descriptorPayload = packInitialDescriptors(
    artifact,
    lanes,
    plan.chunkRows,
    plan.effectRecordsPerLane,
  );
  return {
    artifact,
    lanes,
    seriesPayload,
    descriptorPayload,
    paramPayload,
    chunkRows: plan.chunkRows,
    effectRecordsPerLane: plan.effectRecordsPerLane,
    resources: plan.resources,
  };
}

function planResources(
  artifact: CompiledWgslProgram,
  laneCount: number,
  seriesBytes: number,
  paramBytes: number,
  maximumRows: number,
  requestedRows: number,
  requestedEffectCapacity: number | undefined,
  maxGpuBytes: number | undefined,
): {
  readonly chunkRows: number;
  readonly effectRecordsPerLane: number;
  readonly resources: GpuResourceSizes;
} {
  if (laneCount === 0 || maximumRows === 0) {
    const resources: GpuResourceSizes = {
      jobs: 0,
      series: 0,
      laneStates: 0,
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
    return {chunkRows: 0, effectRecordsPerLane: 0, resources};
  }

  let upperRows = Math.min(requestedRows, maximumRows);
  if (artifact.maxEffectsPerRow > 0 && requestedEffectCapacity !== undefined) {
    if (requestedEffectCapacity < artifact.maxEffectsPerRow) {
      throw new GpuBindingError(
        `effectRecordsPerLane ${requestedEffectCapacity} cannot hold one row's maximum ${artifact.maxEffectsPerRow} effects`,
      );
    }
    upperRows = Math.min(
      upperRows,
      Math.floor(requestedEffectCapacity / artifact.maxEffectsPerRow),
    );
  }

  for (let chunkRows = upperRows; chunkRows >= 1; chunkRows -= 1) {
    const effectRecordsPerLane =
      artifact.maxEffectsPerRow === 0
        ? 0
        : (requestedEffectCapacity ??
          checkedProduct(
            chunkRows,
            artifact.maxEffectsPerRow,
            'GPU effect records per lane',
          ));
    const resources = resourceSizes(
      artifact,
      laneCount,
      seriesBytes,
      paramBytes,
      chunkRows,
      effectRecordsPerLane,
    );
    if (maxGpuBytes === undefined || resources.total <= maxGpuBytes) {
      return {chunkRows, effectRecordsPerLane, resources};
    }
    // Explicit effect capacity does not shrink with the dense chunk. The loop
    // still finds a smaller dense allocation when one can fit.
  }
  throw new GpuBindingError(
    `GPU execution cannot fit one row per active lane within maxGpuBytes ${maxGpuBytes}`,
  );
}

function resourceSizes(
  artifact: CompiledWgslProgram,
  laneCount: number,
  seriesBytes: number,
  paramBytes: number,
  chunkRows: number,
  effectRecordsPerLane: number,
): GpuResourceSizes {
  const channels = artifact.resultChannels.length;
  const logical = {
    jobs: checkedProduct(
      laneCount,
      artifact.jobDescriptorByteStride,
      'GPU descriptor bytes',
    ),
    series: seriesBytes,
    params: paramBytes,
    laneStates: checkedProduct(
      laneCount,
      artifact.laneStateByteStride,
      'GPU lane-state bytes',
    ),
    results: checkedProduct(
      checkedProduct(laneCount, chunkRows, 'GPU result rows'),
      checkedProduct(
        channels,
        artifact.resultCellByteStride,
        'GPU result row bytes',
      ),
      'GPU result bytes',
    ),
    effectStatus: checkedProduct(
      laneCount,
      artifact.effectStatusByteStride,
      'GPU effect-status bytes',
    ),
    effectRecords: checkedProduct(
      checkedProduct(
        laneCount,
        effectRecordsPerLane,
        'GPU effect record count',
      ),
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
    laneStates: physicalStorageBufferBytes(
      logical.laneStates,
      artifact.laneStateByteStride,
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
        resources.laneStates,
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
  values: readonly number[],
  artifact: CompiledWgslProgram,
): Uint8Array {
  const bytes = allocateBytes(
    checkedProduct(
      values.length,
      artifact.seriesScalarByteStride,
      'GPU series bytes',
    ),
    'GPU series payload',
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  values.forEach((value, index) => {
    const offset = index * artifact.seriesScalarByteStride;
    if (Number.isNaN(value)) {
      view.setUint32(offset, 0x7fc0_0000, true);
    } else {
      view.setFloat32(offset, value, true);
    }
  });
  return bytes;
}

function packParams(
  lanes: readonly PreparedGpuLane[],
  artifact: CompiledWgslProgram,
): Uint8Array {
  const slotCount = checkedProduct(
    lanes.length,
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
  lanes.forEach(lane => {
    lane.boundInputs.forEach((input, pid) => {
      const offset = (lane.paramsOffset + pid) * artifact.parameterByteStride;
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
              `GPU binding ${lane.bindingIndex} parameter '${input.spec.name}' is outside the i32 target profile`,
            );
          }
          view.setInt32(offset, value, true);
          break;
        }
        case 'float': {
          const value = input.value;
          if (typeof value !== 'number') {
            throw new GpuBindingError(
              `GPU binding ${lane.bindingIndex} parameter '${input.spec.name}' is not numeric`,
            );
          }
          const rounded = Math.fround(value);
          if (!Number.isFinite(rounded)) {
            throw new GpuBindingError(
              `GPU binding ${lane.bindingIndex} parameter '${input.spec.name}' is outside the finite f32 target profile`,
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
              `GPU binding ${lane.bindingIndex} parameter '${input.spec.name}' has no physical enum ordinal`,
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
  lanes: readonly PreparedGpuLane[],
  chunkRows: number,
  effectRecordsPerLane: number,
): Uint8Array {
  const bytes = allocateBytes(
    checkedProduct(
      lanes.length,
      artifact.jobDescriptorByteStride,
      'GPU descriptor bytes',
    ),
    'GPU descriptor payload',
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cellsPerLane = checkedProduct(
    chunkRows,
    artifact.resultChannels.length,
    'GPU result cells per lane',
  );
  lanes.forEach((lane, laneIndex) => {
    const base = laneIndex * artifact.jobDescriptorByteStride;
    const offsets = artifact.jobDescriptorOffsets;
    view.setUint32(base + offsets.seriesOffset, lane.seriesOffset, true);
    view.setUint32(base + offsets.rowCount, lane.rows, true);
    view.setUint32(base + offsets.resultOffset, laneIndex * cellsPerLane, true);
    view.setUint32(base + offsets.resultCount, cellsPerLane, true);
    view.setUint32(
      base + offsets.effectOffset,
      laneIndex * effectRecordsPerLane,
      true,
    );
    view.setUint32(base + offsets.effectCapacity, effectRecordsPerLane, true);
    view.setUint32(
      base + offsets.chunkRows,
      Math.min(chunkRows, lane.rows),
      true,
    );
    view.setUint32(base + offsets.paramsOffset, lane.paramsOffset, true);
  });
  return bytes;
}

function validateArtifact(artifact: CompiledWgslProgram): void {
  const bindings = [
    artifact.externalBuffers.jobsBinding,
    artifact.externalBuffers.seriesBinding,
    artifact.externalBuffers.laneStatesBinding,
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
    laneStateByteStride: artifact.laneStateByteStride,
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
    laneStateByteStride: 8,
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
  requireLayout(artifact.laneStateLayout, 'lane state');
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
    [artifact.laneStateLayout, artifact.laneStateByteStride, 'lane state'],
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
