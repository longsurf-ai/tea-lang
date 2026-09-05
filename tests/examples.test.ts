// Purpose: Keep the checked-in canonical strategy example executable through
// the public CPU path and explicit about the deferred reference-struct WGSL
// boundary.

import {describe, expect, test} from 'vitest';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Errors} from '../src/base/print';
import {compileProgramToWgsl} from '../src/codegen/wgsl';
import {compileToProgram} from '../src/compiler';
import {OutputCapture} from '../src/testing/output';
import {csvStream, executeTestProgram} from '../src/testing/batch';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOURCE = join(ROOT, 'examples/strategy/ema-cross/strategy.tea');
const BB_SOURCE = join(
  ROOT,
  'examples/strategy/bb-spy-mean-reversion/strategy.tea',
);
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
    const sink = new OutputCapture();
    const result = await executeTestProgram(compileExample(), {
      stream: csvStream(csv),
      sink,
      timeNow: 1_800_000_000_000,
    });

    expect(result.indices).toBe(3_283);
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

  test('fails closed while reference-struct WGSL lowering is deferred', () => {
    const result = compileProgramToWgsl(compileExample());
    expect(result.status).toBe('staged-unsupported');
    if (result.status === 'staged-unsupported') {
      expect(result.artifact).toBeNull();
      expect(result.eligibility.issues[0]).toMatchObject({
        code: 'struct-reference-lowering-unimplemented',
        message: 'GPU struct-reference lowering is deferred for OrderRejected',
      });
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

describe('canonical component migration regressions', () => {
  test('pins BB SPY binding 0 final metrics and normalized fill tape', async () => {
    const errors = new Errors();
    const program = compileToProgram([BB_SOURCE], errors);
    if (program === null) {
      throw new Error(
        errors
          .flushErrors()
          .map(error => error.msg)
          .join('; '),
      );
    }
    expect(errors.count).toBe(0);

    const params = {
      bb_length: 12,
      bb_multiplier: 1,
      long_ema_length: 20,
      short_ema_length: 10,
      minimum_short_adx: 25,
      use_adaptive_multiplier: 0,
      use_adaptive_signals: 0,
      vov_length: 20,
      vov_gain: 0.6,
      vov_scale_min: 0.5,
      vov_scale_max: 2,
      regime_mode: 0,
      rank_length: 200,
      trend_rank_minimum: 60,
      slope_length: 10,
      slope_threshold: 0.1,
      atr_length: 14,
      atr_stop_multiple: 1.5,
      atr_target_multiple: 2.5,
      break_even_r: 1,
      use_time_exit: 0,
      minimum_hold_bars: 30,
      profit_extension_bars: 15,
      time_profit_gate_r: 0.25,
      allocation_percent: 5,
      initial_cash: 25_000,
      fee_rate: 0.0003,
      tick_size: 0.01,
      slippage_ticks: 3,
    };
    const csv = readFileSync(DATA, 'utf8');
    expect(createHash('sha256').update(csv).digest('hex')).toBe(
      'fea088e4b139c8e99fe115e5ccdc5c85f2f1b25d6af38a7e71a29dfef1d0545d',
    );

    const sink = new OutputCapture();
    const result = await executeTestProgram(program, {
      params,
      stream: csvStream(csv),
      sink,
      timeNow: 1_786_579_200_000,
    });
    expect(result.indices).toBe(3_283);

    const finalMetrics = Object.fromEntries(
      [
        'equity',
        'realized pnl',
        'total fees',
        'fill count',
        'round trips',
        'maximum drawdown',
        'total return',
      ].map(title => [title, finalScalar(sink, outputWithTitle(sink, title))]),
    );
    expect(finalMetrics).toEqual({
      equity: 29_964.929552900474,
      'realized pnl': 4_964.929552900471,
      'total fees': 16.785778506874447,
      'fill count': 36,
      'round trips': 18,
      'maximum drawdown': 0.12488412837887929,
      'total return': 0.19859718211601896,
    });

    const fillEffectIds = new Set(
      sink.effectSchemas.flatMap((effect, effectId) =>
        effect.payload.metadata.get('tea:typeId') === 'broker.FillExecuted'
          ? [effectId]
          : [],
      ),
    );
    const timeByRow = new Map(
      sink.publications.map(publication => [
        publication.index,
        publication.time,
      ]),
    );
    const fills = sink.effectEmissions
      .filter(emission => fillEffectIds.has(emission.effectId))
      .map(emission => {
        const {fill} = effectFields(emission.payload, 'broker.FillExecuted');
        const fields = effectFields(fill, 'broker.FillExecuted.fill');
        const side = effectString(fields.side, 'fill.side');
        const time = timeByRow.get(emission.row);
        if (typeof time !== 'number') {
          throw new Error(`fill row ${emission.row} has no root time`);
        }
        return {
          row: emission.row,
          time,
          role: side === 'buy' ? 'entry' : 'bracket-exit',
          side,
          barIndex: effectNumber(fields.barIndex, 'fill.barIndex'),
          referencePrice: effectNumber(
            fields.referencePrice,
            'fill.referencePrice',
          ),
          price: effectNumber(fields.price, 'fill.price'),
          quantity: effectNumber(fields.quantity, 'fill.quantity'),
          notional: effectNumber(fields.notional, 'fill.notional'),
          fee: effectNumber(fields.fee, 'fill.fee'),
        };
      });
    expect(fills).toHaveLength(36);
    expect(
      createHash('sha256').update(JSON.stringify(fills)).digest('hex'),
    ).toBe('54aabe9d33f400c7bbeea86c6fd2becba3f501d1baf8ff77ab35e86a8035dc09');
  });
});

function outputWithTitle(sink: OutputCapture, title: string): number {
  const output = sink.outputs.findIndex(candidate =>
    candidate.spec.staticArgs.some(
      argument => argument.name === 'title' && argument.value === title,
    ),
  );
  expect(output).toBeGreaterThanOrEqual(0);
  return output;
}

function finalScalar(sink: OutputCapture, outputId: number): number {
  const value = sink.emissions.findLast(
    emission => emission.outputId === outputId,
  )?.channels[0];
  expect(typeof value).toBe('number');
  return value as number;
}

function effectFields(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a struct effect value`);
  }
  return value as Record<string, unknown>;
}

function effectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${label} must be numeric`);
  }
  return value;
}

function effectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
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
