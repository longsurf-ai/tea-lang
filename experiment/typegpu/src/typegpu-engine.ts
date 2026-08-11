// Purpose: Pack backtest jobs, execute one TypeGPU dispatch, and read reconciliable GPU outputs.

import tgpu, {d} from 'typegpu';

import {
  backtestSweepKernel,
  backtestSweepLayout,
  GpuBacktestEvent,
  GpuBacktestSettings,
  GpuBacktestSummary,
  GpuJournalState,
  GpuParameterPair,
  GpuSeriesDescriptor,
  TYPEGPU_SWEEP_WORKGROUP_SIZE,
} from './typegpu-kernel';

const GPU_LAYOUT_STORAGE_BUFFER_COUNT = 8;
const U32_MAX = 0xffff_ffff;

// Journal bytes per event; callers size device storage limits from this.
export const GPU_EVENT_BYTE_LENGTH = d.sizeOf(GpuBacktestEvent);

export interface TypeGpuSeriesInput {
  readonly closes: ArrayLike<number>;
  readonly opens: ArrayLike<number>;
  readonly seriesId: string;
}

export interface TypeGpuParameterInput {
  readonly fastPeriod: number;
  readonly slowPeriod: number;
}

export interface TypeGpuSettingsInput {
  readonly feeRate: number;
  readonly initialCash: number;
  readonly slippageRate: number;
}

export interface TypeGpuSweepInput {
  readonly eventCapacity: number;
  readonly parameters: readonly TypeGpuParameterInput[];
  readonly series: readonly TypeGpuSeriesInput[];
  readonly settings: TypeGpuSettingsInput;
}

export interface TypeGpuSweepTimings {
  readonly encodeMs: number;
  readonly executionAndReadbackMs: number;
  readonly packMs: number;
  readonly totalMs: number;
}

export interface TypeGpuSweepOutput {
  readonly computeSubmissionCount: 1;
  readonly dispatchCount: 1;
  readonly eventCapacity: number;
  readonly events: readonly {
    readonly barIndex: number;
    readonly fee: number;
    readonly jobIndex: number;
    readonly kind: number;
    readonly price: number;
    readonly quantity: number;
    readonly sequence: number;
    readonly side: number;
  }[];
  readonly journal: {
    readonly capacity: number;
    readonly cursor: number;
    readonly overflow: number;
  };
  readonly parameters: readonly TypeGpuParameterInput[];
  readonly seriesIds: readonly string[];
  readonly readbackSubmissionCount: number;
  readonly summaries: readonly {
    readonly eventCount: number;
    readonly feesPaid: number;
    readonly fillCount: number;
    readonly finalEquity: number;
    readonly maxDrawdown: number;
    readonly orderCount: number;
    readonly parameterIndex: number;
    readonly reserved: number;
    readonly roundTripCount: number;
    readonly seriesIndex: number;
    readonly status: number;
    readonly totalReturn: number;
  }[];
  readonly timings: TypeGpuSweepTimings;
}

export class GpuJournalOverflowError extends Error {
  constructor(
    readonly attemptedEventCount: number,
    readonly eventCapacity: number,
  ) {
    super(
      `GPU event journal overflowed: ${attemptedEventCount} events attempted for capacity ${eventCapacity}`,
    );
    this.name = 'GpuJournalOverflowError';
  }
}

interface PackedSweepInput {
  readonly closes: Float32Array;
  readonly descriptors: readonly {length: number; offset: number}[];
  readonly opens: Float32Array;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > U32_MAX) {
    throw new Error(`${label} must be a positive u32, received ${value}`);
  }
}

function assertFiniteF32(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new Error(`${label} must be representable as a finite f32`);
  }
}

function packSeries(
  seriesInputs: readonly TypeGpuSeriesInput[],
): PackedSweepInput {
  if (seriesInputs.length === 0) {
    throw new Error('At least one input series is required');
  }

  let totalBarCount = 0;
  for (const [seriesIndex, series] of seriesInputs.entries()) {
    if (series.seriesId.length === 0) {
      throw new Error(`Series ${seriesIndex} has an empty identity`);
    }
    if (series.opens.length !== series.closes.length) {
      throw new Error(
        `Series ${series.seriesId} has ${series.opens.length} opens but ${series.closes.length} closes`,
      );
    }
    assertPositiveInteger(series.opens.length, `${series.seriesId} bar count`);
    totalBarCount += series.opens.length;
    if (!Number.isSafeInteger(totalBarCount) || totalBarCount > U32_MAX) {
      throw new Error(
        'Packed bar count exceeds the u32 descriptor address space',
      );
    }
  }

  const opens = new Float32Array(totalBarCount);
  const closes = new Float32Array(totalBarCount);
  const descriptors: {length: number; offset: number}[] = [];
  let offset = 0;

  for (const series of seriesInputs) {
    descriptors.push({offset, length: series.opens.length});
    for (let index = 0; index < series.opens.length; index++) {
      const open = series.opens[index];
      const close = series.closes[index];
      assertFiniteF32(open, `${series.seriesId} open[${index}]`);
      assertFiniteF32(close, `${series.seriesId} close[${index}]`);
      if (open <= 0 || close <= 0) {
        throw new Error(`${series.seriesId} prices must be positive`);
      }
      opens[offset + index] = open;
      closes[offset + index] = close;
    }
    offset += series.opens.length;
  }

  return {opens, closes, descriptors};
}

function validateSweepInput(input: TypeGpuSweepInput): void {
  assertPositiveInteger(input.eventCapacity, 'eventCapacity');
  if (input.parameters.length === 0) {
    throw new Error('At least one SMA parameter pair is required');
  }
  assertPositiveInteger(input.parameters.length, 'parameter count');

  for (const [index, parameter] of input.parameters.entries()) {
    assertPositiveInteger(
      parameter.fastPeriod,
      `parameters[${index}].fastPeriod`,
    );
    assertPositiveInteger(
      parameter.slowPeriod,
      `parameters[${index}].slowPeriod`,
    );
    if (parameter.fastPeriod >= parameter.slowPeriod) {
      throw new Error(`parameters[${index}] must have fastPeriod < slowPeriod`);
    }
  }

  assertFiniteF32(input.settings.initialCash, 'initialCash');
  assertFiniteF32(input.settings.slippageRate, 'slippageRate');
  assertFiniteF32(input.settings.feeRate, 'feeRate');
  if (input.settings.initialCash <= 0) {
    throw new Error('initialCash must be positive');
  }
  if (
    input.settings.slippageRate < 0 ||
    input.settings.slippageRate >= 1 ||
    input.settings.feeRate < 0 ||
    input.settings.feeRate >= 1
  ) {
    throw new Error('slippageRate and feeRate must be in [0, 1)');
  }

  const jobCount = input.parameters.length * input.series.length;
  assertPositiveInteger(jobCount, 'job count');
}

function assertFitsDevice(
  device: GPUDevice,
  bindings: readonly {label: string; size: number}[],
  workgroupsX: number,
  workgroupsY: number,
): void {
  if (
    device.limits.maxStorageBuffersPerShaderStage <
    GPU_LAYOUT_STORAGE_BUFFER_COUNT
  ) {
    throw new Error(
      `Device exposes ${device.limits.maxStorageBuffersPerShaderStage} storage buffers per stage; ${GPU_LAYOUT_STORAGE_BUFFER_COUNT} are required`,
    );
  }

  for (const binding of bindings) {
    if (binding.size > device.limits.maxStorageBufferBindingSize) {
      throw new Error(
        `${binding.label} requires ${binding.size} bytes, exceeding maxStorageBufferBindingSize ${device.limits.maxStorageBufferBindingSize}`,
      );
    }
    if (binding.size > device.limits.maxBufferSize) {
      throw new Error(
        `${binding.label} requires ${binding.size} bytes, exceeding maxBufferSize ${device.limits.maxBufferSize}`,
      );
    }
  }

  if (
    workgroupsX > device.limits.maxComputeWorkgroupsPerDimension ||
    workgroupsY > device.limits.maxComputeWorkgroupsPerDimension
  ) {
    throw new Error(
      `Dispatch (${workgroupsX}, ${workgroupsY}) exceeds maxComputeWorkgroupsPerDimension ${device.limits.maxComputeWorkgroupsPerDimension}`,
    );
  }
}

export async function runTypeGpuSweep(
  device: GPUDevice,
  input: TypeGpuSweepInput,
): Promise<TypeGpuSweepOutput> {
  const totalStartedAt = performance.now();
  validateSweepInput(input);
  const packed = packSeries(input.series);
  const packedAt = performance.now();
  const root = tgpu.initFromDevice({device});
  const jobCount = input.series.length * input.parameters.length;
  const opensSchema = d.arrayOf(d.f32, packed.opens.length);
  const closesSchema = d.arrayOf(d.f32, packed.closes.length);
  const seriesSchema = d.arrayOf(
    GpuSeriesDescriptor,
    packed.descriptors.length,
  );
  const parameterSchema = d.arrayOf(GpuParameterPair, input.parameters.length);
  const summarySchema = d.arrayOf(GpuBacktestSummary, jobCount);
  const eventSchema = d.arrayOf(GpuBacktestEvent, input.eventCapacity);

  const bindingSizes = [
    {label: 'opens', size: d.sizeOf(opensSchema)},
    {label: 'closes', size: d.sizeOf(closesSchema)},
    {label: 'series descriptors', size: d.sizeOf(seriesSchema)},
    {label: 'parameters', size: d.sizeOf(parameterSchema)},
    {label: 'settings', size: d.sizeOf(GpuBacktestSettings)},
    {label: 'summaries', size: d.sizeOf(summarySchema)},
    {label: 'events', size: d.sizeOf(eventSchema)},
    {label: 'journal', size: d.sizeOf(GpuJournalState)},
  ] as const;
  const workgroupsX = Math.ceil(
    input.parameters.length / TYPEGPU_SWEEP_WORKGROUP_SIZE,
  );
  const workgroupsY = input.series.length;
  assertFitsDevice(device, bindingSizes, workgroupsX, workgroupsY);

  const opens = root.createBuffer(opensSchema, packed.opens).$usage('storage');
  const closes = root
    .createBuffer(closesSchema, packed.closes)
    .$usage('storage');
  const series = root
    .createBuffer(seriesSchema, packed.descriptors)
    .$usage('storage');
  const parameters = root
    .createBuffer(parameterSchema, input.parameters)
    .$usage('storage');
  const settings = root
    .createBuffer(GpuBacktestSettings, {
      ...input.settings,
      reserved: 0,
    })
    .$usage('storage');
  const summaries = root.createBuffer(summarySchema).$usage('storage');
  const events = root.createBuffer(eventSchema).$usage('storage');
  const journal = root
    .createBuffer(GpuJournalState, {
      cursor: 0,
      overflow: 0,
      capacity: input.eventCapacity,
    })
    .$usage('storage');
  const group = root.createBindGroup(backtestSweepLayout, {
    opens,
    closes,
    series,
    parameters,
    settings,
    summaries,
    events,
    journal,
  });

  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('internal');
  device.pushErrorScope('validation');

  let summaryValues!: TypeGpuSweepOutput['summaries'];
  let eventValues!: TypeGpuSweepOutput['events'];
  let journalValue!: TypeGpuSweepOutput['journal'];
  const encoder = device.createCommandEncoder({
    label: 'TypeGPU backtest single-dispatch encoder',
  });
  root
    .createComputePipeline({compute: backtestSweepKernel})
    .with(group)
    .with(encoder)
    .dispatchWorkgroups(workgroupsX, workgroupsY, 1);
  const encodedAt = performance.now();
  device.queue.submit([encoder.finish()]);

  let readbackSubmissionCount = 2;
  try {
    // TypeGPU 0.11.9 mapped-buffer reads must remain sequential. Concurrent
    // reads race Dawn cleanup on newer Node runtimes.
    journalValue = await journal.read();
    summaryValues = await summaries.read();
    const usedEventCount = Math.min(journalValue.cursor, input.eventCapacity);
    if (journalValue.overflow !== 0 || usedEventCount === 0) {
      // Overflowed journals hard-fail below; skip paying event readback first.
      eventValues = [];
    } else {
      // Read back only the journal prefix the kernel wrote. Deserializing the
      // full capacity-sized buffer costs seconds per million unused slots, so
      // capacity headroom must never influence readback time.
      const usedEventSchema = d.arrayOf(GpuBacktestEvent, usedEventCount);
      const staging = root.createBuffer(usedEventSchema);
      const copyEncoder = device.createCommandEncoder({
        label: 'TypeGPU backtest journal prefix readback encoder',
      });
      copyEncoder.copyBufferToBuffer(
        events.buffer,
        0,
        staging.buffer,
        0,
        d.sizeOf(usedEventSchema),
      );
      device.queue.submit([copyEncoder.finish()]);
      eventValues = await staging.read();
      readbackSubmissionCount = 4;
    }
  } finally {
    root.destroy();
  }

  const validationError = await device.popErrorScope();
  const internalError = await device.popErrorScope();
  const outOfMemoryError = await device.popErrorScope();
  const gpuError = validationError ?? internalError ?? outOfMemoryError;
  if (gpuError) {
    throw new Error(`WebGPU sweep failed: ${gpuError.message}`);
  }

  const completedAt = performance.now();
  if (
    journalValue.overflow !== 0 ||
    journalValue.cursor > input.eventCapacity
  ) {
    throw new GpuJournalOverflowError(journalValue.cursor, input.eventCapacity);
  }

  const orderedEvents = eventValues
    .slice(0, journalValue.cursor)
    .sort(
      (left, right) =>
        left.jobIndex - right.jobIndex || left.sequence - right.sequence,
    );

  return {
    dispatchCount: 1,
    computeSubmissionCount: 1,
    readbackSubmissionCount,
    eventCapacity: input.eventCapacity,
    seriesIds: input.series.map(seriesInput => seriesInput.seriesId),
    parameters: input.parameters,
    summaries: summaryValues,
    events: orderedEvents,
    journal: journalValue,
    timings: {
      packMs: packedAt - totalStartedAt,
      encodeMs: encodedAt - packedAt,
      executionAndReadbackMs: completedAt - encodedAt,
      totalMs: completedAt - totalStartedAt,
    },
  };
}
