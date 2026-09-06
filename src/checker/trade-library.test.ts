// Purpose: Import, specialization, and CPU execution gates for the
// policy-specific trade package.

import {describe, expect, test} from 'vitest';
import {funcsOf} from '../ir/visit';
import {defaultRegistry} from '../loader/loader';
import {mustBuild} from '../noder/testing';
import {csvStream, executeTestProgram} from '../testing/batch';
import {OutputCapture} from '../testing/output';
import {ObjectKind} from './object';
import {checkText, type CheckResult} from './testing';

const SPECIALIZATION_SOURCE = [
  '',
  'import broker',
  'import portfolio',
  'import trade',
  'var nextOpenState = trade.nextOpen(',
  '    broker.new(processOrdersOnClose = true),',
  '    portfolio.new(initialCash = 100.0, marginLong = 0.0, marginShort = 0.0)',
  ')',
  'var ohlcState = trade.ohlc(broker.new(), portfolio.new())',
  'var pathState = trade.path(broker.new(), portfolio.new())',
  'var lotState = trade.lots(',
  '    broker.new(),',
  '    portfolio.lots(initialCash = 100.0, maxOpenTrades = 2)',
  ')',
  'nextOpenState.begin_bar(open, bar_index)',
  'ohlcState.begin_bar(open, high, low, bar_index)',
  'pathState.begin_bar(open, high, low, close, bar_index)',
  'lotState.begin_bar(close, bar_index)',
  'if bar_index == 0',
  '    nextOpenState.entry("Next", trade.Direction.long, qty = 1.0)',
  '    ohlcState.entry("OHLC", trade.Direction.long, qty = 1.0)',
  '    pathState.entry("Path", trade.Direction.long, qty = 1.0)',
  '    lotState.entry("Lot", "Reverse", trade.Direction.long, qty = 1.0)',
  'lotState.close_trade_at_stop("Lot stop", 1, broker.Side.buy, open, high, low, close)',
  'pathState.continue_bar(open, high, low, close)',
  'nextOpenState.end_bar(close, barstate.islast)',
  'ohlcState.end_bar(close, barstate.islast)',
  'pathState.end_bar(close, barstate.islast)',
  'lotState.mark()',
  'emit "output0" nextOpenState.snapshot().equity',
  'emit "output1" ohlcState.snapshot().equity',
  'emit "output2" pathState.snapshot().equity',
  'emit "output3" lotState.snapshot().equity',
].join('\n');

function tradePackage(result: CheckResult) {
  const pkg = result.checked.pkg.imports.find(
    candidate => candidate.path === 'trade',
  );
  if (pkg === undefined) {
    throw new Error('fixture did not import the trade package');
  }
  return pkg;
}

function valuesFor(sink: OutputCapture, oid: number): readonly unknown[] {
  return sink.publications.map(datum => datum[`output${oid}`]);
}

describe('trade library', () => {
  test('registers and exports constrained policy coordinators', () => {
    const result = checkText(['', 'import trade', 'value = 1'].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.checked.pkg.imports.map(pkg => pkg.path)).toEqual(
      expect.arrayContaining(['trade']),
    );
    expect([...tradePackage(result).exports.keys()].sort()).toEqual([
      'Direction',
      'LotTrade',
      'NextOpenTrade',
      'OhlcTrade',
      'PathTrade',
      'Sizing',
      'SizingKind',
      'lots',
      'nextOpen',
      'ohlc',
      'path',
      'percentOfEquity',
      'percentOfEquityAtFill',
      'targetPercentOfEquity',
      'targetQuantity',
    ]);

    const nextOpen = tradePackage(result).exports.get('NextOpenTrade');
    const ohlc = tradePackage(result).exports.get('OhlcTrade');
    const path = tradePackage(result).exports.get('PathTrade');
    const lots = tradePackage(result).exports.get('LotTrade');
    expect(nextOpen?.kind).toBe(ObjectKind.GenericStruct);
    expect(ohlc?.kind).toBe(ObjectKind.GenericStruct);
    expect(path?.kind).toBe(ObjectKind.GenericStruct);
    expect(lots?.kind).toBe(ObjectKind.GenericStruct);
    if (
      nextOpen?.kind !== ObjectKind.GenericStruct ||
      ohlc?.kind !== ObjectKind.GenericStruct ||
      path?.kind !== ObjectKind.GenericStruct ||
      lots?.kind !== ObjectKind.GenericStruct
    ) {
      throw new Error('trade package lost its generic coordinator types');
    }
    expect(nextOpen.typeParams.map(param => param.constraint.name)).toEqual([
      'NextOpenBroker',
      'NetLedger',
    ]);
    expect(ohlc.typeParams.map(param => param.constraint.name)).toEqual([
      'OhlcBroker',
      'NetLedger',
    ]);
    expect(path.typeParams.map(param => param.constraint.name)).toEqual([
      'PathBroker',
      'NetLedger',
    ]);
    expect(lots.typeParams.map(param => param.constraint.name)).toEqual([
      'ImmediateBroker',
      'LotLedger',
    ]);
    expect(defaultRegistry('trade')).toMatchObject({
      filename: 'tea-lib/trade.tea',
    });
  });

  test('checks and nodes each direct policy surface', () => {
    const result = checkText(SPECIALIZATION_SOURCE);

    expect(result.errors).toEqual([]);
    expect(
      funcsOf(mustBuild(SPECIALIZATION_SOURCE)).map(func => func.name),
    ).toEqual(
      expect.arrayContaining([
        'NextOpenTrade<BrokerEmulator, NetPortfolio>.begin_bar',
        'NextOpenTrade<BrokerEmulator, NetPortfolio>.entry',
        'NextOpenTrade<BrokerEmulator, NetPortfolio>.end_bar',
        'NextOpenTrade<BrokerEmulator, NetPortfolio>.snapshot',
        'OhlcTrade<BrokerEmulator, NetPortfolio>.begin_bar',
        'OhlcTrade<BrokerEmulator, NetPortfolio>.entry',
        'OhlcTrade<BrokerEmulator, NetPortfolio>.end_bar',
        'OhlcTrade<BrokerEmulator, NetPortfolio>.snapshot',
        'PathTrade<BrokerEmulator, NetPortfolio>.begin_bar',
        'PathTrade<BrokerEmulator, NetPortfolio>.entry',
        'PathTrade<BrokerEmulator, NetPortfolio>.continue_bar',
        'PathTrade<BrokerEmulator, NetPortfolio>.end_bar',
        'PathTrade<BrokerEmulator, NetPortfolio>.snapshot',
        'LotTrade<BrokerEmulator, LotPortfolio>.begin_bar',
        'LotTrade<BrokerEmulator, LotPortfolio>.entry',
        'LotTrade<BrokerEmulator, LotPortfolio>.close_trade_at_stop',
        'LotTrade<BrokerEmulator, LotPortfolio>.mark',
        'LotTrade<BrokerEmulator, LotPortfolio>.snapshot',
      ]),
    );
  });

  test('does not expose lifecycle methods from the other policy', () => {
    const result = checkText(
      [
        '',
        'import broker',
        'import portfolio',
        'import trade',
        'var nextOpenState = trade.nextOpen(broker.new(), portfolio.new())',
        'var ohlcState = trade.ohlc(broker.new(), portfolio.new())',
        'var pathState = trade.path(broker.new(), portfolio.new())',
        'var lotState = trade.lots(broker.new(), portfolio.lots())',
        'nextOpenState.close_trade("wrong", 1)',
        'ohlcState.continue_bar(open, high, low, close)',
        'pathState.process_close(close)',
        'lotState.cancel("wrong")',
        'lotState.open_trade(0)',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);

    expect(messages.some(message => message.includes('close_trade'))).toBe(
      true,
    );
    expect(messages.some(message => message.includes('continue_bar'))).toBe(
      true,
    );
    expect(messages.some(message => message.includes('process_close'))).toBe(
      true,
    );
    expect(messages.some(message => message.includes('cancel'))).toBe(true);
    expect(messages.some(message => message.includes('open_trade'))).toBe(true);
  });

  test('rejects cross-policy broker and ledger composition', () => {
    const result = checkText(
      [
        '',
        'import broker',
        'import portfolio',
        'import trade',
        'badNext = trade.nextOpen(broker.new(), portfolio.lots())',
        'badOhlc = trade.ohlc(broker.new(), portfolio.lots())',
        'badPath = trade.path(broker.new(), portfolio.lots())',
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
      '',
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
      '    state.close_trade("Long close", activeTradeId)',
      'state.mark()',
      'metrics = state.snapshot()',
      'emit "output0" metrics.cash',
      'emit "output1" metrics.positionQuantity',
      'emit "output2" metrics.equity',
      'emit "output3" metrics.fillCount',
    ].join('\n');
    const program = mustBuild(source);
    const sink = new OutputCapture();
    await executeTestProgram(program, {
      stream: csvStream(['close', '10', '12', ''].join('\n')),
      sink,
      timeNow: 0,
    });

    expect(valuesFor(sink, 0)).toEqual([90, 102]);
    expect(valuesFor(sink, 1)).toEqual([1, 0]);
    expect(valuesFor(sink, 2)).toEqual([100, 102]);
    expect(valuesFor(sink, 3)).toEqual([1, 2]);
  });
});
