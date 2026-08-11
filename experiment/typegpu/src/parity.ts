// Purpose: Reject any GPU summary or sparse exchange journal that disagrees with deterministic CPU replay.

import type {CpuBacktestResult} from './backtest-contract';
import {
  GPU_BACKTEST_STATUS_SUCCESS,
  GPU_EVENT_FILL,
  GPU_EVENT_ORDER_EXPIRED,
  GPU_EVENT_ORDER_SUBMITTED,
  GPU_SIDE_BUY,
  GPU_SIDE_SELL,
} from './typegpu-kernel';
import type {TypeGpuSweepOutput} from './typegpu-engine';

// Full-history journal replay on Apple Metal differs by at most 6 ULPs in
// aggregate metrics; 8 leaves one explicit rounding step of headroom.
const MAX_F32_ULP_DISTANCE = 8;
const f32Bytes = new ArrayBuffer(4);
const f32View = new DataView(f32Bytes);

type GpuSummary = TypeGpuSweepOutput['summaries'][number];
type GpuEvent = TypeGpuSweepOutput['events'][number];

export class GpuParityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpuParityError';
  }
}

function orderedF32Bits(value: number): number {
  f32View.setFloat32(0, Math.fround(value), false);
  const bits = f32View.getUint32(0, false);
  if ((bits & 0x8000_0000) !== 0) {
    return 0x8000_0000 - (bits & 0x7fff_ffff);
  }
  return 0x8000_0000 + bits;
}

export function f32UlpDistance(left: number, right: number): number {
  return Math.abs(orderedF32Bits(left) - orderedF32Bits(right));
}

function assertF32Near(label: string, gpu: number, cpu: number): void {
  if (!Number.isFinite(gpu) || !Number.isFinite(cpu)) {
    throw new GpuParityError(
      `${label} must be finite (GPU ${gpu}, CPU ${cpu})`,
    );
  }
  const distance = f32UlpDistance(gpu, cpu);
  if (distance > MAX_F32_ULP_DISTANCE) {
    throw new GpuParityError(
      `${label} differs by ${distance} f32 ULPs (GPU ${gpu}, CPU ${cpu})`,
    );
  }
}

function assertEqual(label: string, gpu: number, cpu: number): void {
  if (gpu !== cpu) {
    throw new GpuParityError(`${label} differs (GPU ${gpu}, CPU ${cpu})`);
  }
}

function expectedGpuKind(
  type: CpuBacktestResult['events'][number]['type'],
): number {
  if (type === 'order-submitted') return GPU_EVENT_ORDER_SUBMITTED;
  if (type === 'order-filled') return GPU_EVENT_FILL;
  return GPU_EVENT_ORDER_EXPIRED;
}

function expectedGpuSide(side: 'buy' | 'sell'): number {
  return side === 'buy' ? GPU_SIDE_BUY : GPU_SIDE_SELL;
}

export function indexGpuEventsByJob(
  output: TypeGpuSweepOutput,
): readonly (readonly GpuEvent[])[] {
  const eventsByJob: GpuEvent[][] = Array.from(
    {length: output.summaries.length},
    () => [],
  );
  for (const event of output.events) {
    const jobEvents = eventsByJob[event.jobIndex];
    if (!jobEvents) {
      throw new GpuParityError(
        `GPU event references missing job ${event.jobIndex}`,
      );
    }
    jobEvents.push(event);
  }
  for (const [jobIndex, events] of eventsByJob.entries()) {
    events.sort((left, right) => left.sequence - right.sequence);
    for (let sequence = 0; sequence < events.length; sequence++) {
      assertEqual(
        `job ${jobIndex} event sequence ${sequence}`,
        events[sequence].sequence,
        sequence,
      );
    }
  }
  return eventsByJob;
}

export function assertGpuSweepShape(output: TypeGpuSweepOutput): void {
  const expectedJobCount = output.seriesIds.length * output.parameters.length;
  assertEqual('GPU summary count', output.summaries.length, expectedJobCount);
  let expectedEventCount = 0;

  for (let jobIndex = 0; jobIndex < output.summaries.length; jobIndex++) {
    const summary = output.summaries[jobIndex];
    const seriesIndex = Math.floor(jobIndex / output.parameters.length);
    const parameterIndex = jobIndex % output.parameters.length;
    assertEqual(
      `job ${jobIndex} seriesIndex`,
      summary.seriesIndex,
      seriesIndex,
    );
    assertEqual(
      `job ${jobIndex} parameterIndex`,
      summary.parameterIndex,
      parameterIndex,
    );
    expectedEventCount += summary.eventCount;
  }
  assertEqual('GPU event count', output.events.length, expectedEventCount);
  indexGpuEventsByJob(output);
}

export function assertGpuJobMatchesCpu(options: {
  readonly cpu: CpuBacktestResult;
  readonly events: readonly GpuEvent[];
  readonly jobIndex: number;
  readonly parameterIndex: number;
  readonly seriesIndex: number;
  readonly summary: GpuSummary;
}): void {
  const {cpu, events, jobIndex, parameterIndex, seriesIndex, summary} = options;
  if (summary.status !== GPU_BACKTEST_STATUS_SUCCESS) {
    throw new GpuParityError(
      `job ${jobIndex} returned GPU status ${summary.status}, expected success`,
    );
  }
  assertEqual(`job ${jobIndex} seriesIndex`, summary.seriesIndex, seriesIndex);
  assertEqual(
    `job ${jobIndex} parameterIndex`,
    summary.parameterIndex,
    parameterIndex,
  );
  assertEqual(
    `job ${jobIndex} orderCount`,
    summary.orderCount,
    cpu.summary.orderCount,
  );
  assertEqual(
    `job ${jobIndex} fillCount`,
    summary.fillCount,
    cpu.summary.fillCount,
  );
  assertEqual(
    `job ${jobIndex} roundTripCount`,
    summary.roundTripCount,
    cpu.summary.roundTripCount,
  );
  assertEqual(
    `job ${jobIndex} eventCount`,
    summary.eventCount,
    cpu.events.length,
  );
  assertEqual(
    `job ${jobIndex} journal length`,
    events.length,
    cpu.events.length,
  );
  assertEqual(`job ${jobIndex} reserved`, summary.reserved, 0);
  assertF32Near(
    `job ${jobIndex} finalEquity`,
    summary.finalEquity,
    cpu.summary.finalEquity,
  );
  assertF32Near(
    `job ${jobIndex} totalReturn`,
    summary.totalReturn,
    cpu.summary.totalReturn,
  );
  assertF32Near(
    `job ${jobIndex} maxDrawdown`,
    summary.maxDrawdown,
    cpu.summary.maxDrawdown,
  );
  assertF32Near(
    `job ${jobIndex} totalFees`,
    summary.feesPaid,
    cpu.summary.totalFees,
  );

  for (let sequence = 0; sequence < cpu.events.length; sequence++) {
    const cpuEvent = cpu.events[sequence];
    const gpuEvent = events[sequence];
    if (!cpuEvent || !gpuEvent) {
      throw new GpuParityError(
        `job ${jobIndex} event ${sequence} is missing after count validation`,
      );
    }
    assertEqual(
      `job ${jobIndex} event ${sequence} jobIndex`,
      gpuEvent.jobIndex,
      jobIndex,
    );
    assertEqual(
      `job ${jobIndex} event ${sequence} sequence`,
      gpuEvent.sequence,
      sequence,
    );
    assertEqual(
      `job ${jobIndex} event ${sequence} barIndex`,
      gpuEvent.barIndex,
      cpuEvent.barIndex,
    );
    assertEqual(
      `job ${jobIndex} event ${sequence} kind`,
      gpuEvent.kind,
      expectedGpuKind(cpuEvent.type),
    );
    assertEqual(
      `job ${jobIndex} event ${sequence} side`,
      gpuEvent.side,
      expectedGpuSide(cpuEvent.side),
    );

    if (cpuEvent.type === 'order-filled') {
      assertF32Near(
        `job ${jobIndex} event ${sequence} fillPrice`,
        gpuEvent.price,
        cpuEvent.fillPrice,
      );
      assertF32Near(
        `job ${jobIndex} event ${sequence} quantity`,
        gpuEvent.quantity,
        cpuEvent.quantity,
      );
      assertF32Near(
        `job ${jobIndex} event ${sequence} fee`,
        gpuEvent.fee,
        cpuEvent.fee,
      );
    } else {
      assertF32Near(
        `job ${jobIndex} event ${sequence} price`,
        gpuEvent.price,
        0,
      );
      assertF32Near(
        `job ${jobIndex} event ${sequence} quantity`,
        gpuEvent.quantity,
        0,
      );
      assertF32Near(`job ${jobIndex} event ${sequence} fee`, gpuEvent.fee, 0);
    }
  }
}
