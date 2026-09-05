// Purpose: Alice Grid owns per-entry policy locally while preserving the
// canonical lot portfolio's audited accounting and fill tape.

import {expect, test} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Errors} from '../src/base/print';
import {compileToProgram} from '../src/compiler';
import {OutputCapture} from '../src/testing/output';
import {csvStream, executeTestProgram} from '../src/testing/batch';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOURCE = join(ROOT, 'examples/strategy/alice-grid/strategy.tea');
const DATA = join(ROOT, 'examples/data/binance/btcusdt-15m.csv');
const TIME_NOW = 1_786_579_200_000;
const PARAMETERS = {
  entry_reversal_mode: 0,
  grid_step_percent: 1,
  maximum_steps: 5,
  maximum_open_trades: 100,
  tp_reversal_mode: 0,
  use_trailing: 0,
  trailing_offset_percent: 1,
  use_stop_loss: 1,
  stop_loss_multiplier: 2,
  use_date_filter: 0,
  start_time: 1_704_067_200_000,
  end_time: 1_893_456_000_000,
  cash_per_order: 10,
  initial_cash: 1000,
  fee_rate: 0.00025,
} as const;

test('keeps Alice grid policy out of the portfolio facade', () => {
  const source = readFileSync(SOURCE, 'utf8');

  expect(source).toContain('type GridPosition');
  expect(source).toContain('import trade');
  expect(source).toContain('trade.lots(');
  expect(source).toContain('array.new<GridPosition>()');
  expect(source).toContain('close_fill.tradeId == grid_position.tradeId');
  expect(source).toContain('GridPosition.new(short_fill.tradeId');
  expect(source).toContain('GridPosition.new(long_fill.tradeId');
  expect(source).not.toMatch(
    /\bstrat\.(?:open_trade|open_trade_count|update_open_trade)\s*\(/,
  );
  expect(source).not.toMatch(
    /\bstrat\.entry_now\([^\n]*(?:tag|target|stop)\s*=/,
  );
  expect(source).not.toContain('strat.entry_now(');
  expect(source).toContain('strat.close_trade_at_stop(');
  expect(source).not.toContain('trail_hit');
  expect(source).not.toContain('close_price');
  expect(source).not.toMatch(
    /\bstrat\.close_trade\([^\n]*,\s*(?:open|high|low|close)\s*\)/,
  );
});

test('preserves Alice binding 0 metrics and both normalized fill tapes', async () => {
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

  const sink = new OutputCapture();
  const result = await executeTestProgram(program, {
    params: PARAMETERS,
    stream: csvStream(readFileSync(DATA, 'utf8')),
    sink,
    timeNow: TIME_NOW,
  });
  expect(result.indices).toBe(20_000);

  expect(finalMetric(sink, 'position quantity')).toBe(0.00031367827436811684);
  expect(finalMetric(sink, 'open lots')).toBe(2);
  expect(finalMetric(sink, 'maximum long stack')).toBe(3);
  expect(finalMetric(sink, 'maximum short stack')).toBe(3);
  expect(finalMetric(sink, 'equity')).toBe(1000.0150967846109);
  expect(finalMetric(sink, 'realized pnl')).toBe(0.0701585348221262);
  expect(finalMetric(sink, 'total fees')).toBe(2.1439746344880684);
  expect(finalMetric(sink, 'fill count')).toBe(858);
  expect(finalMetric(sink, 'round trips')).toBe(428);
  expect(finalMetric(sink, 'maximum drawdown')).toBe(0.005379891680331017);
  expect(finalMetric(sink, 'total return')).toBe(0.000015096784610932446);

  const {fills, timeByRow} = fillTape(sink);
  expect(fills).toHaveLength(858);

  const economicFills = fills.map(({commandId: _commandId, ...fill}) => fill);
  expect(hash(economicFills)).toBe(
    '6849fc4bca1297566f91428f386f0cb4b563759523aad626eb9405df1e2bb645',
  );
  expect(hash(fills)).toBe(
    '385f0e707ebdc95121563b74c984611fcaa6b3214e545765f1367f17269ba64c',
  );

  // Schema migration oracle: execute pre-Arrow commit 5a369670093b82c6d363f988b2971e7bf46d5894,
  // verify its original lifecycle hashes, then replace positional struct fields
  // with names from that baseline's declarations. Economic fill hashes stay unchanged.
  const lifecycle = lifecycleTape(sink, timeByRow);
  expect(hash(lifecycle)).toBe(
    '9b0dea8882b64345cb1314fe6e9622848562f10090a1499df51157b3582b66a4',
  );
}, 15_000);

test('preserves trailing-enabled Alice fill and lifecycle tapes', async () => {
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
  const sink = new OutputCapture();
  const result = await executeTestProgram(program, {
    params: {...PARAMETERS, use_trailing: 1, use_stop_loss: 0},
    stream: csvStream(readFileSync(DATA, 'utf8')),
    sink,
    timeNow: TIME_NOW,
  });
  expect(result.indices).toBe(20_000);

  const {fills, timeByRow} = fillTape(sink);
  expect(fills).toHaveLength(858);
  const economicFills = fills.map(({commandId: _commandId, ...fill}) => fill);
  expect(hash(economicFills)).toBe(
    '2dc570fd8b4b785f5a60c37c553a08213a9221ed1c3604196e54e23f3f57cc15',
  );
  expect(hash(fills)).toBe(
    'ceb1eaf1a12b2967d554396e292dec3f43274304241d34095f07dba7eb99a48f',
  );
  expect(hash(lifecycleTape(sink, timeByRow))).toBe(
    '30a8a4e8ca734e433ad7f76106479f6a8b8cfe4b50c858919d855803b7bdf3ef',
  );
}, 15_000);

function finalMetric(sink: OutputCapture, title: string): number {
  const outputId = sink.outputs.findIndex(output =>
    output.spec.staticArgs.some(
      argument => argument.name === 'title' && argument.value === title,
    ),
  );
  if (outputId < 0) throw new Error(`Alice output '${title}' is missing`);
  const value = sink.emissions.findLast(
    emission => emission.outputId === outputId,
  )?.channels[0];
  if (typeof value !== 'number') {
    throw new Error(`Alice output '${title}' has no final numeric value`);
  }
  return value;
}

function fillFields(payload: unknown): Record<string, unknown> {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('fill' in payload) ||
    typeof payload.fill !== 'object' ||
    payload.fill === null
  ) {
    throw new Error('FillExecuted.fill is not a record');
  }
  return payload.fill as Record<string, unknown>;
}

function fillTape(sink: OutputCapture) {
  const fillEffectIds = new Set(
    sink.effectSchemas.flatMap((effect, effectId) =>
      effect.payload.metadata.get('tea:typeId') === 'broker.FillExecuted'
        ? [effectId]
        : [],
    ),
  );
  const timeByRow = new Map(
    sink.publications.map(publication => [publication.index, publication.time]),
  );
  const fills = sink.effectEmissions
    .filter(emission => fillEffectIds.has(emission.effectId))
    .map(emission => {
      const fields = fillFields(emission.payload);
      return {
        row: emission.row,
        time: timeByRow.get(emission.row),
        commandId: fields.commandId,
        side: fields.side,
        barIndex: fields.barIndex,
        referencePrice: fields.referencePrice,
        price: fields.price,
        quantity: fields.quantity,
        notional: fields.notional,
        fee: fields.fee,
      };
    });
  return {fills, timeByRow};
}

function lifecycleTape(
  sink: OutputCapture,
  timeByRow: ReadonlyMap<number, number | null | undefined>,
) {
  return sink.effectEmissions.map(emission => ({
    row: emission.row,
    time: timeByRow.get(emission.row),
    kind: lifecycleKind(sink, emission.effectId),
    payload: emission.payload,
  }));
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function lifecycleKind(sink: OutputCapture, effectId: number): string {
  const payload = sink.effectSchemas[effectId]?.payload;
  if (payload === undefined) return `unknown:${effectId}`;
  return (
    payload.metadata.get('tea:typeId') ??
    payload.metadata.get('tea:type') ??
    payload.type.toString()
  );
}
