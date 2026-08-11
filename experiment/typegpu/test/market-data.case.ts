// Purpose: Verify Binance kline normalization, pagination, validation, and content-addressed persistence without network access.

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {MarketSnapshotSchema} from '../src/contracts';
import {
  type BinanceKlineFetcher,
  downloadBinanceMarketSnapshot,
  loadPersistedMarketSnapshot,
  normalizeBinanceKlines,
  SnapshotManifestSchema,
} from '../src/market-data';

const RawRowsSchema = z.array(z.array(z.unknown()));
const FIXED_NOW_MS = 1704370000000;

async function loadRawFixture(): Promise<unknown[][]> {
  const json = await readFile(
    new URL('./fixtures/btcusdt-1d-klines.json', import.meta.url),
    'utf8',
  );
  const input: unknown = JSON.parse(json);
  return RawRowsSchema.parse(input);
}

test('normalizes complete Binance candles and excludes the current candle', async () => {
  const raw = await loadRawFixture();
  const snapshot = normalizeBinanceKlines(raw, {
    symbol: 'btcusdt',
    interval: '1d',
    nowMs: FIXED_NOW_MS,
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.venue, 'binance');
  assert.equal(snapshot.marketType, 'spot');
  assert.equal(snapshot.symbol, 'BTCUSDT');
  assert.equal(snapshot.interval, '1d');
  assert.equal(snapshot.bars.length, 3);
  assert.deepEqual(snapshot.bars[0], {
    openTimeMs: 1704067200000,
    closeTimeMs: 1704153599999,
    open: Math.fround(42283.58),
    high: Math.fround(44184.1),
    low: Math.fround(42180.77),
    close: Math.fround(44179.55),
    volume: Math.fround(22950.155),
  });
  assert.equal(snapshot.bars.at(-1)?.closeTimeMs, 1704326399999);
});

test('drops zero-duration empty Binance sentinels but rejects active ones', async () => {
  const raw = await loadRawFixture();
  const sentinel = [
    1704063600000,
    '42000.00000000',
    '42000.00000000',
    '42000.00000000',
    '42000.00000000',
    '0.00000000',
    1704063600000,
    '0.00000000',
    0,
    '0.00000000',
    '0.00000000',
    '0',
  ];
  const snapshot = normalizeBinanceKlines([sentinel, ...raw], {
    symbol: 'BTCUSDT',
    interval: '1d',
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(snapshot.bars.length, 3);

  const activeSentinel = structuredClone(sentinel);
  activeSentinel[5] = '1.00000000';
  assert.throws(
    () =>
      normalizeBinanceKlines([activeSentinel, ...raw], {
        symbol: 'BTCUSDT',
        interval: '1d',
        nowMs: FIXED_NOW_MS,
      }),
    /unless it is an empty Binance sentinel/,
  );
});

test('rejects nonpositive OHLC and inconsistent high/low values', async () => {
  const raw = await loadRawFixture();
  const nonpositive = structuredClone(raw);
  const inconsistent = structuredClone(raw);
  const firstNonpositive = nonpositive[0];
  const firstInconsistent = inconsistent[0];
  assert.ok(firstNonpositive !== undefined);
  assert.ok(firstInconsistent !== undefined);
  firstNonpositive[1] = '0';
  firstInconsistent[2] = '42000';

  assert.throws(() =>
    normalizeBinanceKlines(nonpositive, {
      symbol: 'BTCUSDT',
      interval: '1d',
      nowMs: FIXED_NOW_MS,
    }),
  );
  assert.throws(() =>
    normalizeBinanceKlines(inconsistent, {
      symbol: 'BTCUSDT',
      interval: '1d',
      nowMs: FIXED_NOW_MS,
    }),
  );
});

test('rejects overlapping or out-of-order candles', async () => {
  const raw = await loadRawFixture();
  const overlapping = structuredClone(raw);
  const second = overlapping[1];
  assert.ok(second !== undefined);
  second[0] = 1704153599999;

  assert.throws(
    () =>
      normalizeBinanceKlines(overlapping, {
        symbol: 'BTCUSDT',
        interval: '1d',
        nowMs: FIXED_NOW_MS,
      }),
    /overlap or are out of order/,
  );
});

test('paginates from the venue beginning and atomically persists snapshot metadata', async () => {
  const raw = await loadRawFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tea-typegpu-data-'));
  const requests: URL[] = [];
  const pages = [raw.slice(0, 2), raw.slice(2)];
  const fetcher: BinanceKlineFetcher = async input => {
    requests.push(new URL(input instanceof Request ? input.url : input));
    const page = pages.shift() ?? [];
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };

  try {
    const result = await downloadBinanceMarketSnapshot({
      symbol: 'BTCUSDT',
      interval: '1d',
      directory,
      nowMs: FIXED_NOW_MS,
      fetcher,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.origin, 'https://data-api.binance.vision');
    assert.equal(requests[0]?.pathname, '/api/v3/klines');
    assert.equal(requests[0]?.searchParams.get('startTime'), '0');
    assert.equal(requests[0]?.searchParams.get('limit'), '1000');
    assert.equal(requests[0]?.searchParams.get('symbol'), 'BTCUSDT');
    assert.equal(requests[0]?.searchParams.get('interval'), '1d');
    assert.equal(
      requests[1]?.searchParams.get('startTime'),
      String(1704239999999 + 1),
    );

    const snapshotJson = await readFile(result.snapshotPath, 'utf8');
    const manifestJson = await readFile(result.manifestPath, 'utf8');
    const snapshot = MarketSnapshotSchema.parse(JSON.parse(snapshotJson));
    const manifest = SnapshotManifestSchema.parse(JSON.parse(manifestJson));
    const digest = createHash('sha256')
      .update(snapshotJson, 'utf8')
      .digest('hex');

    assert.deepEqual(snapshot, result.snapshot);
    assert.deepEqual(manifest, result.manifest);
    assert.equal(manifest.sha256, digest);
    assert.equal(manifest.fetchedAtMs, FIXED_NOW_MS);
    assert.equal(manifest.barCount, 3);
    assert.equal(manifest.firstOpenTimeMs, 1704067200000);
    assert.equal(manifest.lastCloseTimeMs, 1704326399999);
    assert.equal(manifest.snapshotFile, path.basename(result.snapshotPath));
    assert.deepEqual(
      await loadPersistedMarketSnapshot(result.manifestPath),
      result,
    );
    assert.deepEqual(
      (await readdir(directory)).sort(),
      [
        path.basename(result.manifestPath),
        path.basename(result.snapshotPath),
      ].sort(),
    );

    await writeFile(
      result.manifestPath,
      `${JSON.stringify({...manifest, barCount: manifest.barCount + 1}, null, 2)}\n`,
      'utf8',
    );
    await assert.rejects(
      loadPersistedMarketSnapshot(result.manifestPath),
      /bar count mismatch/,
    );

    await writeFile(result.manifestPath, manifestJson, 'utf8');
    await writeFile(result.snapshotPath, `${snapshotJson}\n`, 'utf8');
    await assert.rejects(
      loadPersistedMarketSnapshot(result.manifestPath),
      /SHA-256 mismatch/,
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
