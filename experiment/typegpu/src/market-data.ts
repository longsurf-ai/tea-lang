// Purpose: Download, validate, normalize, and atomically persist deterministic Binance spot kline snapshots.

import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {z} from 'zod';

import {
  MarketBarSchema,
  MarketSnapshotSchema,
  type MarketBar,
  type MarketSnapshot,
} from './contracts';

const BINANCE_KLINES_ENDPOINT = 'https://data-api.binance.vision/api/v3/klines';
const BINANCE_PAGE_LIMIT = 1000;
const DEFAULT_DATA_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data',
);

const TimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const PositiveFiniteNumberStringSchema = z.string().transform((value, ctx) => {
  const parsed = Number(value);
  if (value.trim().length === 0 || !Number.isFinite(parsed) || parsed <= 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected a positive finite decimal string',
    });
    return z.NEVER;
  }
  return parsed;
});

const NonnegativeFiniteNumberStringSchema = z
  .string()
  .transform((value, ctx) => {
    const parsed = Number(value);
    if (value.trim().length === 0 || !Number.isFinite(parsed) || parsed < 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Expected a nonnegative finite decimal string',
      });
      return z.NEVER;
    }
    return parsed;
  });

const BinanceKlineSchema = z
  .tuple([
    TimestampSchema,
    PositiveFiniteNumberStringSchema,
    PositiveFiniteNumberStringSchema,
    PositiveFiniteNumberStringSchema,
    PositiveFiniteNumberStringSchema,
    NonnegativeFiniteNumberStringSchema,
    TimestampSchema,
    NonnegativeFiniteNumberStringSchema,
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    NonnegativeFiniteNumberStringSchema,
    NonnegativeFiniteNumberStringSchema,
    z.string(),
  ])
  .transform(values => ({
    openTimeMs: values[0],
    open: values[1],
    high: values[2],
    low: values[3],
    close: values[4],
    volume: values[5],
    closeTimeMs: values[6],
    tradeCount: values[8],
  }))
  .superRefine((bar, ctx) => {
    const isEmptySentinel =
      bar.closeTimeMs === bar.openTimeMs &&
      bar.volume === 0 &&
      bar.tradeCount === 0;
    if (
      bar.closeTimeMs < bar.openTimeMs ||
      (bar.closeTimeMs === bar.openTimeMs && !isEmptySentinel)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Kline close time must be later than its open time unless it is an empty Binance sentinel',
      });
    }
    if (bar.high < Math.max(bar.open, bar.close, bar.low)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Kline high must contain open, close, and low',
      });
    }
    if (bar.low > Math.min(bar.open, bar.close, bar.high)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Kline low must contain open, close, and high',
      });
    }
  });

const BinanceKlinePageSchema = z.array(BinanceKlineSchema);

const CanonicalBinanceSymbolSchema = z
  .string()
  .min(2)
  .max(30)
  .regex(/^[A-Z0-9]+$/);

const BinanceSymbolSchema = z
  .string()
  .trim()
  .transform(value => value.toUpperCase())
  .pipe(CanonicalBinanceSymbolSchema);

const BinanceIntervalSchema = z
  .string()
  .regex(/^[1-9][0-9]*[smhdwM]$/, 'Invalid Binance kline interval');

export const SnapshotManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotFile: z
      .string()
      .min(1)
      .refine(value => path.basename(value) === value),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    venue: z.literal('binance'),
    marketType: z.literal('spot'),
    symbol: CanonicalBinanceSymbolSchema,
    interval: BinanceIntervalSchema,
    fetchedAtMs: TimestampSchema,
    barCount: z.number().int().positive(),
    firstOpenTimeMs: TimestampSchema,
    lastCloseTimeMs: TimestampSchema,
  })
  .strict();

export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

type ParsedBinanceKline = z.infer<typeof BinanceKlineSchema>;

export interface NormalizeBinanceKlinesOptions {
  symbol: string;
  interval: string;
  nowMs: number;
}

export interface PersistMarketSnapshotOptions {
  directory?: string;
  fetchedAtMs: number;
}

export interface PersistedMarketSnapshot {
  snapshot: MarketSnapshot;
  manifest: SnapshotManifest;
  snapshotPath: string;
  manifestPath: string;
}

export type BinanceKlineFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DownloadBinanceMarketSnapshotOptions {
  symbol?: string;
  interval: string;
  directory?: string;
  nowMs?: number;
  fetcher?: BinanceKlineFetcher;
  signal?: AbortSignal;
}

function assertStrictChronology(bars: readonly ParsedBinanceKline[]): void {
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (previous === undefined || current === undefined) {
      throw new Error('Invariant violated: kline chronology index is missing');
    }
    if (current.openTimeMs <= previous.closeTimeMs) {
      throw new Error(
        `Binance klines overlap or are out of order at open time ${current.openTimeMs}`,
      );
    }
  }
}

function parseBinanceKlinePage(input: unknown): ParsedBinanceKline[] {
  const bars = BinanceKlinePageSchema.parse(input);
  assertStrictChronology(bars);
  return bars;
}

function createSnapshot(
  bars: readonly ParsedBinanceKline[],
  options: NormalizeBinanceKlinesOptions,
): MarketSnapshot {
  const symbol = BinanceSymbolSchema.parse(options.symbol);
  const interval = BinanceIntervalSchema.parse(options.interval);
  const nowMs = TimestampSchema.parse(options.nowMs);
  assertStrictChronology(bars);

  const completeBars: MarketBar[] = bars
    .filter(bar => bar.closeTimeMs > bar.openTimeMs && bar.closeTimeMs < nowMs)
    .map(bar =>
      MarketBarSchema.parse({
        openTimeMs: bar.openTimeMs,
        closeTimeMs: bar.closeTimeMs,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }),
    );

  return MarketSnapshotSchema.parse({
    schemaVersion: 1,
    venue: 'binance',
    marketType: 'spot',
    symbol,
    interval,
    bars: completeBars,
  });
}

export function normalizeBinanceKlines(
  input: unknown,
  options: NormalizeBinanceKlinesOptions,
): MarketSnapshot {
  return createSnapshot(parseBinanceKlinePage(input), options);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function snapshotStem(snapshot: MarketSnapshot): string {
  return `${snapshot.venue}-${snapshot.marketType}-${snapshot.symbol.toLowerCase()}-${snapshot.interval}`;
}

async function atomicWriteFile(file: string, contents: string): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, contents, {encoding: 'utf8', flag: 'wx'});
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, {force: true});
  }
}

export async function persistMarketSnapshot(
  input: MarketSnapshot,
  options: PersistMarketSnapshotOptions,
): Promise<PersistedMarketSnapshot> {
  const snapshot = MarketSnapshotSchema.parse(input);
  if (snapshot.bars.length === 0) {
    throw new Error('Cannot persist an empty market snapshot');
  }

  const fetchedAtMs = TimestampSchema.parse(options.fetchedAtMs);
  const directory = path.resolve(options.directory ?? DEFAULT_DATA_DIRECTORY);
  const stem = snapshotStem(snapshot);
  const snapshotFile = `${stem}.snapshot.json`;
  const manifestFile = `${stem}.manifest.json`;
  const snapshotPath = path.join(directory, snapshotFile);
  const manifestPath = path.join(directory, manifestFile);
  const snapshotJson = serializeJson(snapshot);
  const sha256 = createHash('sha256')
    .update(snapshotJson, 'utf8')
    .digest('hex');
  const first = snapshot.bars[0];
  const last = snapshot.bars.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error(
      'Invariant violated: nonempty snapshot has no boundary bars',
    );
  }

  const manifest = SnapshotManifestSchema.parse({
    schemaVersion: 1,
    snapshotFile,
    sha256,
    venue: snapshot.venue,
    marketType: snapshot.marketType,
    symbol: snapshot.symbol,
    interval: snapshot.interval,
    fetchedAtMs,
    barCount: snapshot.bars.length,
    firstOpenTimeMs: first.openTimeMs,
    lastCloseTimeMs: last.closeTimeMs,
  });

  await mkdir(directory, {recursive: true});
  await atomicWriteFile(snapshotPath, snapshotJson);
  await atomicWriteFile(manifestPath, serializeJson(manifest));

  return {snapshot, manifest, snapshotPath, manifestPath};
}

export async function loadPersistedMarketSnapshot(
  manifestFile: string,
): Promise<PersistedMarketSnapshot> {
  const manifestPath = path.resolve(manifestFile);
  const manifestJson = await readFile(manifestPath, 'utf8');
  const manifestInput: unknown = JSON.parse(manifestJson);
  const manifest = SnapshotManifestSchema.parse(manifestInput);
  const snapshotPath = path.join(
    path.dirname(manifestPath),
    manifest.snapshotFile,
  );
  const snapshotJson = await readFile(snapshotPath, 'utf8');
  const sha256 = createHash('sha256')
    .update(snapshotJson, 'utf8')
    .digest('hex');
  if (sha256 !== manifest.sha256) {
    throw new Error(
      `Snapshot SHA-256 mismatch: expected ${manifest.sha256}, received ${sha256}`,
    );
  }

  const snapshotInput: unknown = JSON.parse(snapshotJson);
  const snapshot = MarketSnapshotSchema.parse(snapshotInput);
  const expectedSnapshotFile = `${snapshotStem(snapshot)}.snapshot.json`;
  if (manifest.snapshotFile !== expectedSnapshotFile) {
    throw new Error(
      `Snapshot basename mismatch: expected ${expectedSnapshotFile}, received ${manifest.snapshotFile}`,
    );
  }
  if (
    manifest.venue !== snapshot.venue ||
    manifest.marketType !== snapshot.marketType ||
    manifest.symbol !== snapshot.symbol ||
    manifest.interval !== snapshot.interval
  ) {
    throw new Error('Snapshot identity does not match its manifest');
  }
  if (manifest.barCount !== snapshot.bars.length) {
    throw new Error(
      `Snapshot bar count mismatch: expected ${manifest.barCount}, received ${snapshot.bars.length}`,
    );
  }

  const first = snapshot.bars[0];
  const last = snapshot.bars.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('Invariant violated: parsed snapshot has no boundary bars');
  }
  if (
    manifest.firstOpenTimeMs !== first.openTimeMs ||
    manifest.lastCloseTimeMs !== last.closeTimeMs
  ) {
    throw new Error('Snapshot time boundaries do not match its manifest');
  }

  return {snapshot, manifest, snapshotPath, manifestPath};
}

export async function downloadBinanceMarketSnapshot(
  options: DownloadBinanceMarketSnapshotOptions,
): Promise<PersistedMarketSnapshot> {
  const symbol = BinanceSymbolSchema.parse(options.symbol ?? 'BTCUSDT');
  const interval = BinanceIntervalSchema.parse(options.interval);
  const nowMs = TimestampSchema.parse(options.nowMs ?? Date.now());
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (fetcher === undefined) {
    throw new Error('No Fetch implementation is available');
  }

  const bars: ParsedBinanceKline[] = [];
  let startTime = 0;

  for (;;) {
    const url = new URL(BINANCE_KLINES_ENDPOINT);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(startTime));
    url.searchParams.set('limit', String(BINANCE_PAGE_LIMIT));

    const response = await fetcher(url, {signal: options.signal});
    if (!response.ok) {
      throw new Error(
        `Binance kline request failed with HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body: unknown = await response.json();
    const page = parseBinanceKlinePage(body);
    if (page.length === 0) break;

    const first = page[0];
    const last = page.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error(
        'Invariant violated: nonempty Binance page has no boundaries',
      );
    }
    if (first.openTimeMs < startTime) {
      throw new Error(
        `Binance page began before requested start time ${startTime}`,
      );
    }

    const previous = bars.at(-1);
    if (previous !== undefined && first.openTimeMs <= previous.closeTimeMs) {
      throw new Error(`Binance pages overlap at open time ${first.openTimeMs}`);
    }
    bars.push(...page);

    if (page.some(bar => bar.closeTimeMs >= nowMs)) break;

    const nextStartTime = last.closeTimeMs + 1;
    if (!Number.isSafeInteger(nextStartTime) || nextStartTime <= startTime) {
      throw new Error('Binance pagination cursor did not advance safely');
    }
    startTime = nextStartTime;
  }

  const snapshot = createSnapshot(bars, {symbol, interval, nowMs});
  return persistMarketSnapshot(snapshot, {
    directory: options.directory,
    fetchedAtMs: nowMs,
  });
}
