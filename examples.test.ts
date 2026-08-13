// Purpose: Keep the checked-in canonical strategy example executable through
// the public CPU path and eligible for the same Program's WGSL lowering.

import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Errors} from './src/base/print';
import {compileProgramToWgsl} from './src/codegen/wgsl';
import {compileToProgram} from './src/compile';
import {executeProgram} from './src/execute';
import {csvProvider} from './src/providers/data/csv';
import {MemorySink} from './src/providers/sinks/memory-sink';

const SOURCE = join(import.meta.dir, 'examples/ema-cross-strategy.tea');
const DATA = join(import.meta.dir, 'examples/binance-btcusdt-1d.csv');
const DATA_SOURCE = join(
  import.meta.dir,
  'examples/binance-btcusdt-1d.source.json',
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
      sha256: string;
      rows: number;
      firstOpenTime: string;
      lastOpenTime: string;
      request: {query: {endTime: number; timeZone: string}};
    };
    expect(createHash('sha256').update(csv).digest('hex')).toBe(source.sha256);
    validateMarketData(csv, source);
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
  source: {
    rows: number;
    firstOpenTime: string;
    lastOpenTime: string;
    request: {query: {endTime: number; timeZone: string}};
  },
): void {
  const lines = csv.trimEnd().split('\n');
  expect(lines[0]).toBe('time,open,high,low,close,volume');
  expect(lines).toHaveLength(source.rows + 1);
  expect(source.rows).toBe(3_283);
  expect(source.request.query).toMatchObject({
    endTime: 1_786_579_199_999,
    timeZone: '0',
  });

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
    if (previousTime !== null) expect(time - previousTime).toBe(86_400_000);
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
