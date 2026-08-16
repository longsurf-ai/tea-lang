// Purpose: Additive checker/noder gates for the policy-specific portfolio
// contracts while the legacy broad Portfolio contract remains available.

import {describe, expect, test} from 'bun:test';
import {funcsOf} from '../ir/visit';
import {mustBuild} from '../noder/testing';
import {ObjectKind} from './object';
import {checkText, type CheckResult} from './testing';

function importedPortfolio(result: CheckResult) {
  const pkg = result.checked.pkg.imports.find(
    candidate => candidate.path === 'portfolio',
  );
  if (pkg === undefined) {
    throw new Error('fixture did not import the portfolio package');
  }
  return pkg;
}

function contractMethods(result: CheckResult, name: string): string[] {
  const object = importedPortfolio(result).exports.get(name);
  expect(object?.kind).toBe(ObjectKind.Interface);
  if (object?.kind !== ObjectKind.Interface) {
    throw new Error(`portfolio package did not export '${name}'`);
  }
  return object.methods.map(method => method.name);
}

const SPECIALIZATION_SOURCE = [
  'indicator("portfolio policy contracts")',
  'import broker',
  'import portfolio',
  'type ViewReader<P: portfolio.PortfolioView>',
  '    P ledger',
  '    portfolio.PortfolioSnapshot observe() const => this.ledger.snapshot()',
  'type NetCoordinator<P: portfolio.NetLedger>',
  '    P ledger',
  '    int accept(broker.Fill execution) => this.ledger.apply_net(execution)',
  '    float value(float price) => this.ledger.mark(price)',
  'type LotCoordinator<P: portfolio.LotLedger>',
  '    P ledger',
  '    int accept(broker.Fill execution) => this.ledger.apply_lot(execution)',
  '    int count() const => this.ledger.open_trade_count()',
  '    portfolio.OpenTrade trade(int index) const => this.ledger.open_trade(index)',
  'var net = portfolio.new(initialCash = 1000.0)',
  'var lots = portfolio.lots(initialCash = 1000.0, maxOpenTrades = 4)',
  'var netView = ViewReader.new(net)',
  'var lotView = ViewReader.new(lots)',
  'var netCoordinator = NetCoordinator.new(net)',
  'var lotCoordinator = LotCoordinator.new(lots)',
  'netSnapshot = netView.observe()',
  'lotSnapshot = lotView.observe()',
  'netAccepted = netCoordinator.accept(na)',
  'lotAccepted = lotCoordinator.accept(na)',
  'netValue = netCoordinator.value(close)',
  'lotCount = lotCoordinator.count()',
  'lotTrade = lotCoordinator.trade(0)',
  'plot(netSnapshot.cash + lotSnapshot.cash + netValue)',
  'plot(float(netAccepted + lotAccepted + lotCount + lotTrade.id))',
].join('\n');

describe('portfolio policy contracts', () => {
  test('exports exact additive read, net-ledger, and lot-ledger surfaces', () => {
    const result = checkText(
      [
        'indicator("portfolio contracts")',
        'import portfolio',
        'value = 1',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    expect(contractMethods(result, 'PortfolioView')).toEqual([
      'cash',
      'position_quantity',
      'position_avg_price',
      'snapshot',
    ]);
    expect(contractMethods(result, 'NetLedger')).toEqual([
      'account',
      'apply_net',
      'mark',
      'cash',
      'position_quantity',
      'position_avg_price',
      'snapshot',
    ]);
    expect(contractMethods(result, 'LotLedger')).toEqual([
      'account',
      'apply_lot',
      'mark',
      'cash',
      'position_quantity',
      'position_avg_price',
      'snapshot',
      'open_trade_count',
      'open_trade',
    ]);
    expect(importedPortfolio(result).exports.has('Portfolio')).toBeFalse();
  });

  test('checks and nodes the canonical implementation for each intended policy', () => {
    const result = checkText(SPECIALIZATION_SOURCE);

    expect(result.errors).toEqual([]);
    expect(
      funcsOf(mustBuild(SPECIALIZATION_SOURCE)).map(func => func.name),
    ).toEqual(
      expect.arrayContaining([
        'ViewReader<NetPortfolio>.observe',
        'ViewReader<LotPortfolio>.observe',
        'NetCoordinator<NetPortfolio>.accept',
        'NetCoordinator<NetPortfolio>.value',
        'LotCoordinator<LotPortfolio>.accept',
        'LotCoordinator<LotPortfolio>.count',
        'LotCoordinator<LotPortfolio>.trade',
        'NetPortfolio.apply_net',
        'NetPortfolio.mark',
        'LotPortfolio.apply_lot',
        'LotPortfolio.open_trade_count',
        'LotPortfolio.open_trade',
      ]),
    );
  });

  test('rejects cross-policy ledger pairings structurally', () => {
    const netAsLots = checkText(
      [
        'indicator("net as lots")',
        'import portfolio',
        'type Holder<P: portfolio.LotLedger>',
        '    P value',
        'bad = Holder.new(portfolio.new())',
      ].join('\n'),
    );
    expect(netAsLots.errors.map(error => error.msg)).toContain(
      "NetPortfolio does not satisfy LotLedger: missing method 'apply_lot'",
    );

    const lotsAsNet = checkText(
      [
        'indicator("lots as net")',
        'import portfolio',
        'type Holder<P: portfolio.NetLedger>',
        '    P value',
        'bad = Holder.new(portfolio.lots())',
      ].join('\n'),
    );
    expect(lotsAsNet.errors.map(error => error.msg)).toContain(
      "LotPortfolio does not satisfy NetLedger: missing method 'apply_net'",
    );
  });
});
