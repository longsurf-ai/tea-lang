// Purpose: Keep the checked-in canonical strategy example executable through
// the public CPU path and eligible for the same Program's WGSL lowering.

import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Errors} from '../src/base/print';
import {compileProgramToWgsl} from '../src/codegen/wgsl';
import {compileToProgram} from '../src/compile';
import {executeProgram} from '../src/execute';
import {csvProvider} from '../src/providers/data/csv';
import {MemorySink} from '../src/providers/sinks/memory-sink';

const ROOT = join(import.meta.dir, '..');
const SOURCE = join(ROOT, 'examples/strategy/ema-cross/strategy.tea');
const DATA = join(ROOT, 'examples/data/binance/btcusdt-1d.csv');
const DATA_SOURCE = join(ROOT, 'examples/data/binance/btcusdt-1d.source.json');
const INTRADAY_DATA = join(ROOT, 'examples/data/binance/btcusdt-15m.csv');
const INTRADAY_DATA_SOURCE = join(
  ROOT,
  'examples/data/binance/btcusdt-15m.source.json',
);
const INTRADAY_DERIVATION = join(
  ROOT,
  'examples/data/binance/derive-btcusdt-15m.ts',
);

function compileExample() {
  const errors = new Errors();
  const program = compileToProgram([SOURCE], errors);
  if (program === null) {
    throw new Error(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  expect(errors.count).toBe(0);
  return program;
}

describe('canonical EMA crossover example', () => {
  test('runs the complete checked-in Binance history on CPU', async () => {
    const csv = readFileSync(DATA, 'utf8');
    const source = JSON.parse(readFileSync(DATA_SOURCE, 'utf8')) as {
      file: string;
      sha256: string;
      rows: number;
      firstOpenTime: string;
      lastOpenTime: string;
      request: {query: {endTime: number; timeZone: string}};
    };
    expect(source.file).toBe('btcusdt-1d.csv');
    expect(createHash('sha256').update(csv).digest('hex')).toBe(source.sha256);
    validateMarketData(csv, source, 3_283, 86_400_000);
    const sink = new MemorySink();
    const result = await executeProgram(
      compileExample(),
      [
        {
          params: {},
          provider: csvProvider(csv),
          sink,
          timeNow: 1_800_000_000_000,
        },
      ],
      {kind: 'cpu'},
    );

    expect(result.numericProfile).toBe('js-f64');
    expect(result.bindings[0]?.rows).toBe(3_283);
    expect(sink.publications).toHaveLength(3_283);
    expect(sink.effectEmissions).toHaveLength(416);

    const roundTrips = sink.outputs.findIndex(output =>
      output.spec.staticArgs.some(
        arg => arg.name === 'title' && arg.value === 'round trips',
      ),
    );
    expect(roundTrips).toBeGreaterThanOrEqual(0);
    expect(
      sink.emissions.find(
        emission => emission.row === 3_282 && emission.outputId === roundTrips,
      )?.channels,
    ).toEqual([104]);

    const totalReturn = outputWithTitle(sink, 'total return');
    const maxDrawdown = outputWithTitle(sink, 'maximum drawdown');
    expect(finalScalar(sink, totalReturn)).toBeCloseTo(28.1578027217, 9);
    expect(finalScalar(sink, maxDrawdown)).toBeCloseTo(0.5660947992, 9);
  });

  test('is eligible for direct WGSL lowering', () => {
    const result = compileProgramToWgsl(compileExample());
    expect(result.status).toBe('compiled');
    if (result.status === 'compiled') {
      expect(result.artifact.module.source).not.toContain('ta.ema');
      expect(result.artifact.module.source).not.toContain('ta.crossover');
      expect(result.artifact.module.source).not.toContain('ta.crossunder');
    }
  });

  test('pins the derived Binance intraday history used by strategies', () => {
    const csv = readFileSync(INTRADAY_DATA, 'utf8');
    const source = JSON.parse(
      readFileSync(INTRADAY_DATA_SOURCE, 'utf8'),
    ) as MarketDataSource;
    expect(source.file).toBe('btcusdt-15m.csv');
    expect(createHash('sha256').update(csv).digest('hex')).toBe(source.sha256);
    expect(source.interval).toBe('15m');
    expect(source.derivedFrom).toMatchObject({
      sha256:
        '8a1fe2cc985c0b3c67422b63cad894ce3e8c9a566a314609b1e115f221e44176',
      rowsIncludingHeader: 4_717_209,
    });
    expect(source.normalization?.derivationScript).toBe(
      'derive-btcusdt-15m.ts',
    );
    expect(existsSync(INTRADAY_DERIVATION)).toBe(true);
    validateMarketData(csv, source, 20_000, 900_000);
  });
});

function outputWithTitle(sink: MemorySink, title: string): number {
  const output = sink.outputs.findIndex(candidate =>
    candidate.spec.staticArgs.some(
      argument => argument.name === 'title' && argument.value === title,
    ),
  );
  expect(output).toBeGreaterThanOrEqual(0);
  return output;
}

function finalScalar(sink: MemorySink, outputId: number): number {
  const value = sink.emissions.findLast(
    emission => emission.outputId === outputId,
  )?.channels[0];
  expect(typeof value).toBe('number');
  return value as number;
}

function validateMarketData(
  csv: string,
  source: MarketDataSource,
  expectedRows: number,
  cadenceMs: number,
): void {
  const lines = csv.trimEnd().split('\n');
  expect(lines[0]).toBe('time,open,high,low,close,volume');
  expect(lines).toHaveLength(source.rows + 1);
  expect(source.rows).toBe(expectedRows);
  if (source.request !== undefined) {
    expect(source.request.query).toMatchObject({
      endTime: 1_786_579_199_999,
      timeZone: '0',
    });
  }

  let previousTime: number | null = null;
  for (const line of lines.slice(1)) {
    const values = line.split(',').map(Number);
    expect(values).toHaveLength(6);
    expect(values.every(Number.isFinite)).toBe(true);
    const [time, open, high, low, close, volume] = values as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (previousTime !== null) expect(time - previousTime).toBe(cadenceMs);
    expect(low).toBeLessThanOrEqual(Math.min(open, close));
    expect(high).toBeGreaterThanOrEqual(Math.max(open, close));
    expect(volume).toBeGreaterThanOrEqual(0);
    previousTime = time;
  }

  expect(new Date(Number(lines[1]?.split(',')[0])).toISOString()).toBe(
    source.firstOpenTime,
  );
  expect(new Date(previousTime ?? Number.NaN).toISOString()).toBe(
    source.lastOpenTime,
  );
}

interface MarketDataSource {
  readonly file: string;
  readonly sha256: string;
  readonly interval?: string;
  readonly rows: number;
  readonly firstOpenTime: string;
  readonly lastOpenTime: string;
  readonly request?: {
    readonly query: {readonly endTime: number; readonly timeZone: string};
  };
  readonly derivedFrom?: {
    readonly sha256: string;
    readonly rowsIncludingHeader: number;
  };
  readonly normalization?: {readonly derivationScript?: string};
}
