// Purpose: Measure real f32 CPU/GPU drift before choosing the experiment's enforced parity tolerance.

import {parseBacktestInput} from './backtest-contract';
import type {MarketSnapshot, ParameterPair} from './contracts';
import {runCpuBacktest} from './cpu-backtest';
import {replayGpuBacktestJournal} from './journal-replay';
import {f32UlpDistance, indexGpuEventsByJob} from './parity';
import {
  GPU_EVENT_FILL,
  GPU_EVENT_ORDER_EXPIRED,
  GPU_EVENT_ORDER_SUBMITTED,
  GPU_SIDE_BUY,
  GPU_SIDE_SELL,
} from './typegpu-kernel';
import type {TypeGpuSweepOutput} from './typegpu-engine';

export interface ParityDriftObservation {
  readonly absoluteError: number;
  readonly cpu: number;
  readonly field: string;
  readonly gpu: number;
  readonly jobIndex: number;
  readonly relativeError: number;
  readonly sequence?: number;
  readonly ulpDistance: number;
}

function expectedKind(type: string): number {
  if (type === 'order-submitted') return GPU_EVENT_ORDER_SUBMITTED;
  if (type === 'order-filled') return GPU_EVENT_FILL;
  return GPU_EVENT_ORDER_EXPIRED;
}

function expectedSide(side: string): number {
  return side === 'buy' ? GPU_SIDE_BUY : GPU_SIDE_SELL;
}

export function auditGpuSweepParity(options: {
  readonly gpu: TypeGpuSweepOutput;
  readonly parameters: readonly ParameterPair[];
  readonly replayJournal?: boolean;
  readonly snapshots: readonly MarketSnapshot[];
}): readonly ParityDriftObservation[] {
  const worstByField = new Map<string, ParityDriftObservation>();
  const eventsByJob = indexGpuEventsByJob(options.gpu);

  function observe(
    field: string,
    gpu: number,
    cpu: number,
    jobIndex: number,
    sequence?: number,
  ): void {
    const absoluteError = Math.abs(gpu - cpu);
    const relativeError = absoluteError / Math.max(Math.abs(cpu), 1e-30);
    const observation: ParityDriftObservation = {
      field,
      gpu,
      cpu,
      jobIndex,
      sequence,
      absoluteError,
      relativeError,
      ulpDistance: f32UlpDistance(gpu, cpu),
    };
    const previous = worstByField.get(field);
    if (
      previous === undefined ||
      observation.relativeError > previous.relativeError
    ) {
      worstByField.set(field, observation);
    }
  }

  for (
    let seriesIndex = 0;
    seriesIndex < options.snapshots.length;
    seriesIndex++
  ) {
    for (
      let parameterIndex = 0;
      parameterIndex < options.parameters.length;
      parameterIndex++
    ) {
      const jobIndex = seriesIndex * options.parameters.length + parameterIndex;
      const summary = options.gpu.summaries[jobIndex];
      const gpuEvents = eventsByJob[jobIndex];
      if (!summary || !gpuEvents) {
        throw new Error(`Parity audit shape mismatch for job ${jobIndex}`);
      }
      const input = parseBacktestInput({
        snapshot: options.snapshots[seriesIndex],
        parameters: options.parameters[parameterIndex],
      });
      const cpu = options.replayJournal
        ? replayGpuBacktestJournal({input, events: gpuEvents, jobIndex})
        : runCpuBacktest(input);
      if (gpuEvents.length !== cpu.events.length) {
        throw new Error(
          `Parity audit event count mismatch for job ${jobIndex}`,
        );
      }

      observe(
        'summary.finalEquity',
        summary.finalEquity,
        cpu.summary.finalEquity,
        jobIndex,
      );
      observe(
        'summary.totalReturn',
        summary.totalReturn,
        cpu.summary.totalReturn,
        jobIndex,
      );
      observe(
        'summary.maxDrawdown',
        summary.maxDrawdown,
        cpu.summary.maxDrawdown,
        jobIndex,
      );
      observe(
        'summary.totalFees',
        summary.feesPaid,
        cpu.summary.totalFees,
        jobIndex,
      );

      for (let sequence = 0; sequence < cpu.events.length; sequence++) {
        const cpuEvent = cpu.events[sequence];
        const gpuEvent = gpuEvents[sequence];
        if (
          !cpuEvent ||
          !gpuEvent ||
          gpuEvent.sequence !== sequence ||
          gpuEvent.barIndex !== cpuEvent.barIndex ||
          gpuEvent.kind !== expectedKind(cpuEvent.type) ||
          gpuEvent.side !== expectedSide(cpuEvent.side)
        ) {
          throw new Error(
            `Parity audit discrete event mismatch for job ${jobIndex} sequence ${sequence}: ${JSON.stringify({cpuEvent, gpuEvent, previousCpuEvent: cpu.events[sequence - 1], previousGpuEvent: gpuEvents[sequence - 1]})}`,
          );
        }
        if (cpuEvent.type === 'order-filled') {
          observe(
            'event.fillPrice',
            gpuEvent.price,
            cpuEvent.fillPrice,
            jobIndex,
            sequence,
          );
          observe(
            'event.quantity',
            gpuEvent.quantity,
            cpuEvent.quantity,
            jobIndex,
            sequence,
          );
          observe('event.fee', gpuEvent.fee, cpuEvent.fee, jobIndex, sequence);
        }
      }
    }
  }

  return [...worstByField.values()].sort(
    (left, right) => right.relativeError - left.relativeError,
  );
}
