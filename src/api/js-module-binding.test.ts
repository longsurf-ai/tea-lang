// Purpose: JSModule binding is an immutable, host-neutral Effect result;
// concrete streams and providers remain outside the generated module.

import {Effect} from 'effect';
import {describe, expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {loadModule} from '../runtime/load';
import {boundInputs, moduleDeclaration} from '../runtime/module-binding';
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

  test('validates parameter values from the generated parameter manifest', () => {
    const error = bindingFailure(
      compileModule('length = input.int(14)\nplot(length)'),
      [{kind: 'parameter', name: 'length', value: 2.5}],
    );

    expect(error.code).toBe('INVALID_BINDING');
    expect(error.message).toContain("parameter 'length'");
  });

  test('fails unknown, wrong-kind, and duplicate assignments explicitly', () => {
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
    expect(
      bindingFailure(once, [{kind: 'parameter', name: 'length', value: 20}])
        .code,
    ).toBe('DUPLICATE_BINDING');
  });

  test('stores only a supplied marker for a series', () => {
    const module = Effect.runSync(
      bindModule(compileModule('plot(close)'), [
        {kind: 'series', name: 'close'},
      ]),
    );

    expect(module.bindings).toEqual([
      {kind: 'series', name: 'close', supplied: true},
    ]);
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

    expect(module.binding?.retention.frames).toEqual([[5]]);
    expect(module.binding?.retention.series).toEqual([0]);
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

    expect(partial.binding).toBeNull();

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
    expect(Object.isFrozen(module.binding)).toBe(true);
    expect(Object.isFrozen(module.parameterValues)).toBe(true);
    expect(Object.isFrozen(module.binding?.retention.frames)).toBe(true);
  });

  test('captures static request settings without resolving data', () => {
    const module = Effect.runSync(
      bindModule(
        compileModule('r = request.security("X", "D", close)\nplot(r)'),
        [],
      ),
    );

    expect(module.binding?.requests).toEqual([
      {
        symbol: 'X',
        timeframe: 'D',
        gaps: false,
        lookahead: false,
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
