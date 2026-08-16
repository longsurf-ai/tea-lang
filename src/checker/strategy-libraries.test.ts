// Purpose: Source-level contracts for the compiler-shipped broker, portfolio,
// and strategy packages. These fixtures exercise the ordinary import/checker
// path; no strategy component receives checker-owned lifecycle semantics.

import {describe, expect, test} from 'bun:test';
import {funcsOf} from '../ir/visit';
import {mustBuild} from '../noder/testing';
import {ObjectKind} from './object';
import {checkText} from './testing';

const ALTERNATIVE_COMPONENTS = [
  'type AlternateBroker',
  '    int marker',
  '    bool has_pending() const => false',
  '    bool has_pending_entry() const => false',
  '    broker.Order submit(broker.Command command) => na',
  '    broker.Order submit_exit(broker.Command command) => na',
  '    int cancel(string commandId) => 0',
  '    int reject(string commandId, broker.Side side, int barIndex, broker.Rejection reason) => 0',
  '    broker.Fill on_open(float referencePrice, broker.Account account, int barIndex) => na',
  '    broker.Fill match_pending(float openPrice, float highPrice, float lowPrice, broker.Account account, int barIndex) => na',
  '    broker.Fill match_path_primary(float openPrice, float highPrice, float lowPrice, float closePrice, broker.Account account, int barIndex) => na',
  '    broker.Fill continue_reversal(broker.Account account, int barIndex) => na',
  '    broker.Fill match_exit(float openPrice, float highPrice, float lowPrice, broker.Account account, int barIndex) => na',
  '    broker.Fill match_path_exit(float openPrice, float highPrice, float lowPrice, float closePrice, broker.Account account, int barIndex) => na',
  '    broker.Fill execute_now(broker.Command command, float referencePrice, broker.Account account, int barIndex) => na',
  '    broker.Fill on_close(float referencePrice, broker.Account account, int barIndex) => na',
  '    broker.FinishResult finish() => na',
  'type AlternatePortfolio',
  '    float balance',
  '    broker.Account account() const => broker.Account.new(this.balance, 0.0, 0, 1, 100.0, 100.0)',
  '    bool is_flat() const => true',
  '    float buying_power() const => this.balance',
  '    float position_quantity() const => 0.0',
  '    float position_avg_price() const => na',
  '    bool supports_open_trades() const => false',
  '    int open_trade_count() const => 0',
  '    portfolio.OpenTrade open_trade(int index) const => na',
  '    int update_open_trade(int index, portfolio.OpenTrade trade) => 0',
  '    int max_long_stack() const => 0',
  '    int max_short_stack() const => 0',
  '    portfolio.PortfolioSnapshot snapshot() const => na',
  '    int apply(broker.Fill execution) => 0',
  '    float mark(float price) => this.balance',
  '    float cash() const => this.balance',
  '    float equity() const => this.balance',
  '    float realized_pnl() const => 0.0',
  '    float total_fees() const => 0.0',
  '    int fill_count() const => 0',
  '    int round_trip_count() const => 0',
  '    float win_rate() const => 0.0',
  '    float profit_factor() const => 0.0',
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
      'BarMatches',
      'Broker',
      'BrokerCommands',
      'BrokerEmulator',
      'Command',
      'CommandKind',
      'Commission',
      'CommissionKind',
      'Fill',
      'FillExecuted',
      'FinishResult',
      'ImmediateBroker',
      'Order',
      'OrderCancelled',
      'OrderExpired',
      'OrderRejected',
      'OrderSubmitted',
      'OrderType',
      'PositionTarget',
      'PositionTargetKind',
      'Rejection',
      'ScheduledBroker',
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
      'LotLedger',
      'LotPortfolio',
      'NetLedger',
      'NetPortfolio',
      'OpenTrade',
      'Portfolio',
      'PortfolioSnapshot',
      'PortfolioView',
      'basic',
      'lots',
      'new',
    ]);
    expect([...strategy!.exports.keys()].sort()).toEqual([
      'ConfiguredStrategy',
      'Direction',
      'Sizing',
      'SizingKind',
      'Strategy',
      'configure',
      'percentOfEquity',
      'percentOfEquityAtFill',
      'targetPercentOfEquity',
      'targetQuantity',
    ]);
    const strategyContract = strategy!.exports.get('Strategy');
    expect(strategyContract?.kind).toBe(ObjectKind.Interface);
    if (strategyContract?.kind !== ObjectKind.Interface) {
      throw new Error('strategy package did not export its Strategy contract');
    }
    expect(strategyContract.methods.map(method => method.name)).toEqual([
      'entry',
      'exit',
      'close',
      'rebalance',
      'cancel',
      'position_quantity',
      'position_avg_price',
      'snapshot',
      'has_pending',
      'has_pending_entry',
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

  test('the configured implementation satisfies the exported Strategy contract', () => {
    const source = [
      'strategy("strategy contract")',
      'import broker',
      'import portfolio',
      'import strategy',
      'type Holder<S: strategy.Strategy>',
      '    S value',
      '    broker.Order submit() => this.value.entry("Long", strategy.Direction.long, na, na, na)',
      '    portfolio.PortfolioSnapshot observe() const => this.value.snapshot()',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'var holder = Holder.new(strat)',
      'submitted = holder.submit()',
      'observed = holder.observe()',
      'plot(observed.equity)',
    ].join('\n');
    const result = checkText(source);

    expect(result.errors).toEqual([]);
    expect(funcsOf(mustBuild(source)).map(func => func.name)).toEqual(
      expect.arrayContaining([
        'Holder<ConfiguredStrategy<BrokerEmulator, NetPortfolio>>.submit',
        'ConfiguredStrategy<BrokerEmulator, NetPortfolio>.entry',
        'Holder<ConfiguredStrategy<BrokerEmulator, NetPortfolio>>.observe',
        'ConfiguredStrategy<BrokerEmulator, NetPortfolio>.snapshot',
      ]),
    );
  });

  test('accepts the explicit bounded lot portfolio constructor', () => {
    const result = checkText(
      [
        'strategy("bounded lot portfolio")',
        'import broker',
        'import portfolio',
        'import strategy',
        'var strat = strategy.configure(',
        '    broker = broker.new(commission = broker.commissionRate(0.001)),',
        '    portfolio = portfolio.lots(',
        '        initialCash = 1000.0,',
        '        maxOpenTrades = 5,',
        '        marginLong = 0.0,',
        '        marginShort = 0.0',
        '    )',
        ')',
        'strat.begin_immediate(bar_index)',
        'plot(strat.open_trade_count())',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
  });

  test('checks signed entries, fill-time sizing, and typed position targets', () => {
    const result = checkText(
      [
        'strategy("signed component API")',
        'import broker',
        'import portfolio',
        'import strategy',
        'var strat = strategy.configure(',
        '    broker = broker.new(processOrdersOnClose = true),',
        '    portfolio = portfolio.new(initialCash = 100.0, marginLong = 0.0, marginShort = 0.0)',
        ')',
        'strat.begin_primary(open, high, low, bar_index)',
        'strat.process_exit(open, high, low)',
        'strat.entry("Short", strategy.Direction.short, sizing = strategy.percentOfEquityAtFill(25.0, commissionIncluded = true), stop = 9.0)',
        'strat.exit("Short bracket", fromEntry = "Short", stop = 12.0, target = 6.0, activateOnEntryBar = true)',
        'strat.rebalance("Quantity target", strategy.targetQuantity(-2.0))',
        'strat.rebalance("Percent target", strategy.targetPercentOfEquity(50.0))',
        'strat.close("Flat")',
        'strat.end(close, barstate.islast)',
        'plot(strat.win_rate())',
        'plot(strat.profit_factor())',
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
        'ConfiguredStrategy<BrokerEmulator, NetPortfolio>.begin',
        'ConfiguredStrategy<AlternateBroker, AlternatePortfolio>.begin',
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
