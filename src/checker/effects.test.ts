// Purpose: `effect.emit` is a generic checker-owned sparse-effect intrinsic
// with fixed-payload and execution-context contracts, not strategy policy.

import {describe, expect, test} from 'bun:test';
import {CallKind} from './info';
import type {NativeCall} from './info';
import {checkText} from './testing';

function messages(source: string): string[] {
  return checkText(source).errors.map(error => error.msg);
}

describe('effect.emit semantic contract', () => {
  test('accepts scalars, enums, and recursively fixed user values', () => {
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
        'effect.emit(event)',
        'effect.emit(1.5)',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    const emits = [...result.info.calls.values()].filter(
      (call): call is NativeCall =>
        call.kind === CallKind.Native && call.native.name === 'effect.emit',
    );
    expect(emits).toHaveLength(2);
    expect(emits[0].argTypes[0].kind).toBe('UserType');
  });

  test('rejects collections, tuples, resources, and untyped na', () => {
    const result = messages(
      [
        'values = array.from(1, 2)',
        'effect.emit(values)',
        'effect.emit([1, 2])',
        'line handle = na',
        'effect.emit(handle)',
        'effect.emit(na)',
      ].join('\n'),
    );

    expect(result).toContain(
      "array<int> does not satisfy effect-payload constraint for 'T'",
    );
    expect(result).toContain(
      "[int, int] does not satisfy effect-payload constraint for 'T'",
    );
    expect(result).toContain(
      "line does not satisfy effect-payload constraint for 'T'",
    );
    expect(result).toContain(
      "cannot infer type argument 'T' for 'effect.emit'; provide it explicitly",
    );
  });

  test('rejects transitive emission from request children', () => {
    const result = messages(
      [
        'emitAndRead() =>',
        '    effect.emit(close)',
        '    close',
        'nested = request.security("X", "", emitAndRead())',
      ].join('\n'),
    );

    expect(result).toContain(
      "'emitAndRead' cannot call 'effect.emit' inside a request expression",
    );
  });

  test('rejects emission from persistent initialization and bind work', () => {
    const result = messages(
      [
        'noisyInt() =>',
        '    effect.emit(1)',
        '    2',
        'var int seeded = noisyInt()',
        'plot(close, linewidth = noisyInt())',
      ].join('\n'),
    );

    expect(result).toContain(
      "'effect.emit' cannot execute from a persistent variable initializer",
    );
    expect(result).toContain(
      "'effect.emit' cannot execute from bind-time argument 'linewidth'",
    );
  });

  test('includes only omitted function and method defaults in transitive effect checks', () => {
    const suppliedFunction = messages(
      [
        'noisy() =>',
        '    effect.emit(1)',
        '    2',
        'read(int value = noisy()) => value',
        'var int seeded = read(3)',
      ].join('\n'),
    );
    expect(suppliedFunction).toEqual([]);

    const omittedFunction = messages(
      [
        'noisy() =>',
        '    effect.emit(1)',
        '    2',
        'read(int value = noisy()) => value',
        'var int seeded = read()',
      ].join('\n'),
    );
    expect(omittedFunction).toContain(
      "'effect.emit' cannot execute from a persistent variable initializer",
    );

    const suppliedMethod = messages(
      [
        'noisy() =>',
        '    effect.emit(1)',
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
        '    effect.emit(1)',
        '    2',
        'type Box',
        '    int value',
        '    int read(int fallback = noisy()) const => this.value',
        'box = Box.new(1)',
        'var int seeded = box.read()',
      ].join('\n'),
    );
    expect(omittedMethod).toContain(
      "'effect.emit' cannot execute from a persistent variable initializer",
    );
  });

  test('includes only omitted constructor field defaults in persistent initializer checks', () => {
    const supplied = messages(
      [
        'noisy() =>',
        '    effect.emit(1)',
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
        '    effect.emit(1)',
        '    2',
        'type Box',
        '    int value = noisy()',
        'var Box state = Box.new()',
      ].join('\n'),
    );
    expect(omitted).toContain(
      "'effect.emit' cannot execute from a persistent variable initializer",
    );
  });

  test('the intrinsic root cannot be shadowed', () => {
    expect(messages('effect = 1')).toContain(
      "cannot redeclare built-in 'effect'",
    );
  });
});
