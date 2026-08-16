// Purpose: Alice Grid owns per-entry policy locally while preserving the
// canonical lot portfolio's audited accounting and fill tape.

import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Errors} from '../src/base/print';
import {paramSpecsOf} from '../src/codegen/params';
import {compileToProgram} from '../src/compile';
import {
  executeConfiguredProgram,
  loadExecutionConfig,
  resolveExecutionParameters,
  selectSweepScenarioConfig,
} from '../src/execution';
import {MemorySink} from '../src/providers/sinks/memory-sink';
import type {EffectValue} from '../src/runtime/abi';

const ROOT = join(import.meta.dir, '..');
const SOURCE = join(ROOT, 'examples/strategy/alice-grid/strategy.tea');
const SWEEP = join(ROOT, 'examples/strategy/alice-grid/sweep.yaml');

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
});

test('preserves Alice binding 0 metrics and both normalized fill tapes', async () => {
  const loaded = loadExecutionConfig(SWEEP);
  if (loaded.config.execution.kind !== 'sweep') {
    throw new Error('Alice policy fixture must remain a sweep');
  }

  const errors = new Errors();
  const program = compileToProgram([loaded.config.program.source], errors);
  if (program === null) {
    throw new Error(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  expect(errors.count).toBe(0);

  const timeNow = loaded.config.execution.timeNow;
  if (timeNow === undefined) {
    throw new Error('Alice policy fixture must pin execution.timeNow');
  }
  const params = resolveExecutionParameters(
    paramSpecsOf(program.params),
    loaded.config.execution,
  ).parameterSets[0];
  if (params === undefined) {
    throw new Error('Alice policy fixture must contain binding 0');
  }

  const sink = new MemorySink();
  const result = await executeConfiguredProgram(
    program,
    selectSweepScenarioConfig(program, loaded.config, 0, timeNow),
    {sinkForExecution: () => sink},
  );
  expect(result.summary.numericProfile).toBe('js-f64');
  expect(result.summary.bindings[0]?.rows).toBe(20_000);

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

  const fillEffectIds = new Set(
    sink.effectSchemas.flatMap((effect, effectId) =>
      effect.payload.kind === 'user-type' &&
      effect.payload.typeId === 'broker.FillExecuted'
        ? [effectId]
        : [],
    ),
  );
  const timeByRow = new Map(
    sink.publications.map(publication => [publication.row, publication.time]),
  );
  const fills = sink.effectEmissions
    .filter(emission => fillEffectIds.has(emission.effectId))
    .map(emission => {
      const fields = fillFields(emission.payload);
      return {
        row: emission.row,
        time: timeByRow.get(emission.row),
        commandId: fields[2],
        side: fields[3],
        barIndex: fields[4],
        referencePrice: fields[5],
        price: fields[6],
        quantity: fields[7],
        notional: fields[8],
        fee: fields[9],
      };
    });
  expect(fills).toHaveLength(858);

  const economicFills = fills.map(({commandId: _commandId, ...fill}) => fill);
  expect(hash(economicFills)).toBe(
    '6849fc4bca1297566f91428f386f0cb4b563759523aad626eb9405df1e2bb645',
  );
  expect(hash(fills)).toBe(
    '385f0e707ebdc95121563b74c984611fcaa6b3214e545765f1367f17269ba64c',
  );
});

function finalMetric(sink: MemorySink, title: string): number {
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

function fillFields(payload: EffectValue): readonly EffectValue[] {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    payload.kind !== 'user-type'
  ) {
    throw new Error('FillExecuted payload is not a user value');
  }
  const fill = payload.fields[0];
  if (typeof fill !== 'object' || fill === null || fill.kind !== 'user-type') {
    throw new Error('FillExecuted.fill is not a user value');
  }
  return fill.fields;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
