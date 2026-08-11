// Purpose: Compose verified snapshots, parameter grids, and the CPU and Node-injected TypeGPU sweep boundaries.

import {
  BACKTEST_SETTINGS,
  parseBacktestInput,
  type BacktestInput,
} from './backtest-contract';
import type {MarketSnapshot, ParameterPair} from './contracts';
import {runCpuBacktest} from './cpu-backtest';
import {
  loadPersistedMarketSnapshot,
  type PersistedMarketSnapshot,
} from './market-data';
import {
  createParameterGrid,
  type ParameterGridDefinition,
} from './parameter-grid';
import {runTypeGpuSweep, type TypeGpuSweepOutput} from './typegpu-engine';

export interface LoadedExperimentInput {
  readonly parameters: readonly ParameterPair[];
  readonly persistedSnapshots: readonly PersistedMarketSnapshot[];
  readonly snapshots: readonly MarketSnapshot[];
}

export function marketSeriesId(snapshot: MarketSnapshot): string {
  return [
    snapshot.venue,
    snapshot.marketType,
    snapshot.symbol,
    snapshot.interval,
  ].join(':');
}

export async function loadExperimentInput(options: {
  readonly grid: ParameterGridDefinition;
  readonly manifestPaths: readonly string[];
}): Promise<LoadedExperimentInput> {
  if (options.manifestPaths.length === 0) {
    throw new Error('At least one snapshot manifest is required');
  }
  const persistedSnapshots = await Promise.all(
    options.manifestPaths.map(manifestPath =>
      loadPersistedMarketSnapshot(manifestPath),
    ),
  );
  const snapshots = persistedSnapshots.map(persisted => persisted.snapshot);
  const parameters = createParameterGrid(options.grid);
  return {persistedSnapshots, snapshots, parameters};
}

// @agent invariant: the SMA crossover simulator can submit at most one order
// per signal-capable bar (indexes slowPeriod..barCount-1, alternating sides),
// and every submitted order emits exactly one fill or expiry event. Worst-case
// journal usage per valid job is therefore 2 × (barCount - slowPeriod) events;
// invalid jobs emit none. If the kernel's event emission changes, this bound
// must change with it.
export function worstCaseEventCapacity(input: {
  readonly parameters: readonly ParameterPair[];
  readonly snapshots: readonly MarketSnapshot[];
}): number {
  let total = 0;
  for (const snapshot of input.snapshots) {
    for (const parameters of input.parameters) {
      total += 2 * Math.max(0, snapshot.bars.length - parameters.slowPeriod);
    }
  }
  return Math.max(1, total);
}

// @agent invariant: CPU sweep jobs use the same ordering as GPU jobs —
// jobIndex = seriesIndex * parameterCount + parameterIndex — so benchmark and
// parity surfaces always agree on job identity.
export function buildCpuBacktestInputs(input: {
  readonly parameters: readonly ParameterPair[];
  readonly snapshots: readonly MarketSnapshot[];
}): readonly BacktestInput[] {
  const inputs: BacktestInput[] = [];
  for (const snapshot of input.snapshots) {
    for (const parameters of input.parameters) {
      inputs.push(parseBacktestInput({snapshot, parameters}));
    }
  }
  return inputs;
}

export interface CpuSweepRun {
  readonly elapsedMs: number;
  readonly equityPointCount: number;
  readonly eventCount: number;
}

// Runs every job sequentially on one thread and reports its own wall time so
// the CLI benchmark can compare it directly against GPU sweep timings. Inputs
// must be parsed beforehand (buildCpuBacktestInputs) so boundary parsing never
// pollutes the measured simulation time.
export function runCpuBacktestSweep(
  inputs: readonly BacktestInput[],
): CpuSweepRun {
  const startedAt = performance.now();
  let eventCount = 0;
  let equityPointCount = 0;
  for (const input of inputs) {
    const result = runCpuBacktest(input);
    eventCount += result.events.length;
    equityPointCount += result.equityCurve.length;
  }
  return {
    elapsedMs: performance.now() - startedAt,
    equityPointCount,
    eventCount,
  };
}

export async function runLoadedTypeGpuExperiment(options: {
  readonly device: GPUDevice;
  readonly eventCapacity: number;
  readonly input: LoadedExperimentInput;
}): Promise<TypeGpuSweepOutput> {
  return runTypeGpuSweep(options.device, {
    series: options.input.snapshots.map(snapshot => ({
      seriesId: marketSeriesId(snapshot),
      opens: snapshot.bars.map(bar => bar.open),
      closes: snapshot.bars.map(bar => bar.close),
    })),
    parameters: options.input.parameters,
    settings: {
      initialCash: BACKTEST_SETTINGS.initialCash,
      slippageRate: BACKTEST_SETTINGS.adverseSlippageRate,
      feeRate: BACKTEST_SETTINGS.takerFeeRate,
    },
    eventCapacity: options.eventCapacity,
  });
}
