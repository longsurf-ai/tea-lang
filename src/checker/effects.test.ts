// Purpose: `effect.emit` is a generic checker-owned sparse-effect intrinsic
// with value and execution-context contracts, not strategy policy.

import {describe, expect, test} from 'vitest';
import {checkText} from './testing';

function messages(source: string): string[] {
  return checkText(source).errors.map(error => error.msg);
}

describe('effect.emit semantic contract', () => {
  test('accepts scalars, enums, and struct snapshots', () => {
    const result = checkText(
      [
        'enum Kind',
        '    order',
        'type Inner',
        '    string commandId',
        '    Kind kind',
        'type Event',
        '    Inner inner',
        '    int barIndex',
        'event = Event.new(Inner.new("entry", Kind.order), bar_index)',
        'emit.append "effect0" event',
        'emit.append "effect1" 1.5',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    const emits = [...result.info.emits.values()];
    expect(emits).toHaveLength(2);
    expect(emits[0].valueType.kind).toBe('Struct');
  });

  test('accepts collections, tuples and resource values; rejects untyped na', () => {
    expect(
      messages(
        [
          'values = array.from(1, 2)',
          'emit.append "effect0" values',
          'emit.append "effect1" [1, 2]',
          'line handle = na',
          'emit.append "effect2" handle',
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(messages('emit.append "effect0" na')).toContain(
      'output value needs a concrete exportable type, got na',
    );
  });

  test('rejects transitive emission from request children', () => {
    const result = messages(
      [
        'emitAndRead() =>',
        '    emit.append "effect0" close',
        '    close',
        'nested = request.security("X", "", emitAndRead())',
      ].join('\n'),
    );

    expect(result).toContain(
      "'emitAndRead' cannot call 'emit' inside a request expression",
    );
  });

  test('rejects emission from persistent initialization and bind work', () => {
    const result = messages(
      [
        'noisyInt() =>',
        '    emit.append "effect0" 1',
        '    2',
        'var int seeded = noisyInt()',
        'emit "output0" close',
      ].join('\n'),
    );

    expect(result).toContain(
      "'emit' cannot execute from a persistent variable initializer",
    );
    expect(
      messages(
        'noisy() =>\\n    emit.append "events" 1\\n    return true\\nlength = input.int(1, active=noisy())',
      ).length,
    ).toBeGreaterThan(0);
  });

  test('includes only omitted function and method defaults in transitive effect checks', () => {
    const suppliedFunction = messages(
      [
        'noisy() =>',
        '    emit.append "effect0" 1',
        '    2',
        'read(int value = noisy()) => value',
        'var int seeded = read(3)',
      ].join('\n'),
    );
    expect(suppliedFunction).toEqual([]);

    const omittedFunction = messages(
      [
        'noisy() =>',
        '    emit.append "effect0" 1',
        '    2',
        'read(int value = noisy()) => value',
        'var int seeded = read()',
      ].join('\n'),
    );
    expect(omittedFunction).toContain(
      "'emit' cannot execute from a persistent variable initializer",
    );

    const suppliedMethod = messages(
      [
        'noisy() =>',
        '    emit.append "effect0" 1',
        '    2',
        'type Box',
        '    int value',
        '    int read(int fallback = noisy()) const => this.value',
        'box = Box.new(1)',
        'var int seeded = box.read(3)',
      ].join('\n'),
    );
    expect(suppliedMethod).toEqual([]);

    const omittedMethod = messages(
      [
        'noisy() =>',
        '    emit.append "effect0" 1',
        '    2',
        'type Box',
        '    int value',
        '    int read(int fallback = noisy()) const => this.value',
        'box = Box.new(1)',
        'var int seeded = box.read()',
      ].join('\n'),
    );
    expect(omittedMethod).toContain(
      "'emit' cannot execute from a persistent variable initializer",
    );
  });

  test('includes only omitted constructor field defaults in persistent initializer checks', () => {
    const supplied = messages(
      [
        'noisy() =>',
        '    emit.append "effect0" 1',
        '    2',
        'type Box',
        '    int value = noisy()',
        'var Box state = Box.new(3)',
      ].join('\n'),
    );
    expect(supplied).toEqual([]);

    const omitted = messages(
      [
        'noisy() =>',
        '    emit.append "effect0" 1',
        '    2',
        'type Box',
        '    int value = noisy()',
        'var Box state = Box.new()',
      ].join('\n'),
    );
    expect(omitted).toContain(
      "'emit' cannot execute from a persistent variable initializer",
    );
  });

  test('emit is reserved while the removed effect namespace is ordinary', () => {
    expect(messages('emit = 1').length).toBeGreaterThan(0);
    expect(messages('effect = 1')).toEqual([]);
  });
});
