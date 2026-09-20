import type {Module} from './module-binding';
// Purpose: The sole module.bind method derives independent configuration atomically.

import {describe, expect, test} from 'vitest';
import {
  Field,
  Float32,
  Float64,
  List,
  Schema,
  Struct,
  Utf8,
} from 'apache-arrow';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {BindError} from './errors';
import {loadModule} from './load';
import {parametersOf} from '../codegen/params';

import {Context} from './js/context';

describe('module binding', () => {
  test('parameter records expose declaration, pending activity and atomic binding status', () => {
    const program = mustBuild(
      [
        'enabled = input.bool(true)',
        'length = input.int(3, minval=1, active=enabled)',
        'emit "value" close[length]',
      ].join('\n'),
    );
    expect(
      parametersOf(program.params, program.nominalIds).map(p => p.active),
    ).toEqual([true, null]);
    let module = loadModule(generate(program));
    expect(module.parameters[1].value).toBeUndefined();
    expect(module.parameters[1].active).toBeNull();
    module = module.bind();
    expect(module.parameters[1]).toMatchObject({
      defaultValue: 3,
      value: 3,
      active: true,
    });
    const parameters = module.parameters;
    expect(() => module.bind({enabled: false, length: 0})).toThrow(BindError);
    expect(module.parameters).toBe(parameters);
    expect(module.parameters[1].active).toBe(true);
    module = module.bind({enabled: false});
    expect(module.parameters[1]).toMatchObject({value: 3, active: false});
  });

  test('rejects malformed binding containers through the one error contract', () => {
    const module = loadModule(
      generate(
        mustBuild('length = input.int(2)\nemit "output0" close[length]'),
      ),
    );
    for (const values of [null, [], 1, '', () => {}]) {
      expect(() => module.bind(values as never)).toThrow(BindError);
    }
    for (const context of [null, {}, []]) {
      expect(() => module.bind({}, context as never)).toThrow(BindError);
    }
    expect(module.bind(Object.create(null)).parameters[0].value).toBe(2);
  });
  test('cloning copies request facts without freezing the caller context', () => {
    const original = loadModule(
      generate(
        mustBuild('r = request.security("X", "D", close)\nemit "output0" r'),
      ),
    );
    const context = original.requests[0]!.context!;
    const module = original.clone();
    expect(module.requests[0].empty).toBe(original.requests[0].empty);
    expect(module.requests[0].resultEmpty).toBe(
      original.requests[0].resultEmpty,
    );
    expect(module.requests[0]!.context).not.toBe(context);
    expect(Object.isFrozen(context)).toBe(false);
    Object.assign(context, {symbol: 'changed'});
    expect(module.requests[0]!.context?.symbol).toBe('X');
    expect(module.bind().requests[0]!.context?.symbol).toBe('X');
  });

  test('writes parameter-dependent depth and activity with fixed output identities', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = input.int(3)\nlevel = input.float(10)\nemit "output0" level\nemit "output1" close[length]',
        ),
      ),
    );
    const configured = module.bind({length: 4, level: 25});
    expect(configured).not.toBe(module);
    expect(configured.inputs.series[0]!.depth).toEqual({
      kind: 'const',
      bars: 4,
    });
    expect(configured.parameters.map(param => param.active)).toEqual([
      true,
      true,
    ]);
    expect(configured.outputs.schema.fields.at(-2)?.name).toBe('output0');
    expect(configured.parameters[1].value).toBe(25);
    expect(Object.isFrozen(configured)).toBe(false);
  });

  test('keeps unavailable context incomplete and retains supplied fixed values across patches', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = timeframe.multiplier\nemit "output0" close[length]',
        ),
      ),
    );
    const pending = module.bind();
    expect(pending.ready()).toBe(false);
    expect(pending.inputs.series[0]!.depth).toEqual({kind: 'bound'});
    const prepared = pending.bind({}, new Map([[0, 7]]));
    expect(prepared).not.toBe(pending);
    expect(prepared.ready()).toBe(true);
    expect(prepared.inputs.series[0]!.depth).toEqual({kind: 'const', bars: 7});
    expect(prepared.clone().bind().inputs.builtins[0]!.value).toBe(7);
    expect(pending.inputs.builtins[0]!.value).toBeUndefined();
  });

  test('rejects fixed bindings for per-step builtins or incompatible values', () => {
    const perStep = loadModule(generate(mustBuild('emit "output0" bar_index')));
    expect(perStep.inputs.builtins[0]!.constant).toBe(false);
    expect(() => perStep.bind({}, new Map([[0, 7]]))).toThrow(BindError);
    expect(() => perStep.bind({}, new Map([[0, 7]]))).toThrow(
      'not a fixed binding input',
    );
    const fixed = loadModule(
      generate(mustBuild('emit "output0" timeframe.multiplier')),
    );
    expect(() => fixed.bind({}, new Map([[0, 'bad']]))).toThrow(BindError);
    expect(() => fixed.bind({}, new Map([[4, 7]]))).toThrow(BindError);
  });

  test('fixed integer inputs accept safe integers or NaN, not fractional or inexact host numbers', () => {
    const module = loadModule(
      generate(mustBuild('emit "output0" timeframe.multiplier')),
    );
    for (const value of [
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
    ]) {
      expect(() => module.bind({}, new Map([[0, value]]))).toThrow(
        'expects a safe integer or numeric na',
      );
    }
    for (const value of [
      Number.MIN_SAFE_INTEGER,
      0,
      Number.MAX_SAFE_INTEGER,
      NaN,
    ]) {
      expect(
        module.bind({}, new Map([[0, value]])).inputs.builtins[0]!.value,
      ).toBe(value);
    }
    expect(module.inputs.builtins[0]!.value).toBeUndefined();
  });

  test('request children keep independent parameters and fixed context', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = input.int(3)\nvalue = request.security("X", "D", close[length] + open[timeframe.multiplier])\nemit "output0" value',
        ),
      ),
    ).bind({length: 4});
    const originalChild = module.requests[0]!.module;
    expect(originalChild.ready()).toBe(false);
    expect(originalChild.parameters[0]!.value).toBe(3);
    const configured = module.bind({length: 5}, new Map([[0, 7]]), ['value']);
    const rebound = configured.bind({length: 6});
    expect(rebound.parameters[0]!.value).toBe(6);
    expect(rebound.requests[0]!.module.ready()).toBe(true);
    expect(rebound.requests[0]!.module.parameters[0]!.value).toBe(5);
    expect(
      rebound.requests[0]!.module.inputs.series.map(series => series.depth),
    ).toEqual([
      {kind: 'const', bars: 5},
      {kind: 'const', bars: 7},
    ]);
    expect(module.parameters[0]!.value).toBe(4);
    expect(originalChild.parameters[0]!.value).toBe(3);
    expect(originalChild.ready()).toBe(false);
    expect(() => module.bind({}, undefined, ['missing'])).toThrow(BindError);
  });

  test('clears old late facts when a required parameter becomes unset', () => {
    const configured = loadModule(
      generate(
        mustBuild('length = input.int(3)\nemit "output0" close[length]'),
      ),
    ).bind({length: 4});
    const pending = Object.assign(configured.clone(), {
      parameters: configured.parameters.map(({value: _value, ...param}) => ({
        ...param,
        defaultValue: null,
      })),
    }).bind();
    expect(pending.remaining()).toEqual(['length']);
    expect(pending.ready()).toBe(false);
    expect(pending.inputs.series[0]!.depth).toEqual({kind: 'bound'});
    expect(configured.inputs.series[0]!.depth).toEqual({
      kind: 'const',
      bars: 4,
    });
  });

  test('failed parent calculations leave the entire request tree unchanged', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = input.int(2)\npolicy = input.string("carry")\nr = request.security("X", "D", close[length], fill=policy)\nemit "output0" r',
        ),
      ),
    ).bind();
    const child = module.requests[0]!.module;
    const parameters = module.parameters;
    const inputs = child.inputs;
    expect(() => module.bind({length: 5, policy: 'middle'})).toThrow(BindError);
    expect(module.parameters).toBe(parameters);
    expect(module.requests[0]!.module).toBe(child);
    expect(child.inputs).toBe(inputs);
    expect(child.parameters[0]!.value).toBe(2);
    expect(child.inputs.series[0]!.depth).toEqual({kind: 'const', bars: 2});
    expect(module.requests[0]!.context?.fill).toBe('carry');
  });

  test('binding an executing module derives another configuration', () => {
    const module = loadModule(
      generate(
        mustBuild('length = input.int(2)\nemit "output0" close[length]'),
      ),
    ).bind();
    new Context(module);
    expect(module.bind({length: 5}).parameters[0]!.value).toBe(5);
    expect(module.parameters[0]!.value).toBe(2);
  });

  test.each(['parameter', 'builtin'])(
    'generated calculations cannot overwrite validated %s values',
    target => {
      const module = loadModule(
        generate(
          mustBuild(
            'length = input.int(2)\nemit "output0" close[length] + timeframe.multiplier',
          ),
        ),
      );
      const calculate = Object.getOwnPropertyDescriptor(
        module,
        'calculate',
      )!.value;
      Object.defineProperty(module, 'calculate', {
        value(...args: unknown[]) {
          calculate(...args);
          const data = args[0] as Module;
          Object.assign(
            target === 'parameter'
              ? data.parameters[0]
              : data.inputs.builtins[0],
            {value: 99},
          );
        },
      });
      expect(() => module.bind({length: 4}, new Map([[0, 7]]))).toThrow();
      expect(module.parameters[0]!.value).toBeUndefined();
      expect(module.inputs.builtins[0]!.value).toBeUndefined();
      expect(module.inputs.series[0]!.depth).toEqual({kind: 'bound'});
    },
  );
  test('output writes validate values against the sole schema', () => {
    const module = loadModule(
      generate(mustBuild('emit "output0" close')),
    ).bind();
    const schema = new Schema(
      module.outputs.schema.fields.map(field =>
        field.name === 'output0'
          ? field.clone({
              type: new List(new Field('item', new Float64(), false)),
            })
          : field,
      ),
    );
    const context = new Context(
      Object.assign(module.clone(), {outputs: {schema}}),
    );
    expect(() =>
      context.step({
        series: [1],
        builtins: [],
        requests: [],
        provisional: false,
      }),
    ).toThrow();
    context.dispose();
    expect(Object.keys(module.outputs)).toEqual(['schema']);
  });

  test.each([
    new Float32(),
    new Utf8(),
    new Struct([new Field('missing', new Float64(), false)]),
  ])('append writes reject values incompatible with schema %s', type => {
    const module = loadModule(
      generate(
        mustBuild('type E\n    float value\nemit.append "events" E.new(1)'),
      ),
    ).bind();
    const schema = new Schema(
      module.outputs.schema.fields.map(field =>
        field.metadata.get('tea:write') === 'append'
          ? field.clone({type: new List(new Field('item', type, true))})
          : field,
      ),
    );
    const context = new Context(
      Object.assign(module.clone(), {outputs: {schema}}),
    );
    expect(() =>
      context.step({
        series: [],
        builtins: [],
        requests: [],
        provisional: false,
      }),
    ).toThrow();
    context.dispose();
  });

  test('runtime admission rejects changed execution coordinate fields', () => {
    const module = loadModule(
      generate(mustBuild('emit "output0" close')),
    ).bind();
    const schema = new Schema(
      module.outputs.schema.fields.map(field =>
        field.name === 'index' ? field.clone({type: new Float32()}) : field,
      ),
    );
    expect(
      () =>
        new Context(
          Object.assign(module.clone(), {outputs: {...module.outputs, schema}}),
        ),
    ).toThrow('invalid output coordinates');
  });
});
