// Purpose: Binding-time state is an immutable Effect result over Program
// requirements; Observable subscription remains outside this layer.

import {Effect} from 'effect';
import {of} from 'rxjs';
import {describe, expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {
  bindModule,
  type BindingAssignment,
  type BindingError,
} from './binding';

describe('BoundModule', () => {
  test('is created on first bind and becomes ready across immutable steps', () => {
    const program = mustBuild(
      ['length = input.int(14)', 'plot(ta.sma(close, length) + open)'].join(
        '\n',
      ),
    );

    const withClose = Effect.runSync(
      bindModule(program, [
        {kind: 'series', name: 'close', target: of(1)},
      ]),
    );

    expect(withClose.program).toBe(program);
    expect(withClose.ready()).toBe(false);
    expect(withClose.remaining().map(binding => binding.name)).toEqual([
      'length',
      'open',
    ]);

    const ready = Effect.runSync(
      bindModule(withClose, [
        {kind: 'parameter', name: 'length', target: 20},
        {kind: 'series', name: 'open', target: of(2)},
      ]),
    );

    expect(ready.ready()).toBe(true);
    expect(ready.remaining()).toEqual([]);
    expect(withClose.ready()).toBe(false);
    expect(withClose.remaining().map(binding => binding.name)).toEqual([
      'length',
      'open',
    ]);
  });

  test('preserves Program requirement order and freezes binding snapshots', () => {
    const program = mustBuild(
      ['enabled = input.bool(true)', 'plot(enabled ? close : open)'].join(
        '\n',
      ),
    );

    const module = Effect.runSync(bindModule(program, []));

    expect(module.bindings.map(binding => binding.name)).toEqual([
      'enabled',
      'close',
      'open',
    ]);
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module.bindings)).toBe(true);
    expect(module.bindings.every(Object.isFrozen)).toBe(true);
    expect(module.ready()).toBe(false);
  });

  test('validates parameter values through the extracted Zod schema', () => {
    const program = mustBuild('length = input.int(14)\nplot(length)');

    const error = bindingFailure(
      program,
      [{kind: 'parameter', name: 'length', target: 2.5}],
    );

    expect(error.code).toBe('INVALID_BINDING');
    expect(error.message).toContain("parameter binding 'length'");
  });

  test('fails unknown, wrong-kind, and duplicate assignments explicitly', () => {
    const program = mustBuild('length = input.int(14)\nplot(close + length)');

    expect(
      bindingFailure(program, [
        {kind: 'parameter', name: 'missing', target: 1},
      ]).code,
    ).toBe('UNKNOWN_BINDING');
    expect(
      bindingFailure(program, [
        {kind: 'series', name: 'length', target: of(1)},
      ]).code,
    ).toBe('BINDING_KIND_MISMATCH');

    const once = Effect.runSync(
      bindModule(program, [
        {kind: 'parameter', name: 'length', target: 10},
      ]),
    );
    expect(
      bindingFailure(once, [
        {kind: 'parameter', name: 'length', target: 20},
      ]).code,
    ).toBe('DUPLICATE_BINDING');
  });

  test('rejects a non-Observable series target in the Effect error channel', () => {
    const program = mustBuild('plot(close)');
    const invalid = {
      kind: 'series',
      name: 'close',
      target: 1,
    } as unknown as BindingAssignment;

    const error = bindingFailure(program, [invalid]);

    expect(error.code).toBe('INVALID_BINDING');
    expect(error.message).toContain("series binding 'close'");
  });

  test('a Program with no semantic inputs is ready after its first bind', () => {
    const module = Effect.runSync(bindModule(mustBuild('plot(1)'), []));

    expect(module.ready()).toBe(true);
    expect(module.remaining()).toEqual([]);
  });
});

function bindingFailure(
  target: Parameters<typeof bindModule>[0],
  supplied: readonly BindingAssignment[],
): BindingError {
  return Effect.runSync(Effect.flip(bindModule(target, supplied)));
}
