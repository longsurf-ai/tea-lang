// Purpose: Exercise the canonical bounded per-entry portfolio and immediate
// trade lifecycle without relying on a catalog strategy or external data.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {newFileBase} from '../base/pos';
import {Errors} from '../base/print';
import {checkPackage} from '../checker/check';
import type {Program} from '../ir/program';
import {TypeKind} from '../ir/type';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {buildProgram} from '../noder/noder';
import type {EffectValue, Value} from '../runtime/abi';
import {parse} from '../syntax/syntax';
import {csvStream, executeTestProgram} from './batch';
import {OutputCapture} from './output';

const LIBRARIES: Readonly<Record<string, string>> = {
  ta: readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '../tea-lib/ta.tea'),
    'utf8',
  ),
  broker: readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '../tea-lib/broker.tea'),
    'utf8',
  ),
  portfolio: readFileSync(
    join(
      fileURLToPath(new URL('.', import.meta.url)),
      '../tea-lib/portfolio.tea',
    ),
    'utf8',
  ),
  trade: readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '../tea-lib/trade.tea'),
    'utf8',
  ),
};

const REGISTRY: Registry = (path: string): PackageSource | null => {
  const source = LIBRARIES[path];
  return source === undefined
    ? null
    : {filename: `tea-lib/${path}.tea`, source};
};

type SparseEmission = OutputCapture['effectEmissions'][number];

function failOnErrors(errors: Errors): void {
  if (errors.count === 0) {
    return;
  }
  throw new Error(
    errors
      .flushErrors()
      .map(
        error =>
          `${error.pos.base.filename}:${error.pos.line}:${error.pos.col}: ${error.msg}`,
      )
      .join('\n'),
  );
}

async function execute(source: string, csv: string) {
  const errors = new Errors();
  const file = parse(newFileBase('strategy-lots.tea'), source, (pos, msg) =>
    errors.errorAt(pos, msg),
  );
  failOnErrors(errors);
  const checked = checkPackage(
    [file],
    errors,
    resolveImports([file], REGISTRY, []),
  );
  failOnErrors(errors);
  const program = buildProgram(checked, errors);
  failOnErrors(errors);
  const sink = new OutputCapture();
  await executeTestProgram(program, {
    stream: csvStream(csv),
    sink,
    timeNow: 0,
  });
  return {program, sink};
}

function valuesFor(sink: OutputCapture, oid: number): readonly Value[] {
  return sink.emissions
    .filter(emission => emission.outputId === oid)
    .sort((left, right) => left.row - right.row)
    .map(emission => emission.channels[0]);
}

function expectNumbersClose(
  actual: readonly Value[],
  expected: readonly number[],
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 12);
  });
}

function effectName(program: Program, emission: SparseEmission): string {
  const type = program.effects[emission.effectId]?.payloadType;
  if (type?.kind !== TypeKind.Struct) {
    throw new Error(`effect ${emission.effectId} has no nominal payload`);
  }
  return type.name;
}

function effectField(
  program: Program,
  emission: SparseEmission,
  ...path: readonly string[]
): EffectValue {
  let type = program.effects[emission.effectId]?.payloadType;
  let value: EffectValue | undefined = emission.payload;
  for (const name of path) {
    if (
      type?.kind !== TypeKind.Struct ||
      value === undefined ||
      typeof value !== 'object' ||
      value === null ||
      value.kind !== 'struct'
    ) {
      throw new Error(`effect ${emission.effectId} cannot select '${name}'`);
    }
    const fieldIndex = type.fields.findIndex(field => field.name === name);
    type = type.fields[fieldIndex]?.type;
    value = value.fields[fieldIndex];
  }
  if (value === undefined) {
    throw new Error(`effect ${emission.effectId} has no payload`);
  }
  return value;
}

describe('canonical bounded lot trade components', () => {
  test('matches immediate long and short stops without consuming ids on misses', async () => {
    const source = [
      'strategy("immediate stop ownership")',
      'import broker',
      'var emulator = broker.new()',
      'longAccount = broker.Account.new(1000.0, 1.0, 1, 10, 0.0, 0.0)',
      'shortAccount = broker.Account.new(1000.0, -1.0, 1, 10, 0.0, 0.0)',
      'longCommand = broker.Command.new("Long touch", broker.CommandKind.close, broker.Side.sell, 1.0, bar_index, tradeId = 101)',
      'longGapCommand = broker.Command.new("Long gap", broker.CommandKind.close, broker.Side.sell, 1.0, bar_index, tradeId = 101)',
      'shortCommand = broker.Command.new("Short touch", broker.CommandKind.close, broker.Side.buy, 1.0, bar_index, tradeId = 202)',
      'shortGapCommand = broker.Command.new("Short gap", broker.CommandKind.close, broker.Side.buy, 1.0, bar_index, tradeId = 202)',
      'invalidCommand = broker.Command.new("Invalid touched stop", broker.CommandKind.close, broker.Side.sell, 1.0, bar_index, tradeId = 101)',
      'longMiss = emulator.execute_if_stop_touched(longCommand, 10.0, 10.5, 9.5, 9.0, longAccount, bar_index)',
      'longTouch = emulator.execute_if_stop_touched(longCommand, 10.0, 10.5, 9.0, 9.0, longAccount, bar_index)',
      'longGap = emulator.execute_if_stop_touched(longGapCommand, 8.0, 9.0, 7.0, 9.0, longAccount, bar_index)',
      'shortMiss = emulator.execute_if_stop_touched(shortCommand, 10.0, 10.5, 9.5, 11.0, shortAccount, bar_index)',
      'invalidStop = emulator.execute_if_stop_touched(invalidCommand, 10.0, 10.0, -2.0, -1.0, longAccount, bar_index)',
      'shortTouch = emulator.execute_if_stop_touched(shortCommand, 10.0, 11.0, 9.5, 11.0, shortAccount, bar_index)',
      'shortGap = emulator.execute_if_stop_touched(shortGapCommand, 12.0, 13.0, 11.5, 11.0, shortAccount, bar_index)',
      'plot(na(longMiss) ? 1 : 0)',
      'plot(na(shortMiss) ? 1 : 0)',
      'plot(na(invalidStop) ? 1 : 0)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1]);
    expect(valuesFor(sink, 2)).toEqual([1]);
    expect(valuesFor(sink, 3)).toEqual([1]);
    expect(
      sink.effectEmissions.map(emission => effectName(program, emission)),
    ).toEqual([
      'OrderSubmitted',
      'FillExecuted',
      'OrderSubmitted',
      'FillExecuted',
      'OrderRejected',
      'OrderSubmitted',
      'FillExecuted',
      'OrderSubmitted',
      'FillExecuted',
    ]);

    const submitted = sink.effectEmissions.filter(
      emission => effectName(program, emission) === 'OrderSubmitted',
    );
    expect(
      submitted.map(emission => effectField(program, emission, 'order', 'id')),
    ).toEqual([1, 2, 3, 4]);
    expect(
      submitted.map(emission =>
        effectField(program, emission, 'order', 'commandId'),
      ),
    ).toEqual(['Long touch', 'Long gap', 'Short touch', 'Short gap']);

    const fills = sink.effectEmissions.filter(
      emission => effectName(program, emission) === 'FillExecuted',
    );
    expect(
      fills.map(emission => effectField(program, emission, 'fill', 'id')),
    ).toEqual([1, 2, 3, 4]);
    expect(
      fills.map(emission => effectField(program, emission, 'fill', 'orderId')),
    ).toEqual([1, 2, 3, 4]);
    expect(
      fills.map(emission =>
        effectField(program, emission, 'fill', 'referencePrice'),
      ),
    ).toEqual([9, 8, 11, 12]);
    expect(
      fills.map(emission => effectField(program, emission, 'fill', 'tradeId')),
    ).toEqual([101, 101, 202, 202]);

    const rejection = sink.effectEmissions.find(
      emission => effectName(program, emission) === 'OrderRejected',
    );
    if (rejection === undefined)
      throw new Error('missing invalid-stop rejection');
    expect(effectField(program, rejection, 'commandId')).toBe(
      'Invalid touched stop',
    );
    expect(effectField(program, rejection, 'reason')).toBe('invalidPrice');
  });

  test('keeps trailing policy through activation and a miss before a gap fill', async () => {
    const source = [
      'strategy("lot trailing policy")',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.lots(',
      '    broker.new(),',
      '    portfolio.lots(initialCash = 100.0, maxOpenTrades = 1)',
      ')',
      'var int activeTradeId = 0',
      'var bool trailingArmed = false',
      'var float trailExtreme = na',
      'var float trailDistance = na',
      'var float stopReference = 0.0',
      'strat.begin_bar(close, bar_index)',
      'if bar_index == 0',
      '    entryFill = strat.entry("Trail entry", "Trail cover", trade.Direction.long, qty = 1.0)',
      '    activeTradeId := entryFill.tradeId',
      'broker.Fill stopFill = na',
      'if activeTradeId > 0',
      '    if trailingArmed',
      '        trailExtreme := math.max(trailExtreme, high)',
      '        trailStop = trailExtreme - trailDistance',
      '        stopFill := strat.close_trade_at_stop("Trail close", activeTradeId, broker.Side.buy, open, high, low, trailStop)',
      '        if not na(stopFill)',
      '            stopReference := stopFill.referencePrice',
      '            activeTradeId := 0',
      '    else if high >= 11.0',
      '        trailingArmed := true',
      '        trailExtreme := close',
      '        trailDistance := 1.0',
      'strat.mark()',
      'metrics = strat.snapshot()',
      'plot(trailingArmed ? 1 : 0)',
      'plot(na(trailExtreme) ? 0.0 : trailExtreme)',
      'plot(stopReference)',
      'plot(metrics.openTradeCount)',
      'plot(metrics.fillCount)',
      'plot(metrics.positionQuantity)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '10,12,10,11',
        '12.8,13,12.2,12.8',
        '11,11.5,10.5,11',
        '',
      ].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 1, 1, 1]);
    expect(valuesFor(sink, 2)).toEqual([0, 11, 13, 13]);
    expect(valuesFor(sink, 3)).toEqual([0, 0, 0, 11]);
    expect(valuesFor(sink, 4)).toEqual([1, 1, 1, 0]);
    expect(valuesFor(sink, 5)).toEqual([1, 1, 1, 2]);
    expect(valuesFor(sink, 6)).toEqual([1, 1, 1, 0]);
    expect(sink.effectEmissions.map(emission => emission.row)).toEqual([
      0, 0, 3, 3,
    ]);
    expect(
      sink.effectEmissions.map(emission => effectName(program, emission)),
    ).toEqual([
      'OrderSubmitted',
      'FillExecuted',
      'OrderSubmitted',
      'FillExecuted',
    ]);
    expect(
      sink.effectEmissions
        .filter(emission => effectName(program, emission) === 'FillExecuted')
        .map(emission => effectField(program, emission, 'fill', 'commandId')),
    ).toEqual(['Trail entry', 'Trail close']);
  });

  test('fails closed when stop intent direction disagrees with the stable lot', async () => {
    const source = [
      'strategy("lot stop direction")',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.lots(broker.new(), portfolio.lots(initialCash = 100.0, maxOpenTrades = 1))',
      'var int activeTradeId = 0',
      'strat.begin_bar(close, bar_index)',
      'if bar_index == 0',
      '    entryFill = strat.entry("Long entry", "Short cover", trade.Direction.long, qty = 1.0)',
      '    activeTradeId := entryFill.tradeId',
      'if bar_index == 1',
      '    strat.close_trade_at_stop("Wrong short intent", activeTradeId, broker.Side.sell, open, high, low, 11.0)',
      '    strat.close_trade_at_stop("Correct long intent", activeTradeId, broker.Side.buy, open, high, low, 9.0)',
      'strat.mark()',
      'metrics = strat.snapshot()',
      'plot(metrics.positionQuantity)',
      'plot(metrics.openTradeCount)',
      'plot(metrics.fillCount)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,12,8,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1, 0]);
    expect(valuesFor(sink, 2)).toEqual([1, 0]);
    expect(valuesFor(sink, 3)).toEqual([1, 2]);
    expect(
      sink.effectEmissions.map(emission => effectName(program, emission)),
    ).toEqual([
      'OrderSubmitted',
      'FillExecuted',
      'OrderRejected',
      'OrderSubmitted',
      'FillExecuted',
    ]);
    expect(
      sink.effectEmissions
        .filter(emission => effectName(program, emission) === 'OrderSubmitted')
        .map(emission => effectField(program, emission, 'order', 'id')),
    ).toEqual([1, 2]);
    const rejection = sink.effectEmissions.find(
      emission => effectName(program, emission) === 'OrderRejected',
    );
    if (rejection === undefined)
      throw new Error('missing side-mismatch rejection');
    expect(effectField(program, rejection, 'commandId')).toBe(
      'Wrong short intent',
    );
    expect(effectField(program, rejection, 'reason')).toBe(
      'invalidAccountState',
    );
  });

  test('closes exact lots newest-first before an immediate reversal', async () => {
    const source = [
      'strategy("bounded lots")',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.lots(',
      '    broker = broker.new(commission = broker.commissionRate(0.01)),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 2)',
      ')',
      'var int longBTradeId = 0',
      'strat.begin_bar(close, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long A", "Short cover", trade.Direction.long, notional = 10.0)',
      '    longBExecution = strat.entry("Long B", "Short cover", trade.Direction.long, notional = 20.0)',
      '    longBTradeId := longBExecution.tradeId',
      'if bar_index == 1',
      '    strat.close_trade("Long B close", longBTradeId)',
      '    strat.entry("Long C", "Short cover", trade.Direction.long, notional = 10.0)',
      'if bar_index == 2',
      '    strat.entry("Short A", "Long reversal close", trade.Direction.short, notional = 10.0)',
      'strat.mark()',
      'metrics = strat.snapshot()',
      'plot(metrics.cash)',
      'plot(metrics.positionQuantity)',
      'plot(metrics.equity)',
      'plot(metrics.realizedPnl)',
      'plot(metrics.totalFees)',
      'plot(metrics.fillCount)',
      'plot(metrics.roundTripCount)',
      'plot(metrics.openTradeCount)',
      'plot(metrics.maxLongStack)',
      'plot(metrics.maxShortStack)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '12,12,12,12', '8,8,8,8', ''].join(
        '\n',
      ),
    );

    expectNumbersClose(valuesFor(sink, 1), [69.7, 83.36, 107.78]);
    expectNumbersClose(valuesFor(sink, 2), [3, 1 + 10 / 12, -1.25]);
    expectNumbersClose(valuesFor(sink, 3), [99.7, 105.36, 97.78]);
    expectNumbersClose(valuesFor(sink, 4), [0, 3.56, -2.12]);
    expectNumbersClose(valuesFor(sink, 5), [0.3, 0.64, 0.8866666666666667]);
    expect(valuesFor(sink, 6)).toEqual([2, 4, 7]);
    expect(valuesFor(sink, 7)).toEqual([0, 1, 3]);
    expect(valuesFor(sink, 8)).toEqual([2, 2, 1]);
    expect(valuesFor(sink, 9)).toEqual([2, 2, 2]);
    expect(valuesFor(sink, 10)).toEqual([0, 0, 1]);

    const fills = sink.effectEmissions.filter(
      emission => effectName(program, emission) === 'FillExecuted',
    );
    expect(
      fills.map(emission =>
        effectField(program, emission, 'fill', 'commandId'),
      ),
    ).toEqual([
      'Long A',
      'Long B',
      'Long B close',
      'Long C',
      'Long reversal close',
      'Long reversal close',
      'Short A',
    ]);
    expect(
      fills
        .slice(4, 6)
        .map(emission => effectField(program, emission, 'fill', 'quantity')),
    ).toEqual([10 / 12, 1]);
  });

  test('rejects capacity overflow before publishing a fill', async () => {
    const source = [
      'strategy("lot capacity")',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.lots(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 1)',
      ')',
      'strat.begin_bar(close, bar_index)',
      'strat.entry("First", "Cover", trade.Direction.long, qty = 1.0)',
      'strat.entry("Overflow", "Cover", trade.Direction.long, qty = 1.0)',
      'strat.mark()',
      'metrics = strat.snapshot()',
      'plot(metrics.openTradeCount)',
      'plot(metrics.fillCount)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1]);
    expect(valuesFor(sink, 2)).toEqual([1]);
    expect(
      sink.effectEmissions.map(emission => effectName(program, emission)),
    ).toEqual(['OrderSubmitted', 'FillExecuted', 'OrderRejected']);
  });

  test('rejects scheduled APIs for the immediate-only lot policy statically', async () => {
    const source = [
      'strategy("lot policy boundary")',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.lots(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 2)',
      ')',
      'strat.begin_bar(close, bar_index)',
      'strat.process_close(close)',
    ].join('\n');

    await expect(
      execute(source, ['open,close', '10,10', ''].join('\n')),
    ).rejects.toThrow(/process_close/);
  });

  test('rejects an unknown stable lot id before execution', async () => {
    const source = [
      'strategy("immediate policy boundary")',
      'import broker',
      'import portfolio',
      'import trade',
      'var lots = trade.lots(broker.new(), portfolio.lots(initialCash = 100.0, maxOpenTrades = 1))',
      'lots.begin_bar(close, bar_index)',
      'lots.close_trade("Invalid id", 404)',
      'lots.mark()',
      'metrics = lots.snapshot()',
      'plot(metrics.positionQuantity)',
      'plot(metrics.fillCount)',
      'plot(metrics.openTradeCount)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0]);
    expect(valuesFor(sink, 2)).toEqual([0]);
    expect(valuesFor(sink, 3)).toEqual([0]);
    expect(
      sink.effectEmissions.map(emission => effectName(program, emission)),
    ).toEqual(['OrderRejected']);
  });

  test('does not liquidate before an invalid or failed immediate reversal', async () => {
    const source = [
      'strategy("reversal failure atomicity")',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.lots(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 1)',
      ')',
      'referencePrice = bar_index == 2 ? 0.0 : close',
      'strat.begin_bar(referencePrice, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", "Short cover", trade.Direction.long, qty = 1.0)',
      'if bar_index == 1',
      '    strat.entry("Invalid short", "Long close", trade.Direction.short)',
      'if bar_index == 2',
      '    strat.entry("Rejected short", "Rejected long close", trade.Direction.short, qty = 1.0)',
      'strat.mark()',
      'metrics = strat.snapshot()',
      'plot(strat.position_quantity())',
      'plot(metrics.openTradeCount)',
      'plot(metrics.fillCount)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1, 1, 1]);
    expect(valuesFor(sink, 2)).toEqual([1, 1, 1]);
    expect(valuesFor(sink, 3)).toEqual([1, 1, 1]);
    expect(
      sink.effectEmissions.map(emission => effectName(program, emission)),
    ).toEqual([
      'OrderSubmitted',
      'FillExecuted',
      'OrderRejected',
      'OrderRejected',
    ]);
  });

  test('keeps strategy policy keyed by the returned stable trade id', async () => {
    const source = [
      'strategy("lot accounting ownership")',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.lots(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 1)',
      ')',
      'var int policyTradeId = 0',
      'var float policyTarget = na',
      'strat.begin_bar(close, bar_index)',
      'execution = strat.entry("First", "Cover", trade.Direction.long, qty = 1.0)',
      'policyTradeId := execution.tradeId',
      'policyTarget := 12.0',
      'strat.mark()',
      'metrics = strat.snapshot()',
      'plot(policyTradeId == execution.tradeId ? 1 : 0)',
      'plot(strat.position_quantity())',
      'plot(metrics.equity)',
      'plot(policyTarget)',
    ].join('\n');
    const {sink} = await execute(
      source,
      ['open,close', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1]);
    expect(valuesFor(sink, 2)).toEqual([1]);
    expect(valuesFor(sink, 3)).toEqual([100]);
    expect(valuesFor(sink, 4)).toEqual([12]);
  });
});
