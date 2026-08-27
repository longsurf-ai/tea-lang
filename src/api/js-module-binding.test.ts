// Purpose: JSModule binding is an immutable, host-neutral Effect result;
// concrete streams and application sources remain outside the generated module.

import {Effect} from 'effect';
import {describe, expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {loadModule} from '../runtime/load';
import {
  boundInputs,
  moduleBindings,
  moduleDeclaration,
} from '../runtime/module-binding';
import type {JSModule} from '../runtime/module-abi';
import {bindModule, type BindingAssignment, type BindingError} from './binding';

describe('JSModule binding', () => {
  test('becomes ready across immutable binding steps', () => {
    const module = compileModule(
      ['length = input.int(14)', 'plot(ta.sma(close, length) + open)'].join(
        '\n',
      ),
    );

    const withClose = Effect.runSync(
      bindModule(module, [{kind: 'series', name: 'close'}]),
    );

    expect(withClose.ready()).toBe(false);
    expect(withClose.remaining().map(binding => binding.name)).toEqual([
      'length',
      'open',
    ]);

    const ready = Effect.runSync(
      bindModule(withClose, [
        {kind: 'parameter', name: 'length', value: 20},
        {kind: 'series', name: 'open'},
      ]),
    );

    expect(ready.ready()).toBe(true);
    expect(ready.remaining()).toEqual([]);
    expect(withClose.ready()).toBe(false);
    expect(ready).not.toBe(withClose);
  });

  test('preserves manifest requirement order and freezes snapshots', () => {
    const module = compileModule(
      ['enabled = input.bool(true)', 'plot(enabled ? close : open)'].join('\n'),
    );

    expect(moduleBindings(module).map(binding => binding.name)).toEqual([
      'enabled',
      'close',
      'open',
    ]);
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module.manifest)).toBe(true);
    expect(module.ready()).toBe(false);
  });

  test('validates parameter values from the generated parameter manifest', () => {
    const error = bindingFailure(
      compileModule('length = input.int(14)\nplot(length)'),
      [{kind: 'parameter', name: 'length', value: 2.5}],
    );

    expect(error.code).toBe('INVALID_BINDING');
    expect(error.message).toContain("parameter 'length'");
  });

  test('fails unknown and wrong-kind assignments and replaces parameters', () => {
    const module = compileModule(
      'length = input.int(14)\nplot(close + length)',
    );

    expect(
      bindingFailure(module, [{kind: 'parameter', name: 'missing', value: 1}])
        .code,
    ).toBe('UNKNOWN_BINDING');
    expect(
      bindingFailure(module, [{kind: 'series', name: 'length'}]).code,
    ).toBe('BINDING_KIND_MISMATCH');

    const once = Effect.runSync(
      bindModule(module, [{kind: 'parameter', name: 'length', value: 10}]),
    );
    const twice = Effect.runSync(
      bindModule(once, [{kind: 'parameter', name: 'length', value: 20}]),
    );
    expect(once.manifest.params[0]?.value).toBe(10);
    expect(twice.manifest.params[0]?.value).toBe(20);
  });

  test('stores only a supplied marker for a series', () => {
    const module = Effect.runSync(
      bindModule(compileModule('plot(close)'), [
        {kind: 'series', name: 'close'},
      ]),
    );

    expect(moduleBindings(module)).toEqual([
      {kind: 'series', name: 'close', supplied: true},
    ]);
  });

  test('derives input.source series binding from its current parameter value', () => {
    const initial = compileModule('source = input.source(close)\nplot(source)');
    const selected = Effect.runSync(
      bindModule(initial, [
        {kind: 'parameter', name: 'source', value: 'close'},
      ]),
    );
    const supplied = Effect.runSync(
      bindModule(selected, [{kind: 'series', name: 'close'}]),
    );
    const switched = Effect.runSync(
      bindModule(supplied, [
        {kind: 'parameter', name: 'source', value: 'open'},
      ]),
    );

    expect(moduleBindings(selected)).toEqual([
      {kind: 'parameter', name: 'source', value: 'close'},
      {kind: 'series', name: 'close', supplied: false},
    ]);
    expect(supplied.ready()).toBe(true);
    expect(moduleBindings(switched)).toEqual([
      {kind: 'parameter', name: 'source', value: 'open'},
      {kind: 'series', name: 'close', supplied: true},
      {kind: 'series', name: 'open', supplied: false},
    ]);
    expect(switched.ready()).toBe(false);
  });

  test('a module without semantic inputs becomes ready on an empty bind', () => {
    const module = Effect.runSync(bindModule(compileModule('plot(1)'), []));

    expect(module.ready()).toBe(true);
    expect(module.remaining()).toEqual([]);
  });

  test('stores parameter-bound retention directly on the module', () => {
    const module = Effect.runSync(
      bindModule(
        compileModule(
          [
            'lookback = input.int(3)',
            'value = close * 2',
            'plot(value[lookback])',
          ].join('\n'),
        ),
        [
          {kind: 'parameter', name: 'lookback', value: 5},
          {kind: 'series', name: 'close'},
        ],
      ),
    );

    expect(module.manifest.frames[0].locals[0].depth).toEqual({
      kind: 'const',
      bars: 5,
    });
  });

  test('exposes ordered parameters, activity, and output declarations when ready', () => {
    const initial = compileModule(
      [
        'enabled = input.bool(true)',
        'width = input.int(2, active=enabled)',
        'plot(close, linewidth=width)',
      ].join('\n'),
    );
    const partial = Effect.runSync(
      bindModule(initial, [{kind: 'parameter', name: 'enabled', value: false}]),
    );

    expect(partial.ready()).toBe(false);

    const module = Effect.runSync(
      bindModule(partial, [
        {kind: 'parameter', name: 'width', value: 4},
        {kind: 'series', name: 'close'},
      ]),
    );

    expect(
      boundInputs(module).map(({value, active}) => ({value, active})),
    ).toEqual([
      {value: false, active: true},
      {value: 4, active: false},
    ]);
    expect(moduleDeclaration(module).outputs[0].boundArgs).toEqual([
      {name: 'linewidth', value: 4},
    ]);
    expect(Object.isFrozen(module.manifest)).toBe(true);
    expect(Object.isFrozen(module.manifest.params)).toBe(true);
    expect(Object.isFrozen(module.manifest.frames)).toBe(true);
  });

  test('captures static request settings without resolving data', () => {
    const module = Effect.runSync(
      bindModule(
        compileModule('r = request.security("X", "D", close)\nplot(r)'),
        [],
      ),
    );

    expect(module.manifest.requests.map(request => request.context)).toEqual([
      {
        symbol: 'X',
        timeframe: 'D',
        fill: 'carry',
        availability: 'end',
        ignoreInvalidSymbol: false,
        calcBarsCount: 0,
      },
    ]);
    expect(module.ready()).toBe(true);
    expect(module.requests[0]?.remaining().map(input => input.name)).toEqual([
      'close',
    ]);
  });
});

function compileModule(source: string): JSModule {
  return loadModule(generate(mustBuild(source)));
}

function bindingFailure(
  target: Parameters<typeof bindModule>[0],
  supplied: readonly BindingAssignment[],
): BindingError {
  return Effect.runSync(Effect.flip(bindModule(target, supplied)));
}
