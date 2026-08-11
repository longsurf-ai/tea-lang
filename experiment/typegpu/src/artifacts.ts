// Purpose: Stream only CPU/GPU-reconciled summaries, journals, trades, and full equity curves to disk.

import {randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {
  access,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';

import {
  BACKTEST_SETTINGS,
  parseBacktestInput,
  type CpuBacktestResult,
} from './backtest-contract';
import type {MarketSnapshot, ParameterPair} from './contracts';
import {replayGpuBacktestJournal} from './journal-replay';
import type {SnapshotManifest} from './market-data';
import {
  assertGpuJobMatchesCpu,
  assertGpuSweepShape,
  indexGpuEventsByJob,
} from './parity';
import type {TypeGpuSweepOutput} from './typegpu-engine';

const ARTIFACT_SCHEMA_VERSION = 1;

export interface ReconciledArtifactInput {
  readonly gpu: TypeGpuSweepOutput;
  readonly outputDirectory: string;
  readonly parameters: readonly ParameterPair[];
  readonly snapshotManifests: readonly SnapshotManifest[];
  readonly snapshots: readonly MarketSnapshot[];
}

export interface ArtifactFileDescription {
  readonly byteLength: number;
  readonly encoding: string;
  readonly file: string;
  readonly rowCount?: number;
}

export interface ReconciledArtifactManifest {
  readonly complete: true;
  readonly createdAtMs: number;
  readonly equityLayout: {
    readonly dataType: 'f32-le';
    readonly ordering: 'job-major-then-bar';
  };
  readonly files: {
    readonly equity: ArtifactFileDescription;
    readonly equityIndex: ArtifactFileDescription;
    readonly fills: ArtifactFileDescription;
    readonly gpuEvents: ArtifactFileDescription;
    readonly orders: ArtifactFileDescription;
    readonly roundTrips: ArtifactFileDescription;
    readonly summaries: ArtifactFileDescription;
  };
  readonly gpu: {
    readonly computeSubmissionCount: number;
    readonly dispatchCount: number;
    readonly eventCapacity: number;
    readonly eventCount: number;
    readonly readbackSubmissionCount: number;
    readonly timings: TypeGpuSweepOutput['timings'];
  };
  readonly jobCount: number;
  readonly parameterCount: number;
  readonly schemaVersion: 1;
  readonly series: readonly {
    readonly barCount: number;
    readonly interval: string;
    readonly marketType: string;
    readonly sha256: string;
    readonly symbol: string;
    readonly venue: string;
  }[];
  readonly seriesCount: number;
  readonly settings: typeof BACKTEST_SETTINGS;
}

class NdjsonArtifactWriter {
  #byteLength = 0;
  #closed = false;
  #rowCount = 0;

  private constructor(
    private readonly fileHandle: FileHandle,
    readonly filename: string,
  ) {}

  static async create(
    directory: string,
    filename: string,
  ): Promise<NdjsonArtifactWriter> {
    return new NdjsonArtifactWriter(
      await open(path.join(directory, filename), 'wx'),
      filename,
    );
  }

  get description(): ArtifactFileDescription {
    if (!this.#closed) {
      throw new Error(`Artifact writer ${this.filename} must close before use`);
    }
    return {
      file: this.filename,
      encoding: 'ndjson-utf8',
      byteLength: this.#byteLength,
      rowCount: this.#rowCount,
    };
  }

  async write(value: unknown): Promise<void> {
    if (this.#closed) {
      throw new Error(`Artifact writer ${this.filename} is already closed`);
    }
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    await writeBufferFully(this.fileHandle, bytes, this.#byteLength);
    this.#byteLength += bytes.byteLength;
    this.#rowCount++;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.fileHandle.close();
  }
}

async function writeBufferFully(
  fileHandle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < buffer.byteLength) {
    const result = await fileHandle.write(
      buffer,
      written,
      buffer.byteLength - written,
      position + written,
    );
    if (result.bytesWritten <= 0) {
      throw new Error('Artifact file write made no progress');
    }
    written += result.bytesWritten;
  }
}

function marketSeriesId(snapshot: MarketSnapshot): string {
  return [
    snapshot.venue,
    snapshot.marketType,
    snapshot.symbol,
    snapshot.interval,
  ].join(':');
}

function encodeEquityCurve(result: CpuBacktestResult): Buffer {
  const bytes = new ArrayBuffer(result.equityCurve.length * 4);
  const view = new DataView(bytes);
  for (let index = 0; index < result.equityCurve.length; index++) {
    view.setFloat32(index * 4, result.equityCurve[index].equity, true);
  }
  return Buffer.from(bytes);
}

async function assertOutputDoesNotExist(
  outputDirectory: string,
): Promise<void> {
  try {
    await access(outputDirectory, fsConstants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Artifact output already exists: ${outputDirectory}`);
}

function assertInputIdentity(input: ReconciledArtifactInput): void {
  if (input.snapshots.length !== input.snapshotManifests.length) {
    throw new Error('Every snapshot must have exactly one verified manifest');
  }
  if (input.gpu.seriesIds.length !== input.snapshots.length) {
    throw new Error('GPU series identities do not match artifact snapshots');
  }
  if (input.gpu.parameters.length !== input.parameters.length) {
    throw new Error(
      'GPU parameter identities do not match artifact parameters',
    );
  }

  for (let index = 0; index < input.snapshots.length; index++) {
    const snapshot = input.snapshots[index];
    const manifest = input.snapshotManifests[index];
    if (input.gpu.seriesIds[index] !== marketSeriesId(snapshot)) {
      throw new Error(
        `GPU series identity ${index} does not match its snapshot`,
      );
    }
    if (
      manifest.venue !== snapshot.venue ||
      manifest.marketType !== snapshot.marketType ||
      manifest.symbol !== snapshot.symbol ||
      manifest.interval !== snapshot.interval
    ) {
      throw new Error(`Snapshot manifest identity ${index} does not match`);
    }
  }

  for (let index = 0; index < input.parameters.length; index++) {
    const expected = input.parameters[index];
    const actual = input.gpu.parameters[index];
    if (
      actual.fastPeriod !== expected.fastPeriod ||
      actual.slowPeriod !== expected.slowPeriod
    ) {
      throw new Error(`GPU parameter identity ${index} does not match`);
    }
  }
}

export async function writeReconciledArtifacts(
  input: ReconciledArtifactInput,
): Promise<{
  readonly manifest: ReconciledArtifactManifest;
  readonly manifestPath: string;
  readonly outputDirectory: string;
}> {
  assertGpuSweepShape(input.gpu);
  assertInputIdentity(input);

  const outputDirectory = path.resolve(input.outputDirectory);
  await assertOutputDoesNotExist(outputDirectory);
  await mkdir(path.dirname(outputDirectory), {recursive: true});
  const temporaryDirectory = path.join(
    path.dirname(outputDirectory),
    `.${path.basename(outputDirectory)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(temporaryDirectory);

  const summaries = await NdjsonArtifactWriter.create(
    temporaryDirectory,
    'summaries.ndjson',
  );
  const gpuEvents = await NdjsonArtifactWriter.create(
    temporaryDirectory,
    'gpu-events.ndjson',
  );
  const orders = await NdjsonArtifactWriter.create(
    temporaryDirectory,
    'orders.ndjson',
  );
  const fills = await NdjsonArtifactWriter.create(
    temporaryDirectory,
    'fills.ndjson',
  );
  const roundTrips = await NdjsonArtifactWriter.create(
    temporaryDirectory,
    'round-trips.ndjson',
  );
  const equityIndex = await NdjsonArtifactWriter.create(
    temporaryDirectory,
    'equity-index.ndjson',
  );
  const writers = [
    summaries,
    gpuEvents,
    orders,
    fills,
    roundTrips,
    equityIndex,
  ];
  const equityFilename = 'equity.f32le';
  const equityFile = await open(
    path.join(temporaryDirectory, equityFilename),
    'wx',
  );
  let equityByteLength = 0;
  let succeeded = false;

  try {
    const eventsByJob = indexGpuEventsByJob(input.gpu);
    for (
      let seriesIndex = 0;
      seriesIndex < input.snapshots.length;
      seriesIndex++
    ) {
      const snapshot = input.snapshots[seriesIndex];
      for (
        let parameterIndex = 0;
        parameterIndex < input.parameters.length;
        parameterIndex++
      ) {
        const parameters = input.parameters[parameterIndex];
        const jobIndex = seriesIndex * input.parameters.length + parameterIndex;
        const gpuSummary = input.gpu.summaries[jobIndex];
        const jobGpuEvents = eventsByJob[jobIndex];
        if (!gpuSummary || !jobGpuEvents) {
          throw new Error(`GPU output is missing job ${jobIndex}`);
        }
        const cpu = replayGpuBacktestJournal({
          input: parseBacktestInput({snapshot, parameters}),
          events: jobGpuEvents,
          jobIndex,
        });
        assertGpuJobMatchesCpu({
          cpu,
          summary: gpuSummary,
          events: jobGpuEvents,
          jobIndex,
          seriesIndex,
          parameterIndex,
        });

        await summaries.write({
          jobIndex,
          seriesIndex,
          parameterIndex,
          identity: cpu.identity,
          cpu: cpu.summary,
          gpu: gpuSummary,
        });
        for (const event of jobGpuEvents) {
          await gpuEvents.write(event);
        }
        for (const order of cpu.orders) {
          await orders.write({jobIndex, jobId: cpu.identity.jobId, ...order});
        }
        for (const fill of cpu.fills) {
          await fills.write({jobIndex, jobId: cpu.identity.jobId, ...fill});
        }
        for (const roundTrip of cpu.roundTrips) {
          await roundTrips.write({
            jobIndex,
            jobId: cpu.identity.jobId,
            ...roundTrip,
          });
        }

        const equity = encodeEquityCurve(cpu);
        await writeBufferFully(equityFile, equity, equityByteLength);
        await equityIndex.write({
          jobIndex,
          jobId: cpu.identity.jobId,
          seriesIndex,
          parameterIndex,
          byteOffset: equityByteLength,
          byteLength: equity.byteLength,
          pointCount: cpu.equityCurve.length,
        });
        equityByteLength += equity.byteLength;
      }
    }

    await Promise.all(writers.map(writer => writer.close()));
    await equityFile.close();

    const manifest: ReconciledArtifactManifest = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      complete: true,
      createdAtMs: Date.now(),
      seriesCount: input.snapshots.length,
      parameterCount: input.parameters.length,
      jobCount: input.snapshots.length * input.parameters.length,
      series: input.snapshots.map((snapshot, index) => ({
        venue: snapshot.venue,
        marketType: snapshot.marketType,
        symbol: snapshot.symbol,
        interval: snapshot.interval,
        barCount: snapshot.bars.length,
        sha256: input.snapshotManifests[index].sha256,
      })),
      settings: BACKTEST_SETTINGS,
      gpu: {
        dispatchCount: input.gpu.dispatchCount,
        computeSubmissionCount: input.gpu.computeSubmissionCount,
        readbackSubmissionCount: input.gpu.readbackSubmissionCount,
        eventCount: input.gpu.events.length,
        eventCapacity: input.gpu.eventCapacity,
        timings: input.gpu.timings,
      },
      equityLayout: {
        dataType: 'f32-le',
        ordering: 'job-major-then-bar',
      },
      files: {
        summaries: summaries.description,
        gpuEvents: gpuEvents.description,
        orders: orders.description,
        fills: fills.description,
        roundTrips: roundTrips.description,
        equityIndex: equityIndex.description,
        equity: {
          file: equityFilename,
          encoding: 'f32-little-endian',
          byteLength: equityByteLength,
        },
      },
    };
    const manifestFilename = 'manifest.json';
    await writeFile(
      path.join(temporaryDirectory, manifestFilename),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {encoding: 'utf8', flag: 'wx'},
    );
    await rename(temporaryDirectory, outputDirectory);
    succeeded = true;
    return {
      manifest,
      manifestPath: path.join(outputDirectory, manifestFilename),
      outputDirectory,
    };
  } finally {
    if (!succeeded) {
      await Promise.allSettled(writers.map(writer => writer.close()));
      await equityFile.close().catch(() => undefined);
      await rm(temporaryDirectory, {recursive: true, force: true});
    }
  }
}
