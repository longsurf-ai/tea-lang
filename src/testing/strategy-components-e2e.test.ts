// Purpose: Compile-through execution coverage for the Tea-authored broker,
// portfolio, and strategy libraries using an explicit source registry.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {newFileBase} from '../base/pos';
import {Errors} from '../base/print';
import {checkPackage} from '../checker/check';
import {generate} from '../codegen/codegen';
import type {Program} from '../ir/program';
import {TypeKind} from '../ir/type';
import {funcsOf} from '../ir/visit';
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

function compileComponents(source: string): {
  readonly program: Program;
  readonly js: string;
} {
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
  const js = generate(program);
  return {program, js};
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
  const sink = new Sink();
  const bound = await bind(loadModule(compiled.js), {
    params: {},
    provider: csvProvider(csv),
    sink,
    timeNow: 0,
  });
  await bound.runAll();
  bound.dispose();
  return {program: compiled.program, sink};
}

function valuesFor(sink: Sink, oid: number): readonly Value[] {
  return sink.emissions
    .filter(emission => emission.oid === oid)
    .sort((left, right) => left.row - right.row)
    .map(emission => emission.channels[0]);
}

function effectTimeline(
  program: Program,
  sink: Sink,
): readonly (readonly [number, string])[] {
  return sink.effects.map(emission => {
    const type = program.effects[emission.effectId]?.payloadType;
    if (type?.kind !== TypeKind.UserType) {
      throw new Error(`effect ${emission.effectId} has no nominal payload`);
    }
    return [emission.row, type.name] as const;
  });
}

function effectField(
  program: Program,
  sink: Sink,
  emissionIndex: number,
  ...path: readonly string[]
): EffectValue {
  const emission = sink.effects[emissionIndex];
  let type =
    emission === undefined
      ? undefined
      : program.effects[emission.effectId]?.payloadType;
  let value = emission?.payload;
  for (const name of path) {
    if (
      type?.kind !== TypeKind.UserType ||
      value === undefined ||
      typeof value !== 'object' ||
      value === null ||
      value.kind !== 'user-type'
    ) {
      throw new Error(`effect ${emissionIndex} cannot select '${name}'`);
    }
    const fieldIndex = type.fields.findIndex(field => field.name === name);
    const field = type.fields[fieldIndex];
    const fieldValue = value.fields[fieldIndex];
    if (field === undefined || fieldValue === undefined) {
      throw new Error(`effect ${emissionIndex} has no field '${name}'`);
    }
    type = field.type;
    value = fieldValue;
  }
  if (value === undefined) {
    throw new Error(`effect ${emissionIndex} has no payload`);
  }
  return value;
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

describe('Tea strategy components end to end', () => {
  test('keeps two configured strategy values isolated through scripted phases', async () => {
    const source = [
      'strategy("isolated component state")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var primary = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'var secondary = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'primary.begin(open, bar_index)',
      'secondary.begin(open, bar_index)',
      'if bar_index == 0',
      '    primary.entry("Primary", strategy.Direction.long)',
      'if bar_index == 1',
      '    secondary.entry("Secondary", strategy.Direction.long)',
      'if bar_index == 2',
      '    primary.close("Primary")',
      '    secondary.close("Secondary")',
      'primary.end(close, barstate.islast)',
      'secondary.end(close, barstate.islast)',
      'plot(primary.cash())',
      'plot(primary.position_quantity())',
      'plot(primary.equity())',
      'plot(primary.realized_pnl())',
      'plot(float(primary.fill_count()))',
      'plot(secondary.cash())',
      'plot(secondary.position_quantity())',
      'plot(secondary.equity())',
      'plot(secondary.realized_pnl())',
      'plot(float(secondary.fill_count()))',
      'plot(primary.has_pending() ? 1 : 0)',
      'plot(secondary.has_pending() ? 1 : 0)',
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
        'NetPortfolio.apply',
        'NetPortfolio.mark',
        'Strategy<BrokerEmulator, NetPortfolio>.begin',
        'Strategy<BrokerEmulator, NetPortfolio>.entry',
        'Strategy<BrokerEmulator, NetPortfolio>.close',
        'Strategy<BrokerEmulator, NetPortfolio>.end',
      ]),
    );
    expect(program.outputs[0]?.effect).toBe('strategy');
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
      'strategy("enforced next-open causality")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long)',
      'strat.end(close, barstate.islast)',
      'plot(strat.fill_count())',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.has_pending() ? 1 : 0)',
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
      'strategy("open position at end of data")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long)',
      'strat.end(close, barstate.islast)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.equity())',
      'plot(strat.realized_pnl())',
      'plot(strat.fill_count())',
      'plot(strat.round_trip_count())',
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
      'strategy("next-open accounting")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(0.1, 0.1), portfolio.basic(121.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long)',
      'if bar_index == 1',
      '    strat.close("Long")',
      'strat.end(close, barstate.islast)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.equity())',
      'plot(strat.realized_pnl())',
      'plot(strat.total_fees())',
      'plot(float(strat.fill_count()))',
      'plot(float(strat.round_trip_count()))',
      'plot(strat.max_drawdown())',
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
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [2, 'FillExecuted'],
    ]);
  });

  test('uses explicit quantity, tick slippage, per-contract commission, and zero margin', async () => {
    const source = [
      'strategy("canonical fixed-contract policy")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(',
      '        commission = broker.commissionCashPerContract(0.25),',
      '        slippage = broker.slippageTicks(1.0, 0.5),',
      '        processOrdersOnClose = false',
      '    ),',
      '    portfolio = portfolio.new(initialCash = 5.0, pyramiding = 1, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long, qty = 2.0)',
      'if bar_index == 1',
      '    strat.close("Long")',
      'strat.end(close, barstate.islast)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.equity())',
      'plot(strat.realized_pnl())',
      'plot(strat.total_fees())',
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
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [2, 'FillExecuted'],
    ]);
  });

  test('applies the configured long-margin gate only when margin is enabled', async () => {
    const source = [
      'strategy("explicit quantity margin gate")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var gated = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 5.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'var ungated = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 5.0, pyramiding = 1, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'gated.begin(open, bar_index)',
      'ungated.begin(open, bar_index)',
      'if bar_index == 0',
      '    gated.entry("Gated", strategy.Direction.long, qty = 2.0)',
      '    ungated.entry("Ungated", strategy.Direction.long, qty = 2.0)',
      'gated.end(close, barstate.islast)',
      'ungated.end(close, barstate.islast)',
      'plot(gated.cash())',
      'plot(gated.position_quantity())',
      'plot(gated.fill_count())',
      'plot(ungated.cash())',
      'plot(ungated.position_quantity())',
      'plot(ungated.fill_count())',
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
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [1, 'OrderRejected'],
      [1, 'FillExecuted'],
    ]);
    expect(effectField(program, sink, 2, 'commandId')).toBe('Gated');
    expect(effectField(program, sink, 2, 'reason')).toBe('invalidAccountState');
    expect(effectField(program, sink, 3, 'fill', 'commandId')).toBe('Ungated');
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
        `strategy("${title}")`,
        'import broker',
        'import portfolio',
        'import strategy',
        'var strat = strategy.configure(',
        `    broker = ${brokerExpression},`,
        `    portfolio = ${portfolioExpression}`,
        ')',
        'strat.begin(open, bar_index)',
        'if bar_index == 0',
        `    ${entryCall}`,
        'strat.end(close, barstate.islast)',
        'plot(strat.cash())',
        'plot(strat.position_quantity())',
        'plot(strat.fill_count())',
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
          `strat.entry("${commandId}", strategy.Direction.long, qty = 1.0)`,
        ),
        csv,
      );

      expect(effectTimeline(program, sink)).toEqual([
        [0, 'OrderSubmitted'],
        [1, 'OrderRejected'],
      ]);
      expect(effectField(program, sink, 1, 'commandId')).toBe(commandId);
      expect(effectField(program, sink, 1, 'reason')).toBe(
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
          `strat.entry("${commandId}", strategy.Direction.long, qty = ${quantity})`,
        ),
        csv,
      );

      expect(effectTimeline(program, sink)).toEqual([
        [0, 'OrderSubmitted'],
        [1, 'OrderRejected'],
      ]);
      expect(effectField(program, sink, 1, 'reason')).toBe('invalidQuantity');
      expect(valuesFor(sink, 3)).toEqual([0, 0]);
    }

    const legacyEntries = [
      {
        name: 'omitted quantity',
        call: 'strat.entry("Omitted", strategy.Direction.long)',
      },
      {
        name: 'na quantity',
        call: 'strat.entry("NA", strategy.Direction.long, qty = na)',
      },
    ] as const;
    for (const scenario of legacyEntries) {
      const {program, sink} = await execute(
        sourceFor(scenario.name, validBroker, validPortfolio, scenario.call),
        csv,
      );

      expect(effectTimeline(program, sink)).toEqual([
        [0, 'OrderSubmitted'],
        [1, 'FillExecuted'],
      ]);
      expect(effectField(program, sink, 1, 'fill', 'quantity')).toBe(10);
      expectNumbersClose(valuesFor(sink, 1), [100, 0]);
      expectNumbersClose(valuesFor(sink, 2), [0, 10]);
      expect(valuesFor(sink, 3)).toEqual([0, 1]);
    }
  });

  test('normalizes percent commissions to rates and charges cash per order once', async () => {
    const source = [
      'strategy("canonical commission policies")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var percent = strategy.configure(',
      '    broker = broker.new(commission = broker.commissionPercent(1.0)),',
      '    portfolio = portfolio.new(initialCash = 1000.0, marginLong = 0.0)',
      ')',
      'var rate = strategy.configure(',
      '    broker = broker.new(commission = broker.commissionRate(0.01)),',
      '    portfolio = portfolio.new(initialCash = 1000.0, marginLong = 0.0)',
      ')',
      'var flat = strategy.configure(',
      '    broker = broker.new(commission = broker.commissionCashPerOrder(3.0)),',
      '    portfolio = portfolio.new(initialCash = 1000.0, marginLong = 0.0)',
      ')',
      'percent.begin(open, bar_index)',
      'rate.begin(open, bar_index)',
      'flat.begin(open, bar_index)',
      'if bar_index == 0',
      '    percent.entry("Percent", strategy.Direction.long, qty = 2.0)',
      '    rate.entry("Rate", strategy.Direction.long, qty = 2.0)',
      '    flat.entry("Flat", strategy.Direction.long, qty = 2.0)',
      'if bar_index == 1',
      '    percent.close("Percent")',
      '    rate.close("Rate")',
      '    flat.close("Flat")',
      'percent.end(close, barstate.islast)',
      'rate.end(close, barstate.islast)',
      'flat.end(close, barstate.islast)',
      'plot(percent.total_fees())',
      'plot(rate.total_fees())',
      'plot(percent.cash())',
      'plot(rate.cash())',
      'plot(flat.total_fees())',
      'plot(flat.cash())',
      'plot(flat.fill_count())',
      'plot(flat.realized_pnl())',
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
      'strategy("close processing preserves next-open fallback")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0)',
      ')',
      'strat.begin(open, bar_index)',
      'strat.end(close, barstate.islast)',
      'if bar_index == 0',
      '    strat.entry("Late", strategy.Direction.long, qty = 2.0)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.fill_count())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,50', '20,30', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [100, 60]);
    expectNumbersClose(valuesFor(sink, 2), [0, 2]);
    expect(valuesFor(sink, 3)).toEqual([0, 1]);
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
    ]);
    expect(effectField(program, sink, 1, 'fill', 'referencePrice')).toBe(20);
    expect(effectField(program, sink, 1, 'fill', 'barIndex')).toBe(1);
  });

  test('fills on close and accounts for pyramided entries at weighted average cost', async () => {
    const source = [
      'strategy("canonical close fills and pyramiding")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 0.0, marginShort = 0.0)',
      ')',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long, qty = 2.0)',
      'if bar_index == 1',
      '    strat.entry("Long", strategy.Direction.long, qty = 3.0)',
      'if bar_index == 2',
      '    strat.entry("Long", strategy.Direction.long, qty = 1.0)',
      'if bar_index == 3',
      '    strat.close("All")',
      'strat.end(close, barstate.islast)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.position_avg_price())',
      'plot(strat.equity())',
      'plot(strat.realized_pnl())',
      'plot(strat.fill_count())',
      'plot(strat.round_trip_count())',
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
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [2, 'OrderSubmitted'],
      [2, 'OrderRejected'],
      [3, 'OrderSubmitted'],
      [3, 'FillExecuted'],
    ]);
  });

  test('fails closed when an aggregate pyramid changes entry id', async () => {
    const source = [
      'strategy("aggregate entry identity")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("A", strategy.Direction.long, qty = 1.0)',
      'if bar_index == 1',
      '    strat.entry("B", strategy.Direction.long, qty = 1.0)',
      'strat.end(close, barstate.islast)',
      'plot(strat.position_quantity())',
      'plot(strat.fill_count())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1, 1]);
    expect(valuesFor(sink, 2)).toEqual([1, 1]);
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'FillExecuted'],
      [1, 'OrderRejected'],
    ]);
    expect(effectField(program, sink, 2, 'reason')).toBe('entryIdMismatch');
  });

  test('keeps an attached stop live and applies entry before a same-bar stop', async () => {
    const source = [
      'strategy("scalar attached stop")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(',
      '        commission = broker.commissionRate(0.001),',
      '        slippage = broker.slippageTicks(1.0, 1.0),',
      '        processOrdersOnClose = false',
      '    ),',
      '    portfolio = portfolio.new(initialCash = 1000.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long A", strategy.Direction.long, sizing = strategy.percentOfEquity(10.0))',
      '    strat.exit("Stop A", fromEntry = "Long A", stop = 9.0, activateOnEntryBar = true)',
      'if bar_index == 2',
      '    strat.entry("Long B", strategy.Direction.long, sizing = strategy.percentOfEquity(10.0))',
      '    strat.exit("Stop B", fromEntry = "Long B", stop = 9.0, activateOnEntryBar = true)',
      'strat.end(close, barstate.islast)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.equity())',
      'plot(strat.realized_pnl())',
      'plot(strat.fill_count())',
      'plot(strat.round_trip_count())',
      'plot(strat.total_fees())',
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
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [2, 'FillExecuted'],
      [2, 'OrderSubmitted'],
      [2, 'OrderSubmitted'],
      [3, 'FillExecuted'],
      [3, 'FillExecuted'],
    ]);

    // The first stop is submitted only on row 0, remains live through row 1,
    // and gaps out on row 2 at the open before one tick of adverse slippage.
    expect(effectField(program, sink, 3, 'fill', 'commandId')).toBe('Stop A');
    expect(effectField(program, sink, 3, 'fill', 'referencePrice')).toBe(7);
    expect(effectField(program, sink, 3, 'fill', 'price')).toBe(6);

    // Percent-of-equity sizing snapshots the row-1 marked equity at submission,
    // before the row-2 gap fill is reflected in the next end-of-bar mark.
    // On row 3 the entry is applied before the attached stop is matched.
    expect(effectField(program, sink, 6, 'fill', 'commandId')).toBe('Long B');
    expect(effectField(program, sink, 6, 'fill', 'notional')).toBeCloseTo(
      secondEntryNotional,
      12,
    );
    expect(effectField(program, sink, 6, 'fill', 'quantity')).toBeCloseTo(
      secondQuantity,
      12,
    );
    expect(effectField(program, sink, 7, 'fill', 'commandId')).toBe('Stop B');
    expect(effectField(program, sink, 7, 'fill', 'referencePrice')).toBe(9);
    expect(effectField(program, sink, 7, 'fill', 'price')).toBe(8);
  });

  test('terminates the prior order when replacing an attached stop', async () => {
    const source = [
      'strategy("replace attached stop")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 9.0)',
      'if bar_index == 1',
      '    strat.exit("Stop", fromEntry = "Long", stop = 8.0)',
      'strat.end(close, barstate.islast)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,10,10,10', ''].join('\n'),
    );

    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderCancelled'],
      [1, 'OrderSubmitted'],
      [1, 'OrderExpired'],
    ]);
    expect(effectField(program, sink, 3, 'order', 'stop')).toBe(9);
    expect(effectField(program, sink, 4, 'order', 'stop')).toBe(8);
    expect(effectField(program, sink, 5, 'order', 'stop')).toBe(8);
  });

  test('cancels an attached stop after a market close fills', async () => {
    const source = [
      'strategy("close cancels stop")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'if bar_index == 1',
      '    strat.close("Manual close")',
      'strat.end(close, barstate.islast)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '12,12,12,12', ''].join('\n'),
    );

    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [0, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderCancelled'],
    ]);
    expect(effectField(program, sink, 4, 'fill', 'commandId')).toBe(
      'Manual close',
    );
    expect(effectField(program, sink, 5, 'order', 'commandId')).toBe('Stop');
  });

  test('cancels an attached stop when its initial entry is rejected', async () => {
    const source = [
      'strategy("rejected entry cancels stop")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 50.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'strat.end(close, barstate.islast)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,10,10,10', ''].join('\n'),
    );

    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [1, 'OrderRejected'],
      [1, 'OrderCancelled'],
    ]);
    expect(effectField(program, sink, 2, 'reason')).toBe(
      'invalidConfiguration',
    );
    expect(effectField(program, sink, 3, 'order', 'commandId')).toBe('Stop');
  });

  test('retains entry identity when a triggered stop is rejected', async () => {
    const source = [
      'strategy("rejected stop keeps identity")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'if bar_index == 1',
      '    strat.broker.commissionValue := 0.0',
      '    strat.exit("Replacement", fromEntry = "Long", stop = 4.0)',
      'finished = strat.end(close, barstate.islast)',
      'if bar_index == 0',
      '    strat.broker.commissionValue := -1.0',
      'plot(strat.position_quantity())',
      'plot(na(finished) or na(finished.exit) ? 0 : finished.exit.id)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '4,5,3,4', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([1, 1]);
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [0, 'FillExecuted'],
      [1, 'OrderRejected'],
      [1, 'OrderSubmitted'],
      [1, 'OrderExpired'],
    ]);
    expect(effectField(program, sink, 3, 'reason')).toBe(
      'invalidConfiguration',
    );
    expect(effectField(program, sink, 4, 'order', 'commandId')).toBe(
      'Replacement',
    );
    expect(valuesFor(sink, 2)[1]).toBe(3);
    expect(effectField(program, sink, 5, 'order', 'id')).toBe(3);
  });

  test('one stop closes the full same-id aggregate position', async () => {
    const source = [
      'strategy("aggregate attached stop")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(processOrdersOnClose = true),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long, qty = 2.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'if bar_index == 1',
      '    strat.entry("Long", strategy.Direction.long, qty = 3.0)',
      'strat.end(close, barstate.islast)',
      'plot(strat.position_quantity())',
      'plot(strat.position_avg_price())',
      'plot(strat.cash())',
      'plot(strat.fill_count())',
      'plot(strat.round_trip_count())',
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
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [0, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [2, 'FillExecuted'],
    ]);
    expect(effectField(program, sink, 5, 'fill', 'commandId')).toBe('Stop');
    expect(effectField(program, sink, 5, 'fill', 'quantity')).toBe(5);
  });

  test('keeps the live stop when a same-id pyramid entry is rejected', async () => {
    const source = [
      'strategy("rejected pyramid keeps stop")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long, qty = 1.0)',
      '    strat.exit("Stop", fromEntry = "Long", stop = 5.0)',
      'if bar_index == 1',
      '    strat.entry("Long", strategy.Direction.long, qty = 1.0)',
      'strat.end(close, barstate.islast)',
      'plot(strat.position_quantity())',
      'plot(strat.fill_count())',
      'plot(strat.round_trip_count())',
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
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [2, 'OrderRejected'],
      [2, 'FillExecuted'],
    ]);
    expect(effectField(program, sink, 4, 'reason')).toBe('invalidAccountState');
    expect(effectField(program, sink, 5, 'fill', 'commandId')).toBe('Stop');
  });

  test('can re-arm immediately after an entry and attached stop fill in begin_bar', async () => {
    const source = [
      'strategy("same-bar stop rearm")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 1, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("A", strategy.Direction.long, qty = 1.0)',
      '    strat.exit("A stop", fromEntry = "A", stop = 9.0, activateOnEntryBar = true)',
      'if bar_index == 1 and strat.position_quantity() == 0.0 and not strat.has_pending_entry()',
      '    strat.entry("B", strategy.Direction.long, qty = 1.0)',
      'strat.end(close, barstate.islast)',
      'plot(strat.fill_count())',
      'plot(strat.position_quantity())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,10,8,8', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 2]);
    expect(valuesFor(sink, 2)).toEqual([0, 0]);
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [1, 'OrderExpired'],
    ]);
    expect(effectField(program, sink, 4, 'order', 'commandId')).toBe('B');
    expect(effectField(program, sink, 5, 'order', 'commandId')).toBe('B');
  });

  test('clears pending-entry state immediately after begin_bar fills it', async () => {
    const source = [
      'strategy("post-fill pending state")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(',
      '    broker = broker.new(),',
      '    portfolio = portfolio.new(initialCash = 100.0, pyramiding = 2, marginLong = 100.0, marginShort = 100.0)',
      ')',
      'strat.begin_bar(open, high, low, bar_index)',
      'if bar_index == 0',
      '    strat.entry("A", strategy.Direction.long, qty = 1.0)',
      '    strat.exit("A stop", fromEntry = "A", stop = 5.0)',
      'if bar_index == 1 and not strat.has_pending_entry()',
      '    strat.entry("A", strategy.Direction.long, qty = 1.0)',
      'strat.end(close, barstate.islast)',
      'plot(strat.position_quantity())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,high,low,close', '10,10,10,10', '10,10,10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 1]);
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [1, 'OrderExpired'],
      [1, 'OrderExpired'],
    ]);
    expect(effectField(program, sink, 3, 'order', 'commandId')).toBe('A');
  });

  test('emits rejected and final-expiry events from Tea lifecycle code', async () => {
    const source = [
      'strategy("effect lifecycle")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("accepted", strategy.Direction.long)',
      '    strat.entry("rejected", strategy.Direction.long)',
      'if bar_index == 1',
      '    strat.close("exit")',
      '    strat.entry("rejected exit", strategy.Direction.long)',
      'if bar_index == 2',
      '    strat.entry("expires", strategy.Direction.long)',
      'strat.end(close, barstate.islast)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', '20,20', ''].join('\n'),
    );

    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderRejected'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [1, 'OrderRejected'],
      [2, 'FillExecuted'],
      [2, 'OrderSubmitted'],
      [2, 'OrderExpired'],
    ]);
    expect([
      effectField(program, sink, 0, 'order', 'commandId'),
      effectField(program, sink, 1, 'commandId'),
      effectField(program, sink, 2, 'fill', 'commandId'),
      effectField(program, sink, 3, 'order', 'commandId'),
      effectField(program, sink, 4, 'commandId'),
      effectField(program, sink, 5, 'fill', 'commandId'),
      effectField(program, sink, 6, 'order', 'commandId'),
      effectField(program, sink, 7, 'order', 'commandId'),
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
      'strategy("broker rejection ownership")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("first", strategy.Direction.long)',
      'if bar_index == 1',
      '    strat.entry("first", strategy.Direction.long)',
      'strat.end(close, barstate.islast)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', '10,10', ''].join('\n'),
    );

    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [2, 'OrderRejected'],
    ]);
    expect(effectField(program, sink, 3, 'commandId')).toBe('first');
    expect(effectField(program, sink, 3, 'reason')).toBe('invalidAccountState');
  });

  test('turns SMA crossovers into next-open fills in the documented phase order', async () => {
    const source = [
      'strategy("SMA crossover lifecycle")',
      'import ta',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'fast = ta.sma(close, 2)',
      'slow = ta.sma(close, 3)',
      'enterLong = ta.crossover(fast, slow)',
      'exitLong = ta.crossunder(fast, slow)',
      'if enterLong',
      '    strat.entry("Long", strategy.Direction.long)',
      'if exitLong',
      '    strat.close("Long")',
      'strat.end(close, barstate.islast)',
      'plot(enterLong ? 1 : 0)',
      'plot(exitLong ? 1 : 0)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.realized_pnl())',
      'plot(strat.fill_count())',
      'plot(strat.round_trip_count())',
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
});
