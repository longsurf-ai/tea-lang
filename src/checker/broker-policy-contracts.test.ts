// Purpose: Policy-specific broker interfaces remain static structural views
// over the unchanged canonical BrokerEmulator implementation.

import {describe, expect, test} from 'vitest';
import {funcsOf} from '../ir/visit';
import {mustBuild} from '../noder/testing';
import {
  ObjectKind,
  satisfies,
  type InterfaceObject,
  type StructObject,
} from './object';
import {checkText, type CheckResult} from './testing';

const COMMON_METHODS = [
  'has_pending',
  'has_pending_entry',
  'submit',
  'submit_exit',
  'cancel',
] as const;

const NEXT_OPEN_METHODS = [
  'has_pending',
  'has_pending_entry',
  'submit',
  'cancel',
  'on_open',
  'continue_reversal',
  'on_close',
  'finish',
] as const;

const OHLC_METHODS = [
  ...COMMON_METHODS,
  'match_pending',
  'continue_reversal',
  'match_exit',
  'on_close',
  'finish',
] as const;

const PATH_METHODS = [
  ...COMMON_METHODS,
  'match_path_primary',
  'continue_reversal',
  'match_path_exit',
  'finish',
] as const;

const COMMON_IMPLEMENTATION = [
  '    bool has_pending() const => false',
  '    bool has_pending_entry() const => false',
  '    broker.Order submit(broker.Command command) => na',
  '    broker.Order submit_exit(broker.Command command) => na',
  '    int cancel(string commandId) => 0',
] as const;

describe('broker policy contracts', () => {
  test('exports honest structural views satisfied by BrokerEmulator', () => {
    const result = checkText(
      ['indicator("broker policy contracts")', 'import broker'].join('\n'),
    );
    expect(result.errors).toEqual([]);

    const emulator = exportedStruct(result, 'BrokerEmulator');
    const commands = exportedInterface(result, 'BrokerCommands');
    const nextOpen = exportedInterface(result, 'NextOpenBroker');
    const ohlc = exportedInterface(result, 'OhlcBroker');
    const path = exportedInterface(result, 'PathBroker');
    const immediate = exportedInterface(result, 'ImmediateBroker');

    expect(commands.methods.map(method => method.name)).toEqual([
      ...COMMON_METHODS,
    ]);
    expect(nextOpen.methods.map(method => method.name)).toEqual([
      ...NEXT_OPEN_METHODS,
    ]);
    expect(ohlc.methods.map(method => method.name)).toEqual([...OHLC_METHODS]);
    expect(path.methods.map(method => method.name)).toEqual([...PATH_METHODS]);
    expect(immediate.methods.map(method => method.name)).toEqual([
      'reject',
      'stop_touched',
      'execute_at_close',
      'execute_if_stop_touched',
    ]);

    expect(satisfies(emulator, commands)).toBe(true);
    expect(satisfies(emulator, nextOpen)).toBe(true);
    expect(satisfies(emulator, ohlc)).toBe(true);
    expect(satisfies(emulator, path)).toBe(true);
    expect(satisfies(emulator, immediate)).toBe(true);
  });

  test('specializes every capability view through the noder', () => {
    const source = [
      'indicator("broker policy specialization")',
      'import broker',
      'type CommandView<B: broker.BrokerCommands>',
      '    B value',
      '    bool pending() const => this.value.has_pending()',
      'type NextOpenView<B: broker.NextOpenBroker>',
      '    B value',
      '    broker.Fill match_open(float price, broker.Account account, int barIndex) => this.value.on_open(price, account, barIndex)',
      'type OhlcView<B: broker.OhlcBroker>',
      '    B value',
      '    broker.Fill match_bar(float openPrice, float highPrice, float lowPrice, broker.Account account, int barIndex) => this.value.match_pending(openPrice, highPrice, lowPrice, account, barIndex)',
      'type PathView<B: broker.PathBroker>',
      '    B value',
      '    broker.Fill match_path(float openPrice, float highPrice, float lowPrice, float closePrice, broker.Account account, int barIndex) => this.value.match_path_primary(openPrice, highPrice, lowPrice, closePrice, account, barIndex)',
      'type ImmediateView<B: broker.ImmediateBroker>',
      '    B value',
      '    bool stop_touched(broker.Side closeSide, float highPrice, float lowPrice, float stopPrice) const => this.value.stop_touched(closeSide, highPrice, lowPrice, stopPrice)',
      '    broker.Fill execute_close(broker.Command command, float closePrice, broker.Account account, int barIndex) => this.value.execute_at_close(command, closePrice, account, barIndex)',
      '    broker.Fill execute_stop(broker.Command command, float openPrice, float highPrice, float lowPrice, float stopPrice, broker.Account account, int barIndex) => this.value.execute_if_stop_touched(command, openPrice, highPrice, lowPrice, stopPrice, account, barIndex)',
      'var commands = CommandView.new(broker.basic())',
      'var nextOpen = NextOpenView.new(broker.basic())',
      'var ohlc = OhlcView.new(broker.basic())',
      'var path = PathView.new(broker.basic())',
      'var immediate = ImmediateView.new(broker.basic())',
      'account = broker.Account.new(1000.0, 0.0, 0, 1, 100.0, 100.0)',
      'next_open_fill = nextOpen.match_open(open, account, bar_index)',
      'ohlc_fill = ohlc.match_bar(open, high, low, account, bar_index)',
      'path_fill = path.match_path(open, high, low, close, account, bar_index)',
      'command = broker.Command.new("now", broker.CommandKind.entry, broker.Side.buy, 1.0, bar_index)',
      'close_fill = immediate.execute_close(command, close, account, bar_index)',
      'stop_command = broker.Command.new("stop", broker.CommandKind.close, broker.Side.sell, 1.0, bar_index, tradeId = 1)',
      'stop_fill = immediate.execute_stop(stop_command, open, high, low, close, account, bar_index)',
      'stop_touched = immediate.stop_touched(broker.Side.sell, high, low, close)',
      'plot(commands.pending() ? 1 : 0)',
    ].join('\n');

    expect(checkText(source).errors).toEqual([]);
    expect(funcsOf(mustBuild(source)).map(func => func.name)).toEqual(
      expect.arrayContaining([
        'CommandView<BrokerEmulator>.pending',
        'NextOpenView<BrokerEmulator>.match_open',
        'OhlcView<BrokerEmulator>.match_bar',
        'PathView<BrokerEmulator>.match_path',
        'ImmediateView<BrokerEmulator>.execute_close',
        'ImmediateView<BrokerEmulator>.execute_stop',
        'ImmediateView<BrokerEmulator>.stop_touched',
        'BrokerEmulator.has_pending',
        'BrokerEmulator.on_open',
        'BrokerEmulator.match_pending',
        'BrokerEmulator.match_path_primary',
        'BrokerEmulator.execute_at_close',
        'BrokerEmulator.execute_if_stop_touched',
        'BrokerEmulator.stop_touched',
      ]),
    );
  });

  test('rejects a common command view with the wrong receiver mode', () => {
    const result = checkText(
      [
        'indicator("bad command broker")',
        'import broker',
        'type BadCommands',
        '    int marker',
        '    bool has_pending() => false',
        ...COMMON_IMPLEMENTATION.slice(1),
        'type Holder<B: broker.BrokerCommands>',
        '    B value',
        'bad = Holder.new(BadCommands.new(0))',
      ].join('\n'),
    );

    expect(result.errors.map(error => error.msg)).toContain(
      "BadCommands does not satisfy BrokerCommands: method 'has_pending' has mutable receiver, want const",
    );
  });

  test('rejects a next-open broker with the wrong matching result', () => {
    const result = checkText(
      [
        'indicator("bad next-open broker")',
        'import broker',
        'type BadNextOpen',
        '    int marker',
        ...COMMON_IMPLEMENTATION.filter(line => !line.includes('submit_exit')),
        '    int on_open(float referencePrice, broker.Account account, int barIndex) => 0',
        'type Holder<B: broker.NextOpenBroker>',
        '    B value',
        'bad = Holder.new(BadNextOpen.new(0))',
      ].join('\n'),
    );

    expect(result.errors.map(error => error.msg)).toContain(
      "BadNextOpen does not satisfy NextOpenBroker: method 'on_open' returns int, want Fill",
    );
  });

  test('rejects an immediate broker with the wrong execution arity', () => {
    const result = checkText(
      [
        'indicator("bad immediate broker")',
        'import broker',
        'type BadImmediate',
        '    int marker',
        '    int reject(string commandId, broker.Side side, int barIndex, broker.Rejection reason) => 0',
        '    bool stop_touched(broker.Side closeSide, float highPrice, float lowPrice, float stopPrice) const => false',
        '    broker.Fill execute_at_close(broker.Command command, float closePrice, broker.Account account) => na',
        '    broker.Fill execute_if_stop_touched(broker.Command command, float openPrice, float highPrice, float lowPrice, float stopPrice, broker.Account account, int barIndex) => na',
        'type Holder<B: broker.ImmediateBroker>',
        '    B value',
        'bad = Holder.new(BadImmediate.new(0))',
      ].join('\n'),
    );

    expect(result.errors.map(error => error.msg)).toContain(
      "BadImmediate does not satisfy ImmediateBroker: method 'execute_at_close' has 3 parameters, want 4",
    );
  });
});

function brokerPackage(result: CheckResult) {
  const pkg = result.checked.pkg.imports.find(
    candidate => candidate.path === 'broker',
  );
  if (pkg === undefined) throw new Error('fixture did not import broker');
  return pkg;
}

function exportedInterface(result: CheckResult, name: string): InterfaceObject {
  const object = brokerPackage(result).exports.get(name);
  if (object?.kind !== ObjectKind.Interface) {
    throw new Error(`broker did not export interface '${name}'`);
  }
  return object;
}

function exportedStruct(result: CheckResult, name: string): StructObject {
  const object = brokerPackage(result).exports.get(name);
  if (object?.kind !== ObjectKind.Struct) {
    throw new Error(`broker did not export struct '${name}'`);
  }
  return object;
}
