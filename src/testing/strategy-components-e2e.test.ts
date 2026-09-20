// Purpose: Compile-through execution coverage for the Tea-authored broker,
// portfolio, and trade libraries using an explicit source registry.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {newFileBase} from '../base/pos';
import {Errors} from '../base/print';
import {checkPackage} from '../checker/check';
import type {Program} from '../ir/program';
import {TypeKind} from '../ir/type';
import {funcsOf} from '../ir/visit';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {buildProgram} from '../noder/noder';
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

function compileComponents(source: string): Program {
  const errors = new Errors();
  const file = parse(
    newFileBase('strategy-components.tea'),
    source,
    (pos, msg) => errors.errorAt(pos, msg),
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
  return program;
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
  const compiled = compileComponents(source);
  const sink = new OutputCapture();
  // Tea has no final-bar builtin; sources that need one read a bound
  // `last_bar` parameter computed from the CSV row count.
  const rows = csv.split('\n').filter(line => line.trim() !== '').length - 1;
  await executeTestProgram(compiled, {
    params: source.includes('last_bar = input.int(0)')
      ? {last_bar: rows - 1}
      : {},
    stream: csvStream(csv),
    sink,
    timeNow: 0,
  });
  return {program: compiled, sink};
}

function valuesFor(sink: OutputCapture, oid: number): readonly unknown[] {
  return sink.emissions
    .filter(
      emission => sink.fields[emission.outputId].name === `output${oid - 1}`,
    )
    .sort((left, right) => left.row - right.row)
    .map(emission => emission.channels[0]);
}

function effectTimeline(
  program: Program,
  sink: OutputCapture,
): readonly (readonly [number, string])[] {
  return sink.effectEmissions.map(emission => {
    const type = program.outputs[emission.outputId]?.valueType;
    if (type?.kind !== TypeKind.Struct) {
      throw new Error(`effect ${emission.outputId} has no nominal payload`);
    }
    return [emission.row, type.name] as const;
  });
}

function effectField(
  program: Program,
  sink: OutputCapture,
  typeName: string,
  emissionIndex: number,
  ...path: readonly string[]
): unknown {
  const emission = sink.effectEmissions.filter(emission => {
    const type = program.outputs[emission.outputId]?.valueType;
    return type?.kind === TypeKind.Struct && type.name === typeName;
  })[emissionIndex];
  let value: unknown = emission?.payload;
  for (const name of path) {
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, name)
    ) {
      throw new Error(`effect payload cannot select '${name}'`);
    }
    value = (value as Record<string, unknown>)[name];
  }
  if (value === undefined) {
    throw new Error(`effect ${typeName}[${emissionIndex}] has no payload`);
  }
  return value;
}

// Output columns are independent; each retains its own row and append order.
function effectRowsByType(
  events: readonly (readonly [number, string])[],
): Record<string, number[]> {
  const rows: Record<string, number[]> = {};
  for (const [row, type] of events) (rows[type] ??= []).push(row);
  return rows;
}

function expectNumbersClose(
  actual: readonly unknown[],
  expected: readonly number[],
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 12);
  });
}

describe('Tea strategy components end to end', () => {
  test('keeps two configured strategy values isolated through scripted phases', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var primary = trade.nextOpen(broker.basic(), portfolio.basic(100.0))',
      'var secondary = trade.nextOpen(broker.basic(), portfolio.basic(100.0))',
      'primary.begin_bar(open, bar_index)',
      'secondary.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    primary.entry("Primary", trade.Direction.long)',
      'if bar_index == 1',
      '    secondary.entry("Secondary", trade.Direction.long)',
      'if bar_index == 2',
      '    primary.close("Primary")',
      '    secondary.close("Secondary")',
      'primary.end_bar(close, bar_index == last_bar)',
      'secondary.end_bar(close, bar_index == last_bar)',
      'emit "output0" primary.cash()',
      'emit "output1" primary.position_quantity()',
      'emit "output2" primary.snapshot().equity',
      'emit "output3" primary.snapshot().realizedPnl',
      'emit "output4" float(primary.snapshot().fillCount)',
      'emit "output5" secondary.cash()',
      'emit "output6" secondary.position_quantity()',
      'emit "output7" secondary.snapshot().equity',
      'emit "output8" secondary.snapshot().realizedPnl',
      'emit "output9" float(secondary.snapshot().fillCount)',
      'emit "output10" primary.has_pending() ? 1 : 0',
      'emit "output11" secondary.has_pending() ? 1 : 0',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '20,20', '30,30', '40,40', ''].join('\n'),
    );

    expect(funcsOf(program).map(func => func.name)).toEqual(
      expect.arrayContaining([
        'BrokerEmulator.on_open',
        'BrokerEmulator.submit',
        'BrokerEmulator.finish',
        'NetPortfolio.apply_net',
        'NetPortfolio.mark',
        'NextOpenTrade<BrokerEmulator, NetPortfolio>.begin_bar',
        'NextOpenTrade<BrokerEmulator, NetPortfolio>.entry',
        'NextOpenTrade<BrokerEmulator, NetPortfolio>.close',
        'NextOpenTrade<BrokerEmulator, NetPortfolio>.end_bar',
      ]),
    );
    expect(program.outputs.some(output => output.name === 'output0')).toBe(
      true,
    );
    expect(valuesFor(sink, 1)).toEqual([100, 0, 0, 200]);
    expect(valuesFor(sink, 2)).toEqual([0, 5, 5, 0]);
    expect(valuesFor(sink, 3)).toEqual([100, 100, 150, 200]);
    expect(valuesFor(sink, 4)).toEqual([0, 0, 0, 100]);
    expect(valuesFor(sink, 5)).toEqual([0, 1, 1, 2]);
    expectNumbersClose(valuesFor(sink, 6), [100, 100, 0, 400 / 3]);
    expectNumbersClose(valuesFor(sink, 7), [0, 0, 10 / 3, 0]);
    expectNumbersClose(valuesFor(sink, 8), [100, 100, 100, 400 / 3]);
    expectNumbersClose(valuesFor(sink, 9), [0, 0, 0, 100 / 3]);
    expect(valuesFor(sink, 10)).toEqual([0, 0, 1, 2]);
    expect(valuesFor(sink, 11)).toEqual([1, 0, 1, 0]);
    expect(valuesFor(sink, 12)).toEqual([0, 1, 1, 0]);
  });

  test('retains an entry submitted after begin until a later bar', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(broker.basic(), portfolio.basic(100.0))',
      'strat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.snapshot().fillCount',
      'emit "output1" strat.cash()',
      'emit "output2" strat.position_quantity()',
      'emit "output3" strat.has_pending() ? 1 : 0',
    ].join('\n');
    const {sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 1]);
    expect(valuesFor(sink, 2)).toEqual([100, 0]);
    expect(valuesFor(sink, 3)).toEqual([0, 10]);
    expect(valuesFor(sink, 4)).toEqual([1, 0]);
  });

  test('marks but does not forcibly liquidate an open position at end of data', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(broker.basic(), portfolio.basic(100.0))',
      'strat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().equity',
      'emit "output3" strat.snapshot().realizedPnl',
      'emit "output4" strat.snapshot().fillCount',
      'emit "output5" strat.snapshot().roundTripCount',
    ].join('\n');
    const {sink} = await execute(
      source,
      ['open,close', '10,10', '10,12', '15,15', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([100, 0, 0]);
    expect(valuesFor(sink, 2)).toEqual([0, 10, 10]);
    expect(valuesFor(sink, 3)).toEqual([100, 120, 150]);
    expect(valuesFor(sink, 4)).toEqual([0, 0, 0]);
    expect(valuesFor(sink, 5)).toEqual([0, 1, 1]);
    expect(valuesFor(sink, 6)).toEqual([0, 0, 0]);
  });

  test('fills on the next open and applies slippage, fees, and round-trip accounting', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(broker.basic(0.1, 0.1), portfolio.basic(121.0))',
      'strat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long)',
      'if bar_index == 1',
      '    strat.close("Long")',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().equity',
      'emit "output3" strat.snapshot().realizedPnl',
      'emit "output4" strat.snapshot().totalFees',
      'emit "output5" float(strat.snapshot().fillCount)',
      'emit "output6" float(strat.snapshot().roundTripCount)',
      'emit "output7" strat.snapshot().maxDrawdown',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,11', '20,18', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [121, 0, 162]);
    expectNumbersClose(valuesFor(sink, 2), [0, 10, 0]);
    expectNumbersClose(valuesFor(sink, 3), [121, 110, 162]);
    expectNumbersClose(valuesFor(sink, 4), [0, 0, 41]);
    expectNumbersClose(valuesFor(sink, 5), [0, 11, 29]);
    expect(valuesFor(sink, 6)).toEqual([0, 1, 2]);
    expect(valuesFor(sink, 7)).toEqual([0, 0, 1]);
    expect(valuesFor(sink, 8)[0]).toBe(0);
    expect(valuesFor(sink, 8)[1]).toBeCloseTo(11 / 121, 12);
    expect(valuesFor(sink, 8)[2]).toBeCloseTo(11 / 121, 12);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1],
      FillExecuted: [1, 2],
    });
  });

  test('uses explicit quantity, tick slippage, per-contract commission, and zero margin', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(',
      '    broker = broker.new(',
      '        commission = broker.commissionCashPerContract(0.25),',
      '        slippage = broker.slippageTicks(1.0, 0.5),',
      '        processOrdersOnClose = false',
      '    ),',
      '    portfolio = portfolio.new(initialCash = 5.0, pyramiding = 1, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 2.0)',
      'if bar_index == 1',
      '    strat.close("Long")',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().equity',
      'emit "output3" strat.snapshot().realizedPnl',
      'emit "output4" strat.snapshot().totalFees',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '8,8', '10,10', '20,20', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [5, -16.5, 22]);
    expectNumbersClose(valuesFor(sink, 2), [0, 2, 0]);
    expectNumbersClose(valuesFor(sink, 3), [5, 3.5, 22]);
    expectNumbersClose(valuesFor(sink, 4), [0, 0, 17]);
    expectNumbersClose(valuesFor(sink, 5), [0, 0.5, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1],
      FillExecuted: [1, 2],
    });
  });

  test('applies the configured long-margin gate only when margin is enabled', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var gated = trade.nextOpen(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 5.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'var ungated = trade.nextOpen(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 5.0, pyramiding = 1, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'gated.begin_bar(open, bar_index)',
      'ungated.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    gated.entry("Gated", trade.Direction.long, qty = 2.0)',
      '    ungated.entry("Ungated", trade.Direction.long, qty = 2.0)',
      'gated.end_bar(close, bar_index == last_bar)',
      'ungated.end_bar(close, bar_index == last_bar)',
      'emit "output0" gated.cash()',
      'emit "output1" gated.position_quantity()',
      'emit "output2" gated.snapshot().fillCount',
      'emit "output3" ungated.cash()',
      'emit "output4" ungated.position_quantity()',
      'emit "output5" ungated.snapshot().fillCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '8,8', '10,10', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [5, 5]);
    expectNumbersClose(valuesFor(sink, 2), [0, 0]);
    expect(valuesFor(sink, 3)).toEqual([0, 0]);
    expectNumbersClose(valuesFor(sink, 4), [5, -15]);
    expectNumbersClose(valuesFor(sink, 5), [0, 2]);
    expect(valuesFor(sink, 6)).toEqual([0, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0],
      OrderRejected: [1],
      FillExecuted: [1],
    });
    expect(effectField(program, sink, 'OrderRejected', 0, 'commandId')).toBe(
      'Gated',
    );
    expect(effectField(program, sink, 'OrderRejected', 0, 'reason')).toBe(
      'invalidAccountState',
    );
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'commandId'),
    ).toBe('Ungated');
  });

  test('fails closed on invalid configuration and quantity while preserving implicit sizing', async () => {
    const validBroker = 'broker.new()';
    const validPortfolio =
      'portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)';
    const sourceFor = (
      title: string,
      brokerExpression: string,
      portfolioExpression: string,
      entryCall: string,
    ) =>
      [
        `// ${title}`,
        'import broker',
        'import portfolio',
        'import trade',
        'var strat = trade.nextOpen(',
        `    broker = ${brokerExpression},`,
        `    portfolio = ${portfolioExpression}`,
        ')',
        'strat.begin_bar(open, bar_index)',
        'if bar_index == 0',
        `    ${entryCall}`,
        'strat.end_bar(close, false)',
        'emit "output0" strat.cash()',
        'emit "output1" strat.position_quantity()',
        'emit "output2" strat.snapshot().fillCount',
      ].join('\n');
    const csv = ['open,close', '8,8', '10,10', ''].join('\n');

    const invalidConfigurations = [
      {
        name: 'unsupported long margin',
        broker: validBroker,
        portfolio:
          'portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 50.0, marginShort = 100.0)',
      },
      {
        name: 'unsupported short margin',
        broker: validBroker,
        portfolio:
          'portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 50.0)',
      },
      {
        name: 'negative long margin',
        broker: validBroker,
        portfolio:
          'portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = -1.0, marginShort = 100.0)',
      },
      {
        name: 'zero initial cash',
        broker: validBroker,
        portfolio:
          'portfolio.new(initialCash = 0.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      },
      {
        name: 'negative initial cash',
        broker: validBroker,
        portfolio:
          'portfolio.new(initialCash = -1.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      },
      {
        name: 'zero pyramiding',
        broker: validBroker,
        portfolio:
          'portfolio.new(initialCash = 100.0, pyramiding = 0, marginLong = 100.0, marginShort = 100.0)',
      },
      {
        name: 'negative commission',
        broker: 'broker.new(commission = broker.commissionRate(-0.01))',
        portfolio: validPortfolio,
      },
      {
        name: 'na commission',
        broker: 'broker.new(commission = broker.commissionRate(na))',
        portfolio: validPortfolio,
      },
      {
        name: 'negative slippage',
        broker: 'broker.new(slippage = broker.slippageRate(-0.01))',
        portfolio: validPortfolio,
      },
      {
        name: 'na slippage',
        broker: 'broker.new(slippage = broker.slippageRate(na))',
        portfolio: validPortfolio,
      },
      {
        name: 'complete adverse rate',
        broker: 'broker.new(slippage = broker.slippageRate(1.0))',
        portfolio: validPortfolio,
      },
      {
        name: 'tick slippage without tick size',
        broker: 'broker.new(slippage = broker.slippageTicks(1.0, 0.0))',
        portfolio: validPortfolio,
      },
      {
        name: 'zero tick slippage with negative tick size',
        broker: 'broker.new(slippage = broker.slippageTicks(0.0, -1.0))',
        portfolio: validPortfolio,
      },
    ] as const;

    for (const scenario of invalidConfigurations) {
      const commandId = `Invalid config: ${scenario.name}`;
      const {program, sink} = await execute(
        sourceFor(
          scenario.name,
          scenario.broker,
          scenario.portfolio,
          `strat.entry("${commandId}", trade.Direction.long, qty = 1.0)`,
        ),
        csv,
      );

      expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
        OrderSubmitted: [0],
        OrderRejected: [1],
      });
      expect(effectField(program, sink, 'OrderRejected', 0, 'commandId')).toBe(
        commandId,
      );
      expect(effectField(program, sink, 'OrderRejected', 0, 'reason')).toBe(
        'invalidConfiguration',
      );
      expect(valuesFor(sink, 3)).toEqual([0, 0]);
    }

    for (const quantity of [0.0, -1.0]) {
      const commandId = `Invalid quantity: ${quantity}`;
      const {program, sink} = await execute(
        sourceFor(
          commandId,
          validBroker,
          validPortfolio,
          `strat.entry("${commandId}", trade.Direction.long, qty = ${quantity})`,
        ),
        csv,
      );

      expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
        OrderSubmitted: [0],
        OrderRejected: [1],
      });
      expect(effectField(program, sink, 'OrderRejected', 0, 'reason')).toBe(
        'invalidQuantity',
      );
      expect(valuesFor(sink, 3)).toEqual([0, 0]);
    }

    const legacyEntries = [
      {
        name: 'omitted quantity',
        call: 'strat.entry("Omitted", trade.Direction.long)',
      },
      {
        name: 'na quantity',
        call: 'strat.entry("NA", trade.Direction.long, qty = na)',
      },
    ] as const;
    for (const scenario of legacyEntries) {
      const {program, sink} = await execute(
        sourceFor(scenario.name, validBroker, validPortfolio, scenario.call),
        csv,
      );

      expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
        OrderSubmitted: [0],
        FillExecuted: [1],
      });
      expect(
        effectField(program, sink, 'FillExecuted', 0, 'fill', 'quantity'),
      ).toBe(10);
      expectNumbersClose(valuesFor(sink, 1), [100, 0]);
      expectNumbersClose(valuesFor(sink, 2), [0, 10]);
      expect(valuesFor(sink, 3)).toEqual([0, 1]);
    }
    // Many whole programs compile and run here; shared CI runners need more
    // than the default five seconds.
  }, 15_000);

  test('normalizes percent commissions to rates and charges cash per order once', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var percent = trade.nextOpen(',
      '    broker = broker.new(commission = broker.commissionPercent(1.0)),',
      '    portfolio = portfolio.new(initialCash = 1000.0, marginLong = 0.0)',
      ')',
      'var rate = trade.nextOpen(',
      '    broker = broker.new(commission = broker.commissionRate(0.01)),',
      '    portfolio = portfolio.new(initialCash = 1000.0, marginLong = 0.0)',
      ')',
      'var flat = trade.nextOpen(',
      '    broker = broker.new(commission = broker.commissionCashPerOrder(3.0)),',
      '    portfolio = portfolio.new(initialCash = 1000.0, marginLong = 0.0)',
      ')',
      'percent.begin_bar(open, bar_index)',
      'rate.begin_bar(open, bar_index)',
      'flat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    percent.entry("Percent", trade.Direction.long, qty = 2.0)',
      '    rate.entry("Rate", trade.Direction.long, qty = 2.0)',
      '    flat.entry("Flat", trade.Direction.long, qty = 2.0)',
      'if bar_index == 1',
      '    percent.close("Percent")',
      '    rate.close("Rate")',
      '    flat.close("Flat")',
      'percent.end_bar(close, bar_index == last_bar)',
      'rate.end_bar(close, bar_index == last_bar)',
      'flat.end_bar(close, bar_index == last_bar)',
      'emit "output0" percent.snapshot().totalFees',
      'emit "output1" rate.snapshot().totalFees',
      'emit "output2" percent.cash()',
      'emit "output3" rate.cash()',
      'emit "output4" flat.snapshot().totalFees',
      'emit "output5" flat.cash()',
      'emit "output6" flat.snapshot().fillCount',
      'emit "output7" flat.snapshot().realizedPnl',
    ].join('\n');
    const {sink} = await execute(
      source,
      ['open,close', '8,8', '10,10', '20,20', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [0, 0.2, 0.6]);
    expectNumbersClose(valuesFor(sink, 2), [0, 0.2, 0.6]);
    expectNumbersClose(valuesFor(sink, 3), [1000, 979.8, 1019.4]);
    expectNumbersClose(valuesFor(sink, 4), [1000, 979.8, 1019.4]);
    expectNumbersClose(valuesFor(sink, 5), [0, 3, 6]);
    expectNumbersClose(valuesFor(sink, 6), [1000, 977, 1014]);
    expect(valuesFor(sink, 7)).toEqual([0, 1, 2]);
    expectNumbersClose(valuesFor(sink, 8), [0, 0, 14]);
  });

  test('keeps next-open execution for commands submitted after close processing', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0)',
      ')',
      'strat.begin_bar(open, bar_index)',
      'strat.end_bar(close, bar_index == last_bar)',
      'if bar_index == 0',
      '    strat.entry("Late", trade.Direction.long, qty = 2.0)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().fillCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,50', '20,30', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [100, 60]);
    expectNumbersClose(valuesFor(sink, 2), [0, 2]);
    expect(valuesFor(sink, 3)).toEqual([0, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0],
      FillExecuted: [1],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'referencePrice'),
    ).toBe(20);
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'barIndex'),
    ).toBe(1);
  });

  test('fills on close and accounts for pyramided entries at weighted average cost', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 2.0)',
      'if bar_index == 1',
      '    strat.entry("Long", trade.Direction.long, qty = 3.0)',
      'if bar_index == 2',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      'if bar_index == 3',
      '    strat.close("All")',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.position_avg_price()',
      'emit "output3" strat.snapshot().equity',
      'emit "output4" strat.snapshot().realizedPnl',
      'emit "output5" strat.snapshot().fillCount',
      'emit "output6" strat.snapshot().roundTripCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '20,20', '30,30', '40,40', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [80, 20, 20, 220]);
    expectNumbersClose(valuesFor(sink, 2), [2, 5, 5, 0]);
    expect(valuesFor(sink, 3)[0]).toBe(10);
    expect(valuesFor(sink, 3)[1]).toBe(16);
    expect(valuesFor(sink, 3)[2]).toBe(16);
    expect(Number.isNaN(valuesFor(sink, 3)[3] as number)).toBe(true);
    expectNumbersClose(valuesFor(sink, 4), [100, 120, 170, 220]);
    expectNumbersClose(valuesFor(sink, 5), [0, 0, 0, 120]);
    expect(valuesFor(sink, 6)).toEqual([1, 2, 2, 3]);
    expect(valuesFor(sink, 7)).toEqual([0, 0, 0, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1, 2, 3],
      FillExecuted: [0, 1, 3],
      OrderRejected: [2],
    });
  });

  test('fails closed when an aggregate pyramid changes entry id', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("A", trade.Direction.long, qty = 1.0)',
      'if bar_index == 1',
      '    strat.entry("B", trade.Direction.long, qty = 1.0)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1, 1]);
    expect(valuesFor(sink, 2)).toEqual([1, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0],
      FillExecuted: [0],
      OrderRejected: [1],
    });
    expect(effectField(program, sink, 'OrderRejected', 0, 'reason')).toBe(
      'entryIdMismatch',
    );
  });

  test('keeps an attached stop live and applies entry before a same-bar stop', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(',
      '        commission = broker.commissionRate(0.001),',
      '        slippage = broker.slippageTicks(1.0, 1.0),',
      '        processOrdersOnClose = false',
      '    ),',
      '    portfolio = portfolio.new(initialCash = 1000.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long A", trade.Direction.long, sizing = trade.percentOfEquity(10.0))',
      '    strat.exit("Stop A", fromEntry = "Long A", stop = 9.0, activateOnEntryBar = true)',
      'if bar_index == 2',
      '    strat.entry("Long B", trade.Direction.long, sizing = trade.percentOfEquity(10.0))',
      '    strat.exit("Stop B", fromEntry = "Long B", stop = 9.0, activateOnEntryBar = true)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().equity',
      'emit "output3" strat.snapshot().realizedPnl',
      'emit "output4" strat.snapshot().fillCount',
      'emit "output5" strat.snapshot().roundTripCount',
      'emit "output6" strat.snapshot().totalFees',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '10,12,10,11',
        '7,8,6,7',
        '10,12,8,9',
        '',
      ].join('\n'),
    );

    const firstEntryNotional = 100;
    const firstEntryPrice = 11;
    const firstQuantity = firstEntryNotional / firstEntryPrice;
    const firstEntryFee = firstEntryNotional * 0.001;
    const cashAfterFirstEntry = 1000 - firstEntryNotional - firstEntryFee;
    const firstExitNotional = firstQuantity * 6;
    const firstExitFee = firstExitNotional * 0.001;
    const cashAfterFirstExit =
      cashAfterFirstEntry + firstExitNotional - firstExitFee;
    const firstRealized =
      firstQuantity * (6 - firstEntryPrice) - firstEntryFee - firstExitFee;
    const secondEntryNotional = 999.9 * 0.1;
    const secondEntryPrice = 11;
    const secondQuantity = secondEntryNotional / secondEntryPrice;
    const secondEntryFee = secondEntryNotional * 0.001;
    const secondExitNotional = secondQuantity * 8;
    const secondExitFee = secondExitNotional * 0.001;
    const finalCash =
      cashAfterFirstExit -
      secondEntryNotional -
      secondEntryFee +
      secondExitNotional -
      secondExitFee;
    const finalRealized =
      firstRealized +
      secondQuantity * (8 - secondEntryPrice) -
      secondEntryFee -
      secondExitFee;

    expectNumbersClose(valuesFor(sink, 1), [
      1000,
      cashAfterFirstEntry,
      cashAfterFirstExit,
      finalCash,
    ]);
    expectNumbersClose(valuesFor(sink, 2), [0, firstQuantity, 0, 0]);
    expectNumbersClose(valuesFor(sink, 3), [
      1000,
      999.9,
      cashAfterFirstExit,
      finalCash,
    ]);
    expectNumbersClose(valuesFor(sink, 4), [
      0,
      0,
      firstRealized,
      finalRealized,
    ]);
    expect(valuesFor(sink, 5)).toEqual([0, 1, 2, 4]);
    expect(valuesFor(sink, 6)).toEqual([0, 0, 1, 2]);
    expectNumbersClose(valuesFor(sink, 7), [
      0,
      firstEntryFee,
      firstEntryFee + firstExitFee,
      firstEntryFee + firstExitFee + secondEntryFee + secondExitFee,
    ]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 2, 2],
      FillExecuted: [1, 2, 3, 3],
    });

    // The first stop is submitted only on row 0, remains live through row 1,
    // and gaps out on row 2 at the open before one tick of adverse slippage.
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'commandId'),
    ).toBe('Stop A');
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'referencePrice'),
    ).toBe(7);
    expect(effectField(program, sink, 'FillExecuted', 1, 'fill', 'price')).toBe(
      6,
    );

    // Percent-of-equity sizing snapshots the row-1 marked equity at submission,
    // before the row-2 gap fill is reflected in the next end-of-bar mark.
    // On row 3 the entry is applied before the attached stop is matched.
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'commandId'),
    ).toBe('Long B');
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'notional'),
    ).toBeCloseTo(secondEntryNotional, 12);
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'quantity'),
    ).toBeCloseTo(secondQuantity, 12);
    expect(
      effectField(program, sink, 'FillExecuted', 3, 'fill', 'commandId'),
    ).toBe('Stop B');
    expect(
      effectField(program, sink, 'FillExecuted', 3, 'fill', 'referencePrice'),
    ).toBe(9);
    expect(effectField(program, sink, 'FillExecuted', 3, 'fill', 'price')).toBe(
      8,
    );
  });

  test('terminates the prior order when replacing an attached stop', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 9.0)',
      'if bar_index == 1',
      '    strat.exit("Stop", fromEntry = "Long", stop = 8.0)',
      'strat.end_bar(close, bar_index == last_bar)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,10,10,10', ''].join('\n'),
    );

    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 1],
      FillExecuted: [1],
      OrderCancelled: [1],
      OrderExpired: [1],
    });
    expect(
      effectField(program, sink, 'OrderCancelled', 0, 'order', 'stop'),
    ).toBe(9);
    expect(
      effectField(program, sink, 'OrderSubmitted', 2, 'order', 'stop'),
    ).toBe(8);
    expect(effectField(program, sink, 'OrderExpired', 0, 'order', 'stop')).toBe(
      8,
    );
  });

  test('cancels an attached stop after a market close fills', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'if bar_index == 1',
      '    strat.close("Manual close")',
      'strat.end_bar(close, bar_index == last_bar)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '12,12,12,12', ''].join('\n'),
    );

    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 1],
      FillExecuted: [0, 1],
      OrderCancelled: [1],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'commandId'),
    ).toBe('Manual close');
    expect(
      effectField(program, sink, 'OrderCancelled', 0, 'order', 'commandId'),
    ).toBe('Stop');
  });

  test('cancels an attached stop when its initial entry is rejected', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 50.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'strat.end_bar(close, bar_index == last_bar)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,10,10,10', ''].join('\n'),
    );

    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0],
      OrderRejected: [1],
      OrderCancelled: [1],
    });
    expect(effectField(program, sink, 'OrderRejected', 0, 'reason')).toBe(
      'invalidConfiguration',
    );
    expect(
      effectField(program, sink, 'OrderCancelled', 0, 'order', 'commandId'),
    ).toBe('Stop');
  });

  test('retains entry identity when a triggered stop is rejected', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'if bar_index == 1',
      '    strat.broker.commissionValue := 0.0',
      '    strat.exit("Replacement", fromEntry = "Long", stop = 4.0)',
      'finished = strat.end_bar(close, bar_index == last_bar)',
      'if bar_index == 0',
      '    strat.broker.commissionValue := -1.0',
      'emit "output0" strat.position_quantity()',
      'emit "output1" na(finished) or na(finished.exit) ? 0 : finished.exit.id',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '4,5,3,4', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 1],
      FillExecuted: [0],
      OrderRejected: [1],
      OrderExpired: [1],
    });
    expect(effectField(program, sink, 'OrderRejected', 0, 'reason')).toBe(
      'invalidConfiguration',
    );
    expect(
      effectField(program, sink, 'OrderSubmitted', 2, 'order', 'commandId'),
    ).toBe('Replacement');
    expect(valuesFor(sink, 2)[1]).toBe(3);
    expect(effectField(program, sink, 'OrderExpired', 0, 'order', 'id')).toBe(
      3,
    );
  });

  test('one stop closes the full same-id aggregate position', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 2.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'if bar_index == 1',
      '    strat.entry("Long", trade.Direction.long, qty = 3.0)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.position_avg_price()',
      'emit "output2" strat.cash()',
      'emit "output3" strat.snapshot().fillCount',
      'emit "output4" strat.snapshot().roundTripCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '20,20,20,20', '6,6,4,5', ''].join(
        '\n',
      ),
    );

    expect(valuesFor(sink, 1)).toEqual([2, 5, 0]);
    expect(valuesFor(sink, 2).slice(0, 2)).toEqual([10, 16]);
    expect(Number.isNaN(valuesFor(sink, 2)[2] as number)).toBe(true);
    expect(valuesFor(sink, 3)).toEqual([80, 20, 45]);
    expect(valuesFor(sink, 4)).toEqual([1, 2, 3]);
    expect(valuesFor(sink, 5)).toEqual([0, 0, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 1],
      FillExecuted: [0, 1, 2],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'commandId'),
    ).toBe('Stop');
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'quantity'),
    ).toBe(5);
  });

  test('keeps the live stop when a same-id pyramid entry is rejected', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'if bar_index == 1',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
      'emit "output2" strat.snapshot().roundTripCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '10,10,10,10',
        '10,10,4,4',
        '',
      ].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 1, 0]);
    expect(valuesFor(sink, 2)).toEqual([0, 1, 2]);
    expect(valuesFor(sink, 3)).toEqual([0, 0, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 1],
      FillExecuted: [1, 2],
      OrderRejected: [2],
    });
    expect(effectField(program, sink, 'OrderRejected', 0, 'reason')).toBe(
      'invalidAccountState',
    );
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'commandId'),
    ).toBe('Stop');
  });

  test('can re-arm immediately after an entry and attached stop fill in begin_bar', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("A", trade.Direction.long, qty = 1.0)',
      '    strat.exit("A stop", fromEntry = "A", stop = 9.0, activateOnEntryBar = true)',
      'if bar_index == 1 and strat.position_quantity() == 0.0 and not strat.has_pending_entry()',
      '    strat.entry("B", trade.Direction.long, qty = 1.0)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.snapshot().fillCount',
      'emit "output1" strat.position_quantity()',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,10,8,8', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 2]);
    expect(valuesFor(sink, 2)).toEqual([0, 0]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 1],
      FillExecuted: [1, 1],
      OrderExpired: [1],
    });
    expect(
      effectField(program, sink, 'OrderSubmitted', 2, 'order', 'commandId'),
    ).toBe('B');
    expect(
      effectField(program, sink, 'OrderExpired', 0, 'order', 'commandId'),
    ).toBe('B');
  });

  test('clears pending-entry state immediately after begin_bar fills it', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("A", trade.Direction.long, qty = 1.0)',
      '    strat.exit("A stop", fromEntry = "A", stop = 5.0)',
      'if bar_index == 1 and not strat.has_pending_entry()',
      '    strat.entry("A", trade.Direction.long, qty = 1.0)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,10,10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 1],
      FillExecuted: [1],
      OrderExpired: [1, 1],
    });
    expect(
      effectField(program, sink, 'OrderSubmitted', 2, 'order', 'commandId'),
    ).toBe('A');
  });

  test('emits rejected and final-expiry events from Tea lifecycle code', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(broker.basic(), portfolio.basic(100.0))',
      'strat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("accepted", trade.Direction.long)',
      '    strat.entry("rejected", trade.Direction.long)',
      'if bar_index == 1',
      '    strat.close("exit")',
      '    strat.entry("rejected exit", trade.Direction.long)',
      'if bar_index == 2',
      '    strat.entry("expires", trade.Direction.long)',
      'strat.end_bar(close, bar_index == last_bar)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', '20,20', ''].join('\n'),
    );

    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1, 2],
      OrderRejected: [0, 1],
      FillExecuted: [1, 2],
      OrderExpired: [2],
    });
    expect([
      effectField(program, sink, 'OrderSubmitted', 0, 'order', 'commandId'),
      effectField(program, sink, 'OrderRejected', 0, 'commandId'),
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'commandId'),
      effectField(program, sink, 'OrderSubmitted', 1, 'order', 'commandId'),
      effectField(program, sink, 'OrderRejected', 1, 'commandId'),
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'commandId'),
      effectField(program, sink, 'OrderSubmitted', 2, 'order', 'commandId'),
      effectField(program, sink, 'OrderExpired', 0, 'order', 'commandId'),
    ]).toEqual([
      'accepted',
      'rejected',
      'accepted',
      'exit',
      'rejected exit',
      'exit',
      'expires',
      'expires',
    ]);
  });

  test('lets the concrete broker report an invalid account state', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(broker.basic(), portfolio.basic(100.0))',
      'strat.begin_bar(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("first", trade.Direction.long)',
      'if bar_index == 1',
      '    strat.entry("first", trade.Direction.long)',
      'strat.end_bar(close, bar_index == last_bar)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', '10,10', ''].join('\n'),
    );

    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1],
      FillExecuted: [1],
      OrderRejected: [2],
    });
    expect(effectField(program, sink, 'OrderRejected', 0, 'commandId')).toBe(
      'first',
    );
    expect(effectField(program, sink, 'OrderRejected', 0, 'reason')).toBe(
      'invalidAccountState',
    );
  });

  test('keeps commission inside a percent-of-equity cash budget when requested', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var included = trade.ohlc(',
      '    broker = broker.new(commission = broker.commissionPercent(1.0), processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 1000.0, marginLong = 100.0)',
      ')',
      'var excluded = trade.ohlc(',
      '    broker = broker.new(commission = broker.commissionPercent(1.0), processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 1000.0, marginLong = 100.0)',
      ')',
      'included.begin_bar(open, high, low, bar_index)',
      'excluded.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    included.entry("Included", trade.Direction.long, sizing = trade.percentOfEquity(10.0, commissionIncluded = true))',
      '    excluded.entry("Excluded", trade.Direction.long, sizing = trade.percentOfEquity(10.0))',
      'included.process_close(close)',
      'excluded.process_close(close)',
      'included.mark(close)',
      'excluded.mark(close)',
      'included.finish(bar_index == last_bar)',
      'excluded.finish(bar_index == last_bar)',
      'emit "output0" included.cash()',
      'emit "output1" included.position_quantity()',
      'emit "output2" included.snapshot().totalFees',
      'emit "output3" excluded.cash()',
      'emit "output4" excluded.position_quantity()',
      'emit "output5" excluded.snapshot().totalFees',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', ''].join('\n'),
    );

    const includedBudget = 100;
    const includedQuantity = includedBudget / (10 * 1.01);
    const includedFee = includedQuantity * 10 * 0.01;
    expectNumbersClose(valuesFor(sink, 1), [900]);
    expectNumbersClose(valuesFor(sink, 2), [includedQuantity]);
    expectNumbersClose(valuesFor(sink, 3), [includedFee]);
    expectNumbersClose(valuesFor(sink, 4), [899]);
    expectNumbersClose(valuesFor(sink, 5), [10]);
    expectNumbersClose(valuesFor(sink, 6), [1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0],
      FillExecuted: [0, 0],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'notional'),
    ).toBeCloseTo(includedBudget - includedFee, 12);
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'fee'),
    ).toBeCloseTo(includedFee, 12);
  });

  test('accepts a fee-inclusive 100% cash budget without a roundoff rejection', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(commission = broker.commissionPercent(0.3), processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'strat.entry("Long", trade.Direction.long, sizing = trade.percentOfEquity(100.0, commissionIncluded = true))',
      'strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().fillCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '7.3,7.3,7.3,7.3', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [0]);
    expect(valuesFor(sink, 2)[0]).toBeGreaterThan(0);
    expect(valuesFor(sink, 3)).toEqual([1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0],
      FillExecuted: [0],
    });
  });

  test('distinguishes resting buy-stop gap, intrabar, and missed fills', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var gap = trade.ohlc(broker.new(), portfolio.new(initialCash = 100.0))',
      'var intrabar = trade.ohlc(broker.new(), portfolio.new(initialCash = 100.0))',
      'var missed = trade.ohlc(broker.new(), portfolio.new(initialCash = 100.0))',
      'gap.begin_bar(open, high, low, bar_index)',
      'intrabar.begin_bar(open, high, low, bar_index)',
      'missed.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    gap.entry("Gap", trade.Direction.long, qty = 1.0, stop = 11.0)',
      '    intrabar.entry("Intrabar", trade.Direction.long, qty = 1.0, stop = 13.0)',
      '    missed.entry("Missed", trade.Direction.long, qty = 1.0, stop = 15.0)',
      'gap.process_close(close)',
      'intrabar.process_close(close)',
      'missed.process_close(close)',
      'gap.mark(close)',
      'intrabar.mark(close)',
      'missed.mark(close)',
      'gap.finish(bar_index == last_bar)',
      'intrabar.finish(bar_index == last_bar)',
      'missed.finish(bar_index == last_bar)',
      'emit "output0" gap.cash()',
      'emit "output1" gap.position_quantity()',
      'emit "output2" intrabar.cash()',
      'emit "output3" intrabar.position_quantity()',
      'emit "output4" missed.cash()',
      'emit "output5" missed.position_quantity()',
      'emit "output6" missed.has_pending() ? 1 : 0',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '12,14,11,13', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [100, 88]);
    expectNumbersClose(valuesFor(sink, 2), [0, 1]);
    expectNumbersClose(valuesFor(sink, 3), [100, 87]);
    expectNumbersClose(valuesFor(sink, 4), [0, 1]);
    expectNumbersClose(valuesFor(sink, 5), [100, 100]);
    expectNumbersClose(valuesFor(sink, 6), [0, 0]);
    expect(valuesFor(sink, 7)).toEqual([1, 0]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 0],
      FillExecuted: [1, 1],
      OrderExpired: [1],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'commandId'),
    ).toBe('Gap');
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'referencePrice'),
    ).toBe(12);
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'orderType'),
    ).toBe('stop');
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'commandId'),
    ).toBe('Intrabar');
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'referencePrice'),
    ).toBe(13);
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'orderType'),
    ).toBe('stop');
    expect(
      effectField(program, sink, 'OrderExpired', 0, 'order', 'commandId'),
    ).toBe('Missed');
    expect(effectField(program, sink, 'OrderExpired', 0, 'order', 'stop')).toBe(
      15,
    );
  });

  test('replaces a resting buy stop and cancels its contingent bracket atomically', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(broker.new(), portfolio.new(initialCash = 100.0))',
      'strat.begin_bar(open, high, low, bar_index)',
      'int cancelled = 0',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0, stop = 12.0)',
      '    strat.exit("Bracket", fromEntry = "Long", stop = 9.0, target = 15.0)',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0, stop = 13.0)',
      'if bar_index == 1',
      '    cancelled := strat.cancel("Long")',
      'strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" cancelled',
      'emit "output1" strat.snapshot().fillCount',
      'emit "output2" strat.has_pending() ? 1 : 0',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '11,12.5,10,12', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 2]);
    expect(valuesFor(sink, 2)).toEqual([0, 0]);
    expect(valuesFor(sink, 3)).toEqual([1, 0]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 0],
      OrderCancelled: [0, 1, 1],
    });
    expect(effectField(program, sink, 'OrderSubmitted', 0, 'order', 'id')).toBe(
      1,
    );
    expect(
      effectField(program, sink, 'OrderSubmitted', 0, 'order', 'stop'),
    ).toBe(12);
    expect(
      effectField(program, sink, 'OrderSubmitted', 1, 'order', 'orderType'),
    ).toBe('bracket');
    expect(effectField(program, sink, 'OrderCancelled', 0, 'order', 'id')).toBe(
      1,
    );
    expect(effectField(program, sink, 'OrderSubmitted', 2, 'order', 'id')).toBe(
      3,
    );
    expect(
      effectField(program, sink, 'OrderSubmitted', 2, 'order', 'stop'),
    ).toBe(13);
    expect(effectField(program, sink, 'OrderCancelled', 1, 'order', 'id')).toBe(
      3,
    );
    expect(effectField(program, sink, 'OrderCancelled', 2, 'order', 'id')).toBe(
      2,
    );
  });

  test('matches one atomic stop-target bracket across gaps, touches, and a tied path', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      '    strat.exit("Bracket", fromEntry = "Long", stop = 9.0, target = 11.0)',
      'strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
    ].join('\n');
    const cases = [
      {
        name: 'stop gap',
        bar: '8,8,7,8',
        referencePrice: 8,
        orderType: 'stop',
      },
      {
        name: 'target gap',
        bar: '12,12,12,12',
        referencePrice: 12,
        orderType: 'target',
      },
      {
        name: 'stop touch',
        bar: '10,10.5,8,10',
        referencePrice: 9,
        orderType: 'stop',
      },
      {
        name: 'target touch',
        bar: '10,12,9.5,10',
        referencePrice: 11,
        orderType: 'target',
      },
      {
        name: 'both touch at equal distance',
        bar: '10,12,8,10',
        referencePrice: 9,
        orderType: 'stop',
      },
    ] as const;

    for (const scenario of cases) {
      const {program, sink} = await execute(
        source,
        ['open,high,low,close', '10,10,10,10', scenario.bar, ''].join('\n'),
      );

      expect(valuesFor(sink, 1), scenario.name).toEqual([1, 0]);
      expect(valuesFor(sink, 2), scenario.name).toEqual([1, 2]);
      expect(
        effectRowsByType(effectTimeline(program, sink)),
        scenario.name,
      ).toEqual({OrderSubmitted: [0, 0], FillExecuted: [0, 1]});
      expect(
        effectField(program, sink, 'OrderSubmitted', 1, 'order', 'orderType'),
        scenario.name,
      ).toBe('bracket');
      expect(
        effectField(program, sink, 'OrderSubmitted', 1, 'order', 'stop'),
        scenario.name,
      ).toBe(9);
      expect(
        effectField(program, sink, 'OrderSubmitted', 1, 'order', 'target'),
        scenario.name,
      ).toBe(11);
      expect(
        effectField(program, sink, 'FillExecuted', 1, 'fill', 'referencePrice'),
        scenario.name,
      ).toBe(scenario.referencePrice);
      expect(
        effectField(program, sink, 'FillExecuted', 1, 'fill', 'orderType'),
        scenario.name,
      ).toBe(scenario.orderType);
      expect(
        effectField(program, sink, 'FillExecuted', 1, 'fill', 'orderId'),
        scenario.name,
      ).toBe(effectField(program, sink, 'OrderSubmitted', 1, 'order', 'id'));
    }
  });

  test('processes a close, marks equity, and permits only one same-close reentry fill', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Seed", trade.Direction.long, qty = 1.0)',
      'if bar_index == 1',
      '    strat.close("Exit")',
      'strat.process_close(close)',
      'strat.mark(close)',
      'if bar_index == 1 and strat.position_quantity() == 0.0',
      '    strat.entry("Reentry", trade.Direction.long, sizing = trade.percentOfEquity(100.0, commissionIncluded = true))',
      'strat.process_close(close)',
      'strat.mark(close)',
      'if bar_index == 1',
      '    strat.close("Third fill is blocked")',
      'strat.process_close(close)',
      'strat.mark(close)',
      'finished = strat.finish(bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().equity',
      'emit "output3" strat.snapshot().fillCount',
      'emit "output4" na(finished) or na(finished.pending) ? 0 : finished.pending.id',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '20,20,20,20', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [90, 0]);
    expectNumbersClose(valuesFor(sink, 2), [1, 5.5]);
    expectNumbersClose(valuesFor(sink, 3), [100, 110]);
    expect(valuesFor(sink, 4)).toEqual([1, 3]);
    expect(valuesFor(sink, 5)).toEqual([0, 4]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1, 1, 1],
      FillExecuted: [0, 1, 1],
      OrderExpired: [1],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'commandId'),
    ).toBe('Exit');
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'commandId'),
    ).toBe('Reentry');
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'quantity'),
    ).toBe(5.5);
    expect(
      effectField(program, sink, 'OrderExpired', 0, 'order', 'commandId'),
    ).toBe('Third fill is blocked');
    expect(
      effectTimeline(program, sink).filter(
        ([row, type]) => row === 1 && type === 'FillExecuted',
      ),
    ).toHaveLength(2);
  });

  test('resolves target-percent rebalances at the open and preserves one pyramiding slot across adds', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.ohlc(',
      '    broker = broker.new(',
      '        commission = broker.commissionPercent(1.0),',
      '        slippage = broker.slippageTicks(1.0, 1.0)',
      '    ),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.rebalance("Allocation", trade.targetPercentOfEquity(50.0))',
      'if bar_index == 1',
      '    strat.exit("Risk stop", fromEntry = "Allocation", stop = 5.0, activateOnEntryBar = true)',
      '    strat.rebalance("Allocation", trade.targetPercentOfEquity(75.0))',
      'if bar_index == 2',
      '    strat.rebalance("Allocation", trade.targetPercentOfEquity(25.0))',
      'strat.mark(close)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().fillCount',
      'emit "output3" strat.has_pending() ? 1 : 0',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,6,10',
        '10,10,6,10',
        '10,10,6,10',
        '10,10,6,10',
        '',
      ].join('\n'),
    );

    const firstQuantity = 5;
    const firstCash = 100 - firstQuantity * 11 * 1.01;
    const secondTarget = ((firstCash + firstQuantity * 10) * 0.75) / 10;
    const secondQuantity = secondTarget - firstQuantity;
    const secondCash = firstCash - secondQuantity * 11 * 1.01;
    const thirdTarget = ((secondCash + secondTarget * 10) * 0.25) / 10;
    const thirdQuantity = secondTarget - thirdTarget;
    const thirdCash = secondCash + thirdQuantity * 9 * 0.99;

    expectNumbersClose(valuesFor(sink, 1), [
      100,
      firstCash,
      secondCash,
      thirdCash,
    ]);
    expectNumbersClose(valuesFor(sink, 2), [
      0,
      firstQuantity,
      secondTarget,
      thirdTarget,
    ]);
    expect(valuesFor(sink, 3)).toEqual([0, 1, 2, 3]);
    expect(valuesFor(sink, 4)).toEqual([1, 1, 1, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1, 1, 2],
      FillExecuted: [1, 2, 3],
    });
    expect(
      effectTimeline(program, sink).filter(
        ([, type]) => type === 'OrderCancelled',
      ),
    ).toEqual([]);
  });

  test('opens and covers a short through a symmetric atomic bracket', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Short", trade.Direction.short, qty = 4.0)',
      'strat.process_close(close)',
      'if bar_index == 0',
      '    strat.exit("Short bracket", fromEntry = "Short", stop = 12.0, target = 8.0)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().realizedPnl',
      'emit "output3" strat.snapshot().roundTripCount',
      'emit "output4" strat.snapshot().winRate',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,11,7,10', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [140, 108]);
    expectNumbersClose(valuesFor(sink, 2), [-4, 0]);
    expectNumbersClose(valuesFor(sink, 3), [0, 8]);
    expect(valuesFor(sink, 4)).toEqual([0, 1]);
    expectNumbersClose(valuesFor(sink, 5), [0, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0],
      FillExecuted: [0, 1],
    });
    expect(effectField(program, sink, 'FillExecuted', 1, 'fill', 'side')).toBe(
      'buy',
    );
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'orderType'),
    ).toBe('target');
  });

  test('applies a reversal close before resolving the opposite fill-time sizing', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 2.0)',
      'if bar_index == 1',
      '    strat.entry("Short", trade.Direction.short, sizing = trade.percentOfEquityAtFill(100.0, commissionIncluded = true))',
      '    strat.exit("Short bracket", fromEntry = "Short", stop = 30.0, target = 10.0)',
      'strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().realizedPnl',
      'emit "output3" strat.snapshot().fillCount',
      'emit "output4" strat.snapshot().roundTripCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '20,20,20,20',
        '15,16,9,12',
        '',
      ].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [80, 240, 180]);
    expectNumbersClose(valuesFor(sink, 2), [2, -6, 0]);
    expectNumbersClose(valuesFor(sink, 3), [0, 20, 80]);
    expect(valuesFor(sink, 4)).toEqual([1, 3, 4]);
    expect(valuesFor(sink, 5)).toEqual([0, 1, 2]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1, 1],
      FillExecuted: [0, 1, 1, 2],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'commandKind'),
    ).toBe('close');
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'commandKind'),
    ).toBe('entry');
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'quantity'),
    ).toBe(6);
    expect(
      effectField(program, sink, 'FillExecuted', 3, 'fill', 'orderType'),
    ).toBe('target');
  });

  test('installs a fill-derived bracket before replaying the same bar exit path', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.path(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 100.0)',
      ')',
      'primary = strat.begin_bar(open, high, low, close, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      'if not na(primary.pending)',
      '    average = strat.position_avg_price()',
      '    strat.exit("Bracket", fromEntry = "Long", stop = average - 1.0, target = average + 1.0, activateOnEntryBar = true)',
      'strat.continue_bar(open, high, low, close)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
      'emit "output2" strat.snapshot().realizedPnl',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,12,10,11', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [0, 0]);
    expect(valuesFor(sink, 2)).toEqual([0, 2]);
    expectNumbersClose(valuesFor(sink, 3), [0, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1],
      FillExecuted: [1, 1],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'orderType'),
    ).toBe('target');
  });

  test('cancels a stale same-id exit when reversing without a replacement exit', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Position", trade.Direction.long, qty = 1.0)',
      'strat.process_close(close)',
      'if bar_index == 0',
      '    strat.exit("Old bracket", fromEntry = "Position", stop = 5.0, target = 30.0)',
      'if bar_index == 1',
      '    strat.entry("Position", trade.Direction.short, qty = 1.0)',
      '    strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
      'emit "output2" strat.has_pending() ? 1 : 0',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '10,10,10,10',
        '10,40,1,10',
        '',
      ].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [1, -1, -1]);
    expect(valuesFor(sink, 2)).toEqual([1, 3, 3]);
    expect(valuesFor(sink, 3)).toEqual([1, 0, 0]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0, 1],
      FillExecuted: [0, 1, 1],
      OrderCancelled: [1],
    });
    expect(
      effectField(program, sink, 'OrderCancelled', 0, 'order', 'commandId'),
    ).toBe('Old bracket');
  });

  test('defers a capped reversal continuation exactly once to the next open', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      'if bar_index == 1',
      '    strat.entry("Short", trade.Direction.short, qty = 1.0)',
      '    strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '10,10,10,10',
        '12,12,12,12',
        '',
      ].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [0, 0, -1]);
    expect(valuesFor(sink, 2)).toEqual([0, 2, 3]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1],
      FillExecuted: [1, 1, 2],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'referencePrice'),
    ).toBe(12);
  });

  test('charges cash-per-order commission once across a split reversal', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(commission = broker.commissionCashPerOrder(5.0), processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 2.0)',
      'if bar_index == 1',
      '    strat.entry("Short", trade.Direction.short, sizing = trade.percentOfEquityAtFill(100.0, commissionIncluded = true))',
      'strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().totalFees',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '20,20,20,20', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [75, 220]);
    expectNumbersClose(valuesFor(sink, 2), [2, -5.5]);
    expectNumbersClose(valuesFor(sink, 3), [5, 10]);
    expect(effectField(program, sink, 'FillExecuted', 1, 'fill', 'fee')).toBe(
      5,
    );
    expect(effectField(program, sink, 'FillExecuted', 2, 'fill', 'fee')).toBe(
      0,
    );
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'orderId'),
    ).toBe(effectField(program, sink, 'FillExecuted', 2, 'fill', 'orderId'));
  });

  test('rejects an over-capitalized target cross and terminates an equal target', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Short", trade.Direction.short, qty = 10.0)',
      'if bar_index == 1',
      '    strat.rebalance("Cross", trade.targetQuantity(20.0))',
      'if bar_index == 2',
      '    strat.rebalance("No-op", trade.targetQuantity(-10.0))',
      'strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.snapshot().fillCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '10,10,10,10',
        '10,10,10,10',
        '',
      ].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [200, 200, 200]);
    expectNumbersClose(valuesFor(sink, 2), [-10, -10, -10]);
    expect(valuesFor(sink, 3)).toEqual([1, 1, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1, 2],
      FillExecuted: [0],
      OrderRejected: [1],
      OrderCancelled: [2],
    });
  });

  test('rejects a percent target when reference equity is nonpositive', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 20.0)',
      'if bar_index == 1',
      '    strat.rebalance("Allocation", trade.targetPercentOfEquity(50.0))',
      'strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '1,1,1,1', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [20, 20]);
    expect(valuesFor(sink, 2)).toEqual([1, 1]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1],
      FillExecuted: [0],
      OrderRejected: [1],
    });
  });

  test('keeps partial signed PnL in the trade completed by a target cross', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Short", trade.Direction.short, qty = 4.0)',
      'if bar_index == 1',
      '    strat.rebalance("Target", trade.targetQuantity(-2.0))',
      'if bar_index == 2',
      '    strat.rebalance("Target", trade.targetQuantity(1.0))',
      'if bar_index == 3',
      '    strat.close("Long close")',
      'strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.cash()',
      'emit "output1" strat.position_quantity()',
      'emit "output2" strat.position_avg_price()',
      'emit "output3" strat.snapshot().realizedPnl',
      'emit "output4" strat.snapshot().roundTripCount',
      'emit "output5" strat.snapshot().winRate',
      'emit "output6" strat.snapshot().profitFactor',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '8,8,8,8',
        '6,6,6,6',
        '5,5,5,5',
        '',
      ].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [140, 124, 106, 111]);
    expectNumbersClose(valuesFor(sink, 2), [-4, -2, 1, 0]);
    expectNumbersClose(valuesFor(sink, 3).slice(0, 3), [10, 10, 6]);
    expect(Number.isNaN(valuesFor(sink, 3)[3] as number)).toBe(true);
    expectNumbersClose(valuesFor(sink, 4), [0, 4, 12, 11]);
    expect(valuesFor(sink, 5)).toEqual([0, 0, 1, 2]);
    expectNumbersClose(valuesFor(sink, 6), [0, 0, 1, 0.5]);
    expectNumbersClose(valuesFor(sink, 7), [0, 0, 0, 12]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1, 2, 3],
      FillExecuted: [0, 1, 2, 3],
    });
  });

  test('turns SMA crossovers into next-open fills in the documented phase order', async () => {
    const source = [
      '',
      'import ta',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.nextOpen(broker.basic(), portfolio.basic(100.0))',
      'strat.begin_bar(open, bar_index)',
      'fast = ta.sma(close, 2)',
      'slow = ta.sma(close, 3)',
      'enterLong = ta.crossover(fast, slow)',
      'exitLong = ta.crossunder(fast, slow)',
      'if enterLong',
      '    strat.entry("Long", trade.Direction.long)',
      'if exitLong',
      '    strat.close("Long")',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" enterLong ? 1 : 0',
      'emit "output1" exitLong ? 1 : 0',
      'emit "output2" strat.cash()',
      'emit "output3" strat.position_quantity()',
      'emit "output4" strat.snapshot().realizedPnl',
      'emit "output5" strat.snapshot().fillCount',
      'emit "output6" strat.snapshot().roundTripCount',
    ].join('\n');
    const {sink} = await execute(
      source,
      [
        'open,close',
        '3,3',
        '2,2',
        '1,1',
        '2,2',
        '3,3',
        '2,2',
        '1,1',
        '1,1',
        '',
      ].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    expect(valuesFor(sink, 2)).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    expect(valuesFor(sink, 3)).toEqual([100, 100, 100, 100, 100, 0, 0, 50]);
    expect(valuesFor(sink, 4)).toEqual([0, 0, 0, 0, 0, 50, 50, 0]);
    expect(valuesFor(sink, 5)).toEqual([0, 0, 0, 0, 0, 0, 0, -50]);
    expect(valuesFor(sink, 6)).toEqual([0, 0, 0, 0, 0, 1, 1, 2]);
    expect(valuesFor(sink, 7)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  test('resumes an intrabar stop entry after its fill instead of replaying an earlier extreme', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.path(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, close, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0, stop = 11.0)',
      '    strat.exit("Bracket", fromEntry = "Long", stop = 9.0, target = 13.0, activateOnEntryBar = true)',
      'strat.continue_bar(open, high, low, close)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
      'emit "output2" strat.snapshot().realizedPnl',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,12,8,10', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [0, 1]);
    expect(valuesFor(sink, 2)).toEqual([0, 1]);
    expectNumbersClose(valuesFor(sink, 3), [0, 0]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0],
      FillExecuted: [1],
      OrderExpired: [1],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 0, 'fill', 'referencePrice'),
    ).toBe(11);
  });

  test('activates and updates a trailing exit only along the remaining OHLC path', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.path(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, close, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      '    strat.exit("Trail", fromEntry = "Long", activateOnEntryBar = true, trailPrice = 12.0, trailOffset = 1.0)',
      'strat.continue_bar(open, high, low, close)',
      'strat.end_bar(close, bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
      'emit "output2" strat.snapshot().realizedPnl',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '10,13,9,12.5',
        '12.5,14,12.2,12.5',
        '',
      ].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [0, 1, 0]);
    expect(valuesFor(sink, 2)).toEqual([0, 1, 2]);
    expectNumbersClose(valuesFor(sink, 3), [0, 0, 3]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 0],
      FillExecuted: [1, 2],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 1, 'fill', 'referencePrice'),
    ).toBe(13);
  });

  test('rejects a trailing exit under the ordinary whole-bar policy statically', () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'var strat = trade.ohlc(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      '    strat.exit("Trail", fromEntry = "Long", activateOnEntryBar = true, trailPrice = 12.0, trailOffset = 1.0)',
    ].join('\n');

    expect(() => compileComponents(source)).toThrow(
      /unknown argument 'trailPrice'.*OhlcTrade.*\.exit/,
    );
  });

  test('continues a path-capped reversal exactly once at the next open', async () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'last_bar = input.int(0)',
      'var strat = trade.ohlc(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", trade.Direction.long, qty = 1.0)',
      'if bar_index == 1',
      '    strat.entry("Short", trade.Direction.short, qty = 1.0)',
      '    strat.process_close(close)',
      'strat.mark(close)',
      'strat.finish(bar_index == last_bar)',
      'emit "output0" strat.position_quantity()',
      'emit "output1" strat.snapshot().fillCount',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      [
        'open,high,low,close',
        '10,10,10,10',
        '10,10,10,10',
        '12,12,12,12',
        '',
      ].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [0, 0, -1]);
    expect(valuesFor(sink, 2)).toEqual([0, 2, 3]);
    expect(effectRowsByType(effectTimeline(program, sink))).toEqual({
      OrderSubmitted: [0, 1],
      FillExecuted: [1, 1, 2],
    });
    expect(
      effectField(program, sink, 'FillExecuted', 2, 'fill', 'referencePrice'),
    ).toBe(12);
  });

  test('rejects lifecycle methods from the other trade policy statically', () => {
    const source = [
      '',
      'import broker',
      'import portfolio',
      'import trade',
      'var lots = trade.lots(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.lots(initialCash = 100.0, maxOpenTrades = 2)',
      ')',
      'var scalar = trade.nextOpen(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0)',
      ')',
      'lots.close("Scheduled close")',
      'scalar.close_trade("Immediate close", 1)',
    ].join('\n');

    expect(() => compileComponents(source)).toThrow(/close/);
  });
});
