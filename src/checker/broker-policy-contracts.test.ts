// Purpose: Policy-specific broker interfaces remain static structural views
// over the unchanged canonical BrokerEmulator implementation.

import {describe, expect, test} from 'bun:test';
import {funcsOf} from '../ir/visit';
import {mustBuild} from '../noder/testing';
import {
  ObjectKind,
  satisfies,
  type InterfaceObject,
  type UserTypeObject,
} from './object';
import {checkText, type CheckResult} from './testing';

const COMMON_METHODS = [
  'has_pending',
  'has_pending_entry',
  'submit',
  'submit_exit',
  'cancel',
] as const;

const SCHEDULED_METHODS = [
  ...COMMON_METHODS,
  'on_open',
  'match_pending',
  'match_path_primary',
  'continue_reversal',
  'match_exit',
  'match_path_exit',
  'on_close',
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

    const emulator = exportedUserType(result, 'BrokerEmulator');
    const commands = exportedInterface(result, 'BrokerCommands');
    const scheduled = exportedInterface(result, 'ScheduledBroker');
    const immediate = exportedInterface(result, 'ImmediateBroker');

    expect(commands.methods.map(method => method.name)).toEqual([
      ...COMMON_METHODS,
    ]);
    expect(scheduled.methods.map(method => method.name)).toEqual([
      ...SCHEDULED_METHODS,
    ]);
    expect(immediate.methods.map(method => method.name)).toEqual([
      'reject',
      'execute_now',
    ]);

    expect(satisfies(emulator, commands)).toBeTrue();
    expect(satisfies(emulator, scheduled)).toBeTrue();
    expect(satisfies(emulator, immediate)).toBeTrue();
  });

  test('specializes every capability view through the noder', () => {
    const source = [
      'indicator("broker policy specialization")',
      'import broker',
      'type CommandView<B: broker.BrokerCommands>',
      '    B value',
      '    bool pending() const => this.value.has_pending()',
      'type ScheduledView<B: broker.ScheduledBroker>',
      '    B value',
      '    broker.Fill match_open(float price, broker.Account account, int barIndex) => this.value.on_open(price, account, barIndex)',
      'type ImmediateView<B: broker.ImmediateBroker>',
      '    B value',
      '    broker.Fill execute(broker.Command command, float price, broker.Account account, int barIndex) => this.value.execute_now(command, price, account, barIndex)',
      'var commands = CommandView.new(broker.basic())',
      'var scheduled = ScheduledView.new(broker.basic())',
      'var immediate = ImmediateView.new(broker.basic())',
      'account = broker.Account.new(1000.0, 0.0, 0, 1, 100.0, 100.0)',
      'scheduled_fill = scheduled.match_open(open, account, bar_index)',
      'command = broker.Command.new("now", broker.CommandKind.entry, broker.Side.buy, 1.0, bar_index)',
      'immediate_fill = immediate.execute(command, open, account, bar_index)',
      'plot(commands.pending() ? 1 : 0)',
    ].join('\n');

    expect(checkText(source).errors).toEqual([]);
    expect(funcsOf(mustBuild(source)).map(func => func.name)).toEqual(
      expect.arrayContaining([
        'CommandView<BrokerEmulator>.pending',
        'ScheduledView<BrokerEmulator>.match_open',
        'ImmediateView<BrokerEmulator>.execute',
        'BrokerEmulator.has_pending',
        'BrokerEmulator.on_open',
        'BrokerEmulator.execute_now',
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

  test('rejects a scheduled broker with the wrong matching result', () => {
    const result = checkText(
      [
        'indicator("bad scheduled broker")',
        'import broker',
        'type BadScheduled',
        '    int marker',
        ...COMMON_IMPLEMENTATION,
        '    int on_open(float referencePrice, broker.Account account, int barIndex) => 0',
        'type Holder<B: broker.ScheduledBroker>',
        '    B value',
        'bad = Holder.new(BadScheduled.new(0))',
      ].join('\n'),
    );

    expect(result.errors.map(error => error.msg)).toContain(
      "BadScheduled does not satisfy ScheduledBroker: method 'on_open' returns int, want Fill",
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
        '    broker.Fill execute_now(broker.Command command, float referencePrice, broker.Account account) => na',
        'type Holder<B: broker.ImmediateBroker>',
        '    B value',
        'bad = Holder.new(BadImmediate.new(0))',
      ].join('\n'),
    );

    expect(result.errors.map(error => error.msg)).toContain(
      "BadImmediate does not satisfy ImmediateBroker: method 'execute_now' has 3 parameters, want 4",
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

function exportedUserType(result: CheckResult, name: string): UserTypeObject {
  const object = brokerPackage(result).exports.get(name);
  if (object?.kind !== ObjectKind.UserType) {
    throw new Error(`broker did not export user type '${name}'`);
  }
  return object;
}
