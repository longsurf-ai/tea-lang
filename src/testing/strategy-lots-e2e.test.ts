// Purpose: Exercise the canonical bounded per-entry portfolio and immediate
// broker lifecycle without relying on a catalog strategy or external data.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {newFileBase} from '../base/pos';
import {Errors} from '../base/print';
import {checkPackage} from '../checker/check';
import {generate} from '../codegen/codegen';
import type {Program} from '../ir/program';
import {TypeKind} from '../ir/type';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {buildProgram} from '../noder/noder';
import {csvProvider} from '../providers/data/csv';
import type {EffectValue, OutputSink, Value} from '../runtime/abi';
import {bind} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';
import {parse} from '../syntax/syntax';

const LIBRARIES: Readonly<Record<string, string>> = {
  ta: readFileSync(join(import.meta.dir, '../lib/ta.tea'), 'utf8'),
  broker: readFileSync(join(import.meta.dir, '../lib/broker.tea'), 'utf8'),
  portfolio: readFileSync(
    join(import.meta.dir, '../lib/portfolio.tea'),
    'utf8',
  ),
  strategy: readFileSync(join(import.meta.dir, '../lib/strategy.tea'), 'utf8'),
};

const REGISTRY: Registry = (path: string): PackageSource | null => {
  const source = LIBRARIES[path];
  return source === undefined ? null : {filename: `lib/${path}.tea`, source};
};

interface Emission {
  readonly row: number;
  readonly oid: number;
  readonly channels: readonly Value[];
}

interface SparseEmission {
  readonly row: number;
  readonly effectId: number;
  readonly payload: EffectValue;
}

class Sink implements OutputSink {
  readonly emissions: Emission[] = [];
  readonly effects: SparseEmission[] = [];

  declare(): void {}

  publish(publication: Parameters<OutputSink['publish']>[0]): void {
    for (const output of publication.outputs) {
      this.emissions.push({
        row: publication.row,
        oid: output.outputId,
        channels: [...output.channels],
      });
    }
    for (const effect of publication.effects) {
      this.effects.push({
        row: publication.row,
        effectId: effect.effectId,
        payload: effect.payload,
      });
    }
  }
}

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
  const sink = new Sink();
  const bound = await bind(loadModule(generate(program)), {
    params: {},
    provider: csvProvider(csv),
    sink,
    timeNow: 0,
  });
  await bound.runAll();
  bound.dispose();
  return {program, sink};
}

function valuesFor(sink: Sink, oid: number): readonly Value[] {
  return sink.emissions
    .filter(emission => emission.oid === oid)
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
  if (type?.kind !== TypeKind.UserType) {
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
      type?.kind !== TypeKind.UserType ||
      value === undefined ||
      typeof value !== 'object' ||
      value === null ||
      value.kind !== 'user-type'
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

describe('canonical bounded lot strategy components', () => {
  test('closes exact lots newest-first before an immediate reversal', async () => {
    const source = [
      'strategy("bounded lots")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(commission = broker.commissionRate(0.01)),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 2)',
      ')',
      'strat.begin_immediate(bar_index)',
      'if bar_index == 0',
      '    strat.entry_now("Long A", "Short cover", strategy.Direction.long, close, notional = 10.0, tag = 1, target = 15.0)',
      '    strat.entry_now("Long B", "Short cover", strategy.Direction.long, close, notional = 20.0, tag = 2, target = 16.0)',
      'if bar_index == 1',
      '    newest = strat.open_trade(strat.open_trade_count() - 1)',
      '    newest.trailingArmed := true',
      '    newest.trailExtreme := high',
      '    newest.trailDistance := 1.0',
      '    strat.update_open_trade(strat.open_trade_count() - 1, newest)',
      '    strat.close_trade("Long B close", strat.open_trade_count() - 1, close)',
      '    strat.entry_now("Long C", "Short cover", strategy.Direction.long, close, notional = 10.0, tag = 3, target = 17.0)',
      'if bar_index == 2',
      '    strat.entry_now("Short A", "Long reversal close", strategy.Direction.short, close, notional = 10.0, tag = 4, target = 7.0)',
      'strat.mark(close)',
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

    const fills = sink.effects.filter(
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
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 1)',
      ')',
      'strat.begin(open, bar_index)',
      'strat.entry_now("First", "Cover", strategy.Direction.long, close, qty = 1.0)',
      'strat.entry_now("Overflow", "Cover", strategy.Direction.long, close, qty = 1.0)',
      'strat.mark(close)',
      'plot(strat.open_trade_count())',
      'plot(strat.fill_count())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1]);
    expect(valuesFor(sink, 2)).toEqual([1]);
    expect(sink.effects.map(emission => effectName(program, emission))).toEqual(
      ['OrderSubmitted', 'FillExecuted', 'OrderRejected'],
    );
  });

  test('rejects scalar pending-order APIs for the immediate-only lot policy', async () => {
    const source = [
      'strategy("lot policy boundary")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 2)',
      ')',
      'strat.begin_immediate(bar_index)',
      'strat.entry("Wrong API", strategy.Direction.long, qty = 1.0)',
      'strat.process_close(close)',
      'strat.mark(close)',
      'plot(strat.open_trade_count())',
      'plot(strat.fill_count())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0]);
    expect(valuesFor(sink, 2)).toEqual([0]);
    expect(sink.effects.map(emission => effectName(program, emission))).toEqual(
      ['OrderRejected'],
    );
  });

  test('rejects immediate APIs for scalar portfolios and invalid lot indices', async () => {
    const source = [
      'strategy("immediate policy boundary")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var scalar = strategy.configure(broker.new(), portfolio.new(initialCash = 100.0))',
      'var lots = strategy.configure(broker.new(), portfolio.lots(initialCash = 100.0, maxOpenTrades = 1))',
      'scalar.begin_immediate(bar_index)',
      'lots.begin_immediate(bar_index)',
      'scalar.entry_now("Unsupported entry", "Cover", strategy.Direction.long, close, qty = 1.0)',
      'scalar.close_trade("Unsupported close", 0, close)',
      'lots.close_trade("Invalid index", 0, close)',
      'scalar.mark(close)',
      'lots.mark(close)',
      'plot(scalar.fill_count())',
      'plot(lots.fill_count())',
      'plot(lots.open_trade_count())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0]);
    expect(valuesFor(sink, 2)).toEqual([0]);
    expect(valuesFor(sink, 3)).toEqual([0]);
    expect(sink.effects.map(emission => effectName(program, emission))).toEqual(
      ['OrderRejected', 'OrderRejected', 'OrderRejected'],
    );
  });

  test('does not liquidate before an invalid or failed immediate reversal', async () => {
    const source = [
      'strategy("reversal failure atomicity")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 1)',
      ')',
      'strat.begin_immediate(bar_index)',
      'if bar_index == 0',
      '    strat.entry_now("Long", "Short cover", strategy.Direction.long, close, qty = 1.0)',
      'if bar_index == 1',
      '    strat.entry_now("Invalid short", "Long close", strategy.Direction.short, close)',
      'if bar_index == 2',
      '    strat.portfolio.maxOpenTrades := 0',
      '    strat.entry_now("Rejected short", "Rejected long close", strategy.Direction.short, close, qty = 1.0)',
      'strat.mark(close)',
      'plot(strat.position_quantity())',
      'plot(strat.open_trade_count())',
      'plot(strat.fill_count())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1, 1, 1]);
    expect(valuesFor(sink, 2)).toEqual([1, 1, 1]);
    expect(valuesFor(sink, 3)).toEqual([1, 1, 1]);
    expect(sink.effects.map(emission => effectName(program, emission))).toEqual(
      ['OrderSubmitted', 'FillExecuted', 'OrderRejected', 'OrderRejected'],
    );
  });

  test('preserves fill-owned fields while applying policy updates', async () => {
    const source = [
      'strategy("lot accounting ownership")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 1)',
      ')',
      'strat.begin_immediate(bar_index)',
      'strat.entry_now("First", "Cover", strategy.Direction.long, close, qty = 1.0)',
      'trade = strat.open_trade(0)',
      'trade.quantity := 2.0',
      'trade.targetPrice := 12.0',
      'updated = strat.update_open_trade(0, trade)',
      'strat.mark(close)',
      'plot(updated)',
      'plot(strat.position_quantity())',
      'plot(strat.equity())',
      'plot(strat.open_trade(0).targetPrice)',
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
