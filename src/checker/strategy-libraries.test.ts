// Purpose: Source-level contracts for the compiler-shipped broker, portfolio,
// and strategy packages. These fixtures exercise the ordinary import/checker
// path; no strategy component receives checker-owned lifecycle semantics.

import {describe, expect, test} from 'bun:test';
import {funcsOf} from '../ir/visit';
import {mustBuild} from '../noder/testing';
import {checkText} from './testing';

const ALTERNATIVE_COMPONENTS = [
  'type AlternateBroker',
  '    int marker',
  '    bool has_pending() const => false',
  '    broker.Order submit(broker.Command command) => na',
  '    broker.Fill on_open(float referencePrice, broker.Account account, int barIndex) => na',
  '    broker.Fill on_close(float referencePrice, broker.Account account, int barIndex) => na',
  '    broker.Order finish() => na',
  'type AlternatePortfolio',
  '    float balance',
  '    broker.Account account() const => broker.Account.new(this.balance, 0.0, 0, 1, 100.0, 100.0)',
  '    bool is_flat() const => true',
  '    float buying_power() const => this.balance',
  '    float position_quantity() const => 0.0',
  '    float position_avg_price() const => na',
  '    int apply(broker.Fill execution) => 0',
  '    float mark(float price) => this.balance',
  '    float cash() const => this.balance',
  '    float equity() const => this.balance',
  '    float realized_pnl() const => 0.0',
  '    float total_fees() const => 0.0',
  '    int fill_count() const => 0',
  '    int round_trip_count() const => 0',
  '    float max_drawdown() const => 0.0',
  '    float total_return() const => 0.0',
].join('\n');

describe('Tea-authored strategy libraries', () => {
  test('exports contracts, canonical vocabulary, and basic implementations', () => {
    const result = checkText(
      [
        'strategy("component API")',
        'import broker',
        'import portfolio',
        'import strategy',
        'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
        'strat.begin(open, bar_index)',
        'strat.entry("Long", strategy.Direction.long)',
        'strat.end(close, barstate.islast)',
        'value = strat.equity()',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    const broker = result.checked.pkg.imports.find(
      pkg => pkg.path === 'broker',
    );
    const portfolio = result.checked.pkg.imports.find(
      pkg => pkg.path === 'portfolio',
    );
    const strategy = result.checked.pkg.imports.find(
      pkg => pkg.path === 'strategy',
    );
    expect([...broker!.exports.keys()].sort()).toEqual([
      'Account',
      'Broker',
      'BrokerEmulator',
      'Command',
      'CommandKind',
      'Commission',
      'CommissionKind',
      'Fill',
      'FillExecuted',
      'Order',
      'OrderExpired',
      'OrderRejected',
      'OrderSubmitted',
      'Rejection',
      'Side',
      'Slippage',
      'SlippageKind',
      'basic',
      'commissionCashPerContract',
      'commissionCashPerOrder',
      'commissionPercent',
      'commissionRate',
      'new',
      'slippagePercent',
      'slippageRate',
      'slippageTicks',
    ]);
    expect([...portfolio!.exports.keys()].sort()).toEqual([
      'NetPortfolio',
      'Portfolio',
      'basic',
      'new',
    ]);
    expect([...strategy!.exports.keys()].sort()).toEqual([
      'Direction',
      'Strategy',
      'configure',
    ]);
  });

  test('accepts the canonical named constructor shape', () => {
    const result = checkText(
      [
        'strategy("canonical constructors")',
        'import broker',
        'import portfolio',
        'import strategy',
        'var strat = strategy.configure(',
        '    broker = broker.new(',
        '        commission = broker.commissionCashPerContract(0.05),',
        '        slippage = broker.slippageTicks(1.0, 0.01),',
        '        processOrdersOnClose = true',
        '    ),',
        '    portfolio = portfolio.new(',
        '        initialCash = 30000.0,',
        '        pyramiding = 2,',
        '        marginLong = 0.0,',
        '        marginShort = 100.0',
        '    )',
        ')',
        'strat.begin(open, bar_index)',
        'strat.entry("Long", strategy.Direction.long, qty = 1.0)',
        'strat.end(close, barstate.islast)',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
  });

  test('specializes configure for alternative implicit implementations', () => {
    const result = checkText(
      [
        'strategy("alternative components")',
        'import broker',
        'import portfolio',
        'import strategy',
        ALTERNATIVE_COMPONENTS,
        'var first = strategy.configure(broker.basic(), portfolio.basic(100.0))',
        'var second = strategy.configure(AlternateBroker.new(0), AlternatePortfolio.new(50.0))',
        'first.begin(open, bar_index)',
        'second.begin(open, bar_index)',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    const program = mustBuild(
      [
        'strategy("alternative components")',
        'import broker',
        'import portfolio',
        'import strategy',
        ALTERNATIVE_COMPONENTS,
        'var first = strategy.configure(broker.basic(), portfolio.basic(100.0))',
        'var second = strategy.configure(AlternateBroker.new(0), AlternatePortfolio.new(50.0))',
        'first.begin(open, bar_index)',
        'second.begin(open, bar_index)',
      ].join('\n'),
    );
    expect(funcsOf(program).map(func => func.name)).toEqual(
      expect.arrayContaining([
        'Strategy<BrokerEmulator, NetPortfolio>.begin',
        'Strategy<AlternateBroker, AlternatePortfolio>.begin',
      ]),
    );
  });

  test('treats lifecycle methods as ordinary calls, even in a wrong order', () => {
    const result = checkText(
      [
        'strategy("ordinary lifecycle calls")',
        'import broker',
        'import portfolio',
        'import strategy',
        'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
        'strat.end(close, false)',
        'strat.close("before begin")',
        'strat.entry("also before begin", strategy.Direction.long)',
        'if close > open',
        '    strat.begin(open, bar_index)',
        'strat.end(close, true)',
        'strat.end(close, true)',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
  });

  test('keeps the strategy name exception exact to its shipped package', () => {
    const collision = checkText(
      ['strategy("header")', 'import broker as strategy'].join('\n'),
    );
    expect(collision.errors.map(error => error.msg)).toContain(
      "cannot redeclare built-in 'strategy'",
    );
  });
});
