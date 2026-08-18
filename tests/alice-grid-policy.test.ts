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
  type ExecutionConfig,
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
  expect(source).toContain('strat.close_trade_at_stop(');
  expect(source).not.toContain('trail_hit');
  expect(source).not.toContain('close_price');
  expect(source).not.toMatch(
    /\bstrat\.close_trade\([^\n]*,\s*(?:open|high|low|close)\s*\)/,
  );
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
    runConfig(loaded.config, params, timeNow),
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

  const {fills, timeByRow} = fillTape(sink);
  expect(fills).toHaveLength(858);

  const economicFills = fills.map(({commandId: _commandId, ...fill}) => fill);
  expect(hash(economicFills)).toBe(
    '6849fc4bca1297566f91428f386f0cb4b563759523aad626eb9405df1e2bb645',
  );
  expect(hash(fills)).toBe(
    '385f0e707ebdc95121563b74c984611fcaa6b3214e545765f1367f17269ba64c',
  );

  const lifecycle = lifecycleTape(sink, timeByRow);
  expect(hash(lifecycle)).toBe(
    '9715dc5b883e9b8971016fc7a64bcde87ee95548d67b97ceded0d138bd3d22a3',
  );
});

test('preserves trailing-enabled Alice fill and lifecycle tapes', async () => {
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
  const selected = runConfig(loaded.config, params, timeNow);
  if (selected.execution.kind !== 'run') {
    throw new Error('selected Alice binding must be a run');
  }
  const config = {
    ...selected,
    execution: {
      ...selected.execution,
      parameters: {
        ...selected.execution.parameters,
        use_trailing: 1,
        use_stop_loss: 0,
      },
    },
  };
  const sink = new MemorySink();
  const result = await executeConfiguredProgram(program, config, {
    sinkForExecution: () => sink,
  });
  expect(result.summary.bindings[0]?.rows).toBe(20_000);

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
    'f9e7fe6d8c11bffad001a7b4ae24587fe8fb0dd34633ba195b4c306441f06bc0',
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

function runConfig(
  config: ExecutionConfig,
  parameters: ExecutionConfig['execution']['parameters'],
  timeNow: number,
): ExecutionConfig {
  return {
    ...config,
    execution: {
      kind: 'run',
      provider: config.execution.provider,
      parameters,
      timeNow,
    },
  };
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

function fillTape(sink: MemorySink) {
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
  return {fills, timeByRow};
}

function lifecycleTape(
  sink: MemorySink,
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

function lifecycleKind(sink: MemorySink, effectId: number): string {
  const payload = sink.effectSchemas[effectId]?.payload;
  if (payload === undefined) return `unknown:${effectId}`;
  return payload.kind === 'user-type' ? payload.typeId : payload.kind;
}
