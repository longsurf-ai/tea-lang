// Purpose: Import, specialization, and CPU execution gates for the
// policy-specific trade package.

import {describe, expect, test} from 'bun:test';
import {generate} from '../codegen/codegen';
import {funcsOf} from '../ir/visit';
import {compilerSourceClosureFiles} from '../loader/loader';
import {mustBuild} from '../noder/testing';
import {csvProvider} from '../providers/data/csv';
import type {OutputSink, Value} from '../runtime/abi';
import {bind} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';
import {ObjectKind} from './object';
import {checkText, type CheckResult} from './testing';

const SPECIALIZATION_SOURCE = [
  'strategy("trade package specialization")',
  'import broker',
  'import portfolio',
  'import trade',
  'var netState = trade.net(',
  '    broker.new(processOrdersOnClose = true),',
  '    portfolio.new(initialCash = 100.0, marginLong = 0.0, marginShort = 0.0)',
  ')',
  'var lotState = trade.lots(',
  '    broker.new(),',
  '    portfolio.lots(initialCash = 100.0, maxOpenTrades = 2)',
  ')',
  'netState.begin(open, bar_index)',
  'lotState.begin_bar(close, bar_index)',
  'if bar_index == 0',
  '    netState.entry("Net", trade.Direction.long, qty = 1.0)',
  '    lotState.entry("Lot", "Reverse", trade.Direction.long, qty = 1.0)',
  'netState.end(close, barstate.islast)',
  'lotState.mark()',
  'plot(netState.snapshot().equity)',
  'plot(lotState.snapshot().equity)',
].join('\n');

interface Emission {
  readonly row: number;
  readonly oid: number;
  readonly channels: readonly Value[];
}

class Sink implements OutputSink {
  readonly emissions: Emission[] = [];

  declare(): void {}

  publish(publication: Parameters<OutputSink['publish']>[0]): void {
    for (const output of publication.outputs) {
      this.emissions.push({
        row: publication.row,
        oid: output.outputId,
        channels: [...output.channels],
      });
    }
  }
}

function tradePackage(result: CheckResult) {
  const pkg = result.checked.pkg.imports.find(
    candidate => candidate.path === 'trade',
  );
  if (pkg === undefined) {
    throw new Error('fixture did not import the trade package');
  }
  return pkg;
}

function valuesFor(sink: Sink, oid: number): readonly Value[] {
  return sink.emissions
    .filter(emission => emission.oid === oid)
    .sort((left, right) => left.row - right.row)
    .map(emission => emission.channels[0]);
}

describe('trade library', () => {
  test('registers and exports constrained policy coordinators', () => {
    const result = checkText(
      ['indicator("trade imports")', 'import trade', 'value = 1'].join('\n'),
    );

    expect(result.errors).toEqual([]);
    expect(result.checked.pkg.imports.map(pkg => pkg.path)).toEqual(
      expect.arrayContaining(['trade']),
    );
    expect([...tradePackage(result).exports.keys()].sort()).toEqual([
      'Direction',
      'LotTrade',
      'NetTrade',
      'Sizing',
      'SizingKind',
      'lots',
      'net',
      'percentOfEquity',
      'percentOfEquityAtFill',
      'targetPercentOfEquity',
      'targetQuantity',
    ]);

    const net = tradePackage(result).exports.get('NetTrade');
    const lots = tradePackage(result).exports.get('LotTrade');
    expect(net?.kind).toBe(ObjectKind.GenericUserType);
    expect(lots?.kind).toBe(ObjectKind.GenericUserType);
    if (
      net?.kind !== ObjectKind.GenericUserType ||
      lots?.kind !== ObjectKind.GenericUserType
    ) {
      throw new Error('trade package lost its generic coordinator types');
    }
    expect(net.typeParams.map(param => param.constraint.name)).toEqual([
      'ScheduledBroker',
      'NetLedger',
    ]);
    expect(lots.typeParams.map(param => param.constraint.name)).toEqual([
      'ImmediateBroker',
      'LotLedger',
    ]);
    expect(compilerSourceClosureFiles([]).map(file => file.id)).toContain(
      'builtin:trade',
    );
  });

  test('checks and nodes the scheduled/net and immediate/lot surfaces', () => {
    const result = checkText(SPECIALIZATION_SOURCE);

    expect(result.errors).toEqual([]);
    expect(
      funcsOf(mustBuild(SPECIALIZATION_SOURCE)).map(func => func.name),
    ).toEqual(
      expect.arrayContaining([
        'NetTrade<BrokerEmulator, NetPortfolio>.begin',
        'NetTrade<BrokerEmulator, NetPortfolio>.entry',
        'NetTrade<BrokerEmulator, NetPortfolio>.end',
        'NetTrade<BrokerEmulator, NetPortfolio>.snapshot',
        'LotTrade<BrokerEmulator, LotPortfolio>.begin_bar',
        'LotTrade<BrokerEmulator, LotPortfolio>.entry',
        'LotTrade<BrokerEmulator, LotPortfolio>.mark',
        'LotTrade<BrokerEmulator, LotPortfolio>.snapshot',
      ]),
    );
  });

  test('does not expose lifecycle methods from the other policy', () => {
    const result = checkText(
      [
        'strategy("segregated trade lifecycle")',
        'import broker',
        'import portfolio',
        'import trade',
        'var netState = trade.net(broker.new(), portfolio.new())',
        'var lotState = trade.lots(broker.new(), portfolio.lots())',
        'netState.close_trade("wrong", 1)',
        'lotState.cancel("wrong")',
        'lotState.open_trade(0)',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);

    expect(
      messages.some(message => message.includes('close_trade')),
    ).toBeTrue();
    expect(messages.some(message => message.includes('cancel'))).toBeTrue();
    expect(messages.some(message => message.includes('open_trade'))).toBeTrue();
  });

  test('rejects cross-policy broker and ledger composition', () => {
    const result = checkText(
      [
        'strategy("invalid trade composition")',
        'import broker',
        'import portfolio',
        'import trade',
        'badNet = trade.net(broker.new(), portfolio.lots())',
        'badLots = trade.lots(broker.new(), portfolio.new())',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);

    expect(messages).toContain(
      "LotPortfolio does not satisfy NetLedger: missing method 'apply_net'",
    );
    expect(messages).toContain(
      "NetPortfolio does not satisfy LotLedger: missing method 'apply_lot'",
    );
  });

  test('executes stable-id immediate lot entry and close on CPU', async () => {
    const source = [
      'strategy("trade lot cpu")',
      'import broker',
      'import portfolio',
      'import trade',
      'var state = trade.lots(',
      '    broker.new(),',
      '    portfolio.lots(initialCash = 100.0, maxOpenTrades = 2)',
      ')',
      'var int activeTradeId = 0',
      'state.begin_bar(close, bar_index)',
      'if bar_index == 0',
      '    execution = state.entry("Long", "Short cover", trade.Direction.long, qty = 1.0)',
      '    activeTradeId := execution.tradeId',
      'if bar_index == 1',
      '    state.close_trade("Long close", activeTradeId, close)',
      'state.mark()',
      'metrics = state.snapshot()',
      'plot(metrics.cash)',
      'plot(metrics.positionQuantity)',
      'plot(metrics.equity)',
      'plot(metrics.fillCount)',
    ].join('\n');
    const program = mustBuild(source);
    const sink = new Sink();
    const bound = await bind(loadModule(generate(program)), {
      params: {},
      provider: csvProvider(['close', '10', '12', ''].join('\n')),
      sink,
      timeNow: 0,
    });

    await bound.runAll();
    bound.dispose();

    expect(valuesFor(sink, 1)).toEqual([90, 102]);
    expect(valuesFor(sink, 2)).toEqual([1, 0]);
    expect(valuesFor(sink, 3)).toEqual([100, 102]);
    expect(valuesFor(sink, 4)).toEqual([1, 2]);
  });
});
