// Purpose: Expose isolated download, sweep, artifact, benchmark, and capability commands for Node.

import path from 'node:path';

import {writeReconciledArtifacts} from './artifacts';
import {parseBacktestInput} from './backtest-contract';
import {runCpuBacktest} from './cpu-backtest';
import {
  buildCpuBacktestInputs,
  loadExperimentInput,
  runCpuBacktestSweep,
  runLoadedTypeGpuExperiment,
  worstCaseEventCapacity,
  type LoadedExperimentInput,
} from './experiment';
import {
  downloadBinanceMarketSnapshot,
  type SnapshotManifest,
} from './market-data';
import {
  createNodeGpuProvider,
  type NodeGpuProviderOptions,
} from './node-gpu';
import {
  assertGpuJobMatchesCpu,
  assertGpuSweepShape,
  indexGpuEventsByJob,
} from './parity';
import {auditGpuSweepParity} from './parity-audit';
import {
  DEFAULT_PARAMETER_GRID,
  parseInclusiveIntegerRange,
  type ParameterGridDefinition,
} from './parameter-grid';
import {runTypeGpuCapabilitySmoke} from './typegpu-capability';
import {
  GPU_EVENT_BYTE_LENGTH,
  GpuJournalOverflowError,
  runTypeGpuSweep,
  type TypeGpuSweepOutput,
} from './typegpu-engine';

// Every command reports through this single writer so human-facing CLI output
// is always indented JSON; compact JSON.stringify stays reserved for error
// message payloads.
function printResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface CliOptions {
  readonly values: ReadonlyMap<string, string>;
}

function parseCliOptions(
  args: readonly string[],
  allowed: readonly string[],
): CliOptions {
  const allowedOptions = new Set(allowed);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('CLI options must use --name value pairs');
    }
    const key = name.slice(2);
    if (!allowedOptions.has(key)) {
      throw new Error(`Unknown option --${key}`);
    }
    if (values.has(key)) {
      throw new Error(`Option --${key} was provided more than once`);
    }
    values.set(key, value);
  }
  return {values};
}

function option(options: CliOptions, name: string, fallback: string): string {
  return options.values.get(name) ?? fallback;
}

function positiveIntegerOption(
  options: CliOptions,
  name: string,
  fallback: number,
): number {
  const value = Number(option(options, name, String(fallback)));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive safe integer`);
  }
  return value;
}

function commaSeparatedOption(
  options: CliOptions,
  name: string,
  fallback: string,
): string[] {
  const values = option(options, name, fallback)
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
  if (values.length === 0) {
    throw new Error(`--${name} must contain at least one value`);
  }
  return values;
}

function gridFromOptions(options: CliOptions): ParameterGridDefinition {
  return {
    fast: options.values.has('fast')
      ? parseInclusiveIntegerRange(option(options, 'fast', ''), 'fast')
      : DEFAULT_PARAMETER_GRID.fast,
    slow: options.values.has('slow')
      ? parseInclusiveIntegerRange(option(options, 'slow', ''), 'slow')
      : DEFAULT_PARAMETER_GRID.slow,
  };
}

function defaultManifestPaths(): string[] {
  return ['1d', '1h'].map(interval =>
    path.resolve(
      process.cwd(),
      'data',
      `binance-spot-btcusdt-${interval}.manifest.json`,
    ),
  );
}

function manifestPathsFromOptions(options: CliOptions): string[] {
  const configured = options.values.get('manifests');
  if (configured === undefined) return defaultManifestPaths();
  return commaSeparatedOption(options, 'manifests', '').map(manifestPath =>
    path.resolve(manifestPath),
  );
}

async function withNodeGpu<T>(
  operation: (device: GPUDevice) => Promise<T>,
  providerOptions?: NodeGpuProviderOptions,
): Promise<T> {
  const provider = await createNodeGpuProvider(providerOptions);
  try {
    return await operation(provider.device);
  } finally {
    provider.destroy();
  }
}

// Default capacity assumes every job hits its worst-case event output, so no
// run can overflow without the strategy contract itself changing. An explicit
// --event-capacity is a bet on sparser output for grids whose worst case
// exceeds device limits; the overflow guard still hard-fails a lost bet.
function resolveEventCapacity(
  options: CliOptions,
  input: LoadedExperimentInput,
): number {
  if (options.values.has('event-capacity')) {
    return positiveIntegerOption(options, 'event-capacity', 0);
  }
  return worstCaseEventCapacity(input);
}

async function loadConfiguredExperiment(
  options: CliOptions,
): Promise<LoadedExperimentInput> {
  return loadExperimentInput({
    manifestPaths: manifestPathsFromOptions(options),
    grid: gridFromOptions(options),
  });
}

async function executeConfiguredSweep(options: CliOptions): Promise<{
  readonly gpu: TypeGpuSweepOutput;
  readonly input: LoadedExperimentInput;
}> {
  const input = await loadConfiguredExperiment(options);
  const eventCapacity = resolveEventCapacity(options, input);
  const gpu = await withNodeGpu(
    device => runLoadedTypeGpuExperiment({device, input, eventCapacity}),
    {minStorageBindingBytes: eventCapacity * GPU_EVENT_BYTE_LENGTH},
  );
  assertGpuSweepShape(gpu);
  return {input, gpu};
}

async function runCapabilitySmoke(): Promise<void> {
  const result = await withNodeGpu(runTypeGpuCapabilitySmoke);
  const sums = result.summaries.map(summary => summary.sum);
  const counts = result.summaries.map(summary => summary.eventCount);
  const orderedEvents = [...result.events].sort(
    (left, right) =>
      left.jobIndex - right.jobIndex || left.sequence - right.sequence,
  );

  if (JSON.stringify(sums) !== JSON.stringify([6, 6, 15, 15])) {
    throw new Error(`Unexpected capability sums: ${JSON.stringify(sums)}`);
  }
  if (JSON.stringify(counts) !== JSON.stringify([1, 0, 3, 2])) {
    throw new Error(
      `Unexpected capability event counts: ${JSON.stringify(counts)}`,
    );
  }
  if (result.journal.cursor !== 6 || result.journal.overflow !== 0) {
    throw new Error(
      `Unexpected journal state: ${JSON.stringify(result.journal)}`,
    );
  }

  printResult({
    status: 'ok',
    summaries: result.summaries,
    events: orderedEvents,
    journal: result.journal,
  });
}

async function runParitySmoke(options: CliOptions): Promise<void> {
  const prices = [10, 9, 8, 9, 10, 11, 10, 9, 8, 9, 10];
  const parameters = {fastPeriod: 2, slowPeriod: 3};
  const snapshot = {
    schemaVersion: 1 as const,
    venue: 'binance' as const,
    marketType: 'spot' as const,
    symbol: 'BTCUSDT',
    interval: '1h' as const,
    bars: prices.map((price, index) => ({
      openTimeMs: index * 3_600_000,
      closeTimeMs: (index + 1) * 3_600_000 - 1,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1,
    })),
  };
  const cpu = runCpuBacktest(parseBacktestInput({snapshot, parameters}));
  const gpu = await withNodeGpu(device =>
    runTypeGpuSweep(device, {
      series: [{seriesId: 'fixture', opens: prices, closes: prices}],
      parameters: [parameters],
      settings: {
        initialCash: 100_000,
        slippageRate: 0.0001,
        feeRate: 0.0001,
      },
      eventCapacity: 16,
    }),
  );
  assertGpuSweepShape(gpu);
  const eventsByJob = indexGpuEventsByJob(gpu);
  assertGpuJobMatchesCpu({
    cpu,
    summary: gpu.summaries[0],
    events: eventsByJob[0],
    jobIndex: 0,
    seriesIndex: 0,
    parameterIndex: 0,
  });

  let artifactOutput: string | undefined;
  const requestedOutput = options.values.get('output');
  if (requestedOutput !== undefined) {
    const snapshotManifest: SnapshotManifest = {
      schemaVersion: 1,
      snapshotFile: 'fixture.snapshot.json',
      sha256: '0'.repeat(64),
      venue: snapshot.venue,
      marketType: snapshot.marketType,
      symbol: snapshot.symbol,
      interval: snapshot.interval,
      fetchedAtMs: snapshot.bars.at(-1)?.closeTimeMs ?? 0,
      barCount: snapshot.bars.length,
      firstOpenTimeMs: snapshot.bars[0]?.openTimeMs ?? 0,
      lastCloseTimeMs: snapshot.bars.at(-1)?.closeTimeMs ?? 0,
    };
    const artifacts = await writeReconciledArtifacts({
      gpu: {...gpu, seriesIds: ['binance:spot:BTCUSDT:1h']},
      outputDirectory: requestedOutput,
      snapshots: [snapshot],
      snapshotManifests: [snapshotManifest],
      parameters: [parameters],
    });
    artifactOutput = artifacts.outputDirectory;
  }

  printResult({
    status: 'ok',
    summary: gpu.summaries[0],
    events: gpu.events,
    artifactOutput,
  });
}

async function runOverflowSmoke(): Promise<void> {
  try {
    await withNodeGpu(device =>
      runTypeGpuSweep(device, {
        series: [
          {
            seriesId: 'overflow-fixture',
            opens: [10, 9, 8, 9, 10, 11, 10, 9, 8, 9, 10],
            closes: [10, 9, 8, 9, 10, 11, 10, 9, 8, 9, 10],
          },
        ],
        parameters: [{fastPeriod: 2, slowPeriod: 3}],
        settings: {
          initialCash: 100_000,
          slippageRate: 0.0001,
          feeRate: 0.0001,
        },
        eventCapacity: 1,
      }),
    );
  } catch (error) {
    if (error instanceof GpuJournalOverflowError) {
      printResult({
        status: 'ok',
        attemptedEventCount: error.attemptedEventCount,
        eventCapacity: error.eventCapacity,
      });
      return;
    }
    throw error;
  }
  throw new Error('Overflow smoke unexpectedly completed without overflow');
}

async function runDownload(options: CliOptions): Promise<void> {
  const symbol = option(options, 'symbol', 'BTCUSDT');
  const intervals = commaSeparatedOption(options, 'intervals', '1d,1h');
  const directory = path.resolve(
    option(options, 'data-dir', path.resolve(process.cwd(), 'data')),
  );
  const persisted = [];
  for (const interval of intervals) {
    persisted.push(
      await downloadBinanceMarketSnapshot({symbol, interval, directory}),
    );
  }
  printResult({
    status: 'ok',
    snapshots: persisted.map(result => ({
      manifestPath: result.manifestPath,
      snapshotPath: result.snapshotPath,
      manifest: result.manifest,
    })),
  });
}

async function runSweep(options: CliOptions): Promise<void> {
  const {input, gpu} = await executeConfiguredSweep(options);
  const best = [...gpu.summaries]
    .filter(summary => summary.status === 1)
    .sort((left, right) => right.totalReturn - left.totalReturn)
    .slice(0, 10)
    .map(summary => ({
      seriesId: gpu.seriesIds[summary.seriesIndex],
      parameters: gpu.parameters[summary.parameterIndex],
      finalEquity: summary.finalEquity,
      totalReturn: summary.totalReturn,
      maxDrawdown: summary.maxDrawdown,
      orderCount: summary.orderCount,
    }));
  printResult({
    status: 'ok',
    seriesCount: input.snapshots.length,
    parameterCount: input.parameters.length,
    jobCount: gpu.summaries.length,
    eventCount: gpu.events.length,
    eventCapacity: gpu.eventCapacity,
    dispatchCount: gpu.dispatchCount,
    timings: gpu.timings,
    best,
  });
}

async function runArtifacts(options: CliOptions): Promise<void> {
  const {input, gpu} = await executeConfiguredSweep(options);
  const defaultOutput = path.resolve(
    process.cwd(),
    'results',
    `run-${new Date().toISOString().replaceAll(':', '-')}`,
  );
  const outputDirectory = path.resolve(
    option(options, 'output', defaultOutput),
  );
  const result = await writeReconciledArtifacts({
    gpu,
    outputDirectory,
    snapshots: input.snapshots,
    snapshotManifests: input.persistedSnapshots.map(
      persisted => persisted.manifest,
    ),
    parameters: input.parameters,
  });
  printResult({
    status: 'ok',
    outputDirectory: result.outputDirectory,
    manifestPath: result.manifestPath,
    manifest: result.manifest,
  });
}

async function runParityAudit(options: CliOptions): Promise<void> {
  const {input, gpu} = await executeConfiguredSweep(options);
  printResult({
    status: 'ok',
    jobCount: gpu.summaries.length,
    worstByField: auditGpuSweepParity({
      gpu,
      snapshots: input.snapshots,
      parameters: input.parameters,
      replayJournal: true,
    }),
  });
}

type BenchmarkEngine = 'cpu' | 'gpu';

function engineFromOptions(options: CliOptions): BenchmarkEngine {
  const engine = option(options, 'engine', 'gpu');
  if (engine !== 'cpu' && engine !== 'gpu') {
    throw new Error(`--engine must be "cpu" or "gpu", received "${engine}"`);
  }
  return engine;
}

async function runBenchmark(options: CliOptions): Promise<void> {
  const engine = engineFromOptions(options);
  const input = await loadConfiguredExperiment(options);
  const iterations = positiveIntegerOption(options, 'iterations', 3);
  const shared = {
    status: 'ok',
    engine,
    iterations,
    seriesCount: input.snapshots.length,
    parameterCount: input.parameters.length,
    jobCount: input.snapshots.length * input.parameters.length,
    totalBarSteps: input.snapshots.reduce(
      (total, snapshot) =>
        total + snapshot.bars.length * input.parameters.length,
      0,
    ),
  };

  if (engine === 'cpu') {
    if (options.values.has('event-capacity')) {
      throw new Error('--event-capacity only applies to --engine gpu');
    }
    const cpuInputs = buildCpuBacktestInputs(input);
    const runs = [];
    for (let iteration = 0; iteration < iterations; iteration++) {
      runs.push(runCpuBacktestSweep(cpuInputs));
    }
    printResult({...shared, runs});
    return;
  }

  const eventCapacity = resolveEventCapacity(options, input);
  const runs = await withNodeGpu(
    async device => {
      const outputs: TypeGpuSweepOutput[] = [];
      for (let iteration = 0; iteration < iterations; iteration++) {
        const output = await runLoadedTypeGpuExperiment({
          device,
          input,
          eventCapacity,
        });
        assertGpuSweepShape(output);
        outputs.push(output);
      }
      return outputs;
    },
    {minStorageBindingBytes: eventCapacity * GPU_EVENT_BYTE_LENGTH},
  );
  printResult({
    ...shared,
    eventCapacity,
    journalBytes: eventCapacity * GPU_EVENT_BYTE_LENGTH,
    runs: runs.map(run => ({
      eventCount: run.events.length,
      timings: run.timings,
    })),
  });
}

const command = process.argv[2];
const args = process.argv.slice(3);
if (command === 'capability-smoke') {
  parseCliOptions(args, []);
  await runCapabilitySmoke();
} else if (command === 'parity-smoke') {
  await runParitySmoke(parseCliOptions(args, ['output']));
} else if (command === 'overflow-smoke') {
  parseCliOptions(args, []);
  await runOverflowSmoke();
} else if (command === 'download') {
  await runDownload(parseCliOptions(args, ['symbol', 'intervals', 'data-dir']));
} else if (command === 'sweep') {
  await runSweep(
    parseCliOptions(args, ['manifests', 'fast', 'slow', 'event-capacity']),
  );
} else if (command === 'artifacts') {
  await runArtifacts(
    parseCliOptions(args, [
      'manifests',
      'fast',
      'slow',
      'event-capacity',
      'output',
    ]),
  );
} else if (command === 'parity-audit') {
  await runParityAudit(
    parseCliOptions(args, ['manifests', 'fast', 'slow', 'event-capacity']),
  );
} else if (command === 'benchmark') {
  await runBenchmark(
    parseCliOptions(args, [
      'manifests',
      'fast',
      'slow',
      'event-capacity',
      'iterations',
      'engine',
    ]),
  );
} else {
  throw new Error(`Unknown experiment command: ${command ?? '<missing>'}`);
}
