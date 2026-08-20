#!/usr/bin/env -S node --import tsx

// Rebuild the checked-in 15-minute BTCUSDT example from the normalized
// one-minute parent snapshot recorded in btcusdt-15m.source.json.

import {createHash} from 'node:crypto';
import {createReadStream, existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';

const EXPECTED_PARENT_SHA256 =
  '8a1fe2cc985c0b3c67422b63cad894ce3e8c9a566a314609b1e115f221e44176';
const EXPECTED_PARENT_ROWS_WITH_HEADER = 4_717_209;
const EXPECTED_OUTPUT_SHA256 =
  '2eece143be58b72349e513b8392d45cd8a8f27fdf011c544767a26a406af3721';
const INTERVAL_MS = 15 * 60 * 1_000;
const SOURCE_STEP_MS = 60 * 1_000;
const OUTPUT_ROWS = 20_000;
const HEADER = 'time,open,high,low,close,volume';

interface SourceRow {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Bucket {
  start: number;
  firstTime: number;
  lastTime: number;
  count: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function usage(): never {
  throw new Error(
    'usage: node --import tsx examples/data/binance/derive-btcusdt-15m.ts <normalized-1m.csv> <new-output.csv>',
  );
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function parseRow(line: string, lineNumber: number): SourceRow {
  const fields = line.split(',');
  if (fields.length !== 6) {
    throw new Error(`line ${lineNumber}: expected 6 columns`);
  }
  const values = fields.map(Number);
  if (!values.every(Number.isFinite) || !Number.isSafeInteger(values[0])) {
    throw new Error(`line ${lineNumber}: invalid numeric value`);
  }
  const [time, open, high, low, close, volume] = values;
  if (
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    volume < 0
  ) {
    throw new Error(`line ${lineNumber}: invalid OHLCV envelope`);
  }
  return {time, open, high, low, close, volume};
}

function complete(bucket: Bucket): boolean {
  return (
    bucket.count === 15 &&
    bucket.firstTime === bucket.start &&
    bucket.lastTime - bucket.firstTime === 14 * SOURCE_STEP_MS
  );
}

function format(bucket: Bucket): string {
  return [
    bucket.start,
    bucket.open.toFixed(8),
    bucket.high.toFixed(8),
    bucket.low.toFixed(8),
    bucket.close.toFixed(8),
    bucket.volume.toFixed(8),
  ].join(',');
}

async function main(): Promise<void> {
  const [, , inputPath, outputPath, ...extra] = process.argv;
  if (
    inputPath === undefined ||
    outputPath === undefined ||
    extra.length !== 0
  ) {
    usage();
  }
  if (existsSync(outputPath)) {
    throw new Error(`refusing to overwrite existing output: ${outputPath}`);
  }

  const inputDigest = await sha256(inputPath);
  if (inputDigest !== EXPECTED_PARENT_SHA256) {
    throw new Error(
      `parent SHA-256 mismatch: expected ${EXPECTED_PARENT_SHA256}, got ${inputDigest}`,
    );
  }

  const lines = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });
  const retained: string[] = [];
  let lineNumber = 0;
  let previousTime: number | null = null;
  let bucket: Bucket | null = null;

  const retain = (candidate: Bucket | null): void => {
    if (candidate === null || !complete(candidate)) return;
    retained.push(format(candidate));
    if (retained.length > OUTPUT_ROWS) retained.shift();
  };

  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      if (line !== HEADER) throw new Error(`unexpected header: ${line}`);
      continue;
    }
    const row = parseRow(line, lineNumber);
    if (previousTime !== null && row.time <= previousTime) {
      throw new Error(
        `line ${lineNumber}: timestamps are not strictly ordered`,
      );
    }
    previousTime = row.time;
    const start = Math.floor(row.time / INTERVAL_MS) * INTERVAL_MS;
    if (bucket === null || bucket.start !== start) {
      retain(bucket);
      bucket = {
        start,
        firstTime: row.time,
        lastTime: row.time,
        count: 1,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      };
      continue;
    }
    if (row.time - bucket.lastTime !== SOURCE_STEP_MS) {
      // Keep consuming the bucket, but its count/span cannot pass complete().
      bucket.count = -1_000_000;
    }
    bucket.lastTime = row.time;
    bucket.count += 1;
    bucket.high = Math.max(bucket.high, row.high);
    bucket.low = Math.min(bucket.low, row.low);
    bucket.close = row.close;
    bucket.volume += row.volume;
  }
  retain(bucket);

  if (lineNumber !== EXPECTED_PARENT_ROWS_WITH_HEADER) {
    throw new Error(
      `parent row-count mismatch: expected ${EXPECTED_PARENT_ROWS_WITH_HEADER}, got ${lineNumber}`,
    );
  }
  if (retained.length !== OUTPUT_ROWS) {
    throw new Error(
      `not enough complete buckets: expected ${OUTPUT_ROWS}, got ${retained.length}`,
    );
  }

  const output = `${HEADER}\n${retained.join('\n')}\n`;
  const outputDigest = createHash('sha256').update(output).digest('hex');
  if (outputDigest !== EXPECTED_OUTPUT_SHA256) {
    throw new Error(
      `derived SHA-256 mismatch: expected ${EXPECTED_OUTPUT_SHA256}, got ${outputDigest}`,
    );
  }
  await writeFile(outputPath, output, {encoding: 'utf8', flag: 'wx'});
  process.stdout.write(`${outputDigest}  ${outputPath}\n`);
}

await main();
