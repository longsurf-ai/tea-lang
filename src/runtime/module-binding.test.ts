import type {Module} from './module-binding';
// Purpose: The sole module.bind method updates configuration atomically in place.

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

import {Context} from './js/context';

describe('module binding', () => {
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
    expect(configured).toBe(module);
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
    expect(prepared).toBe(pending);
    expect(prepared.ready()).toBe(true);
    expect(prepared.inputs.series[0]!.depth).toEqual({kind: 'const', bars: 7});
    expect(prepared.clone().bind().inputs.builtins[0]!.value).toBe(7);
    expect(pending.inputs.builtins[0]!.value).toBe(7);
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
    expect(module.inputs.builtins[0]!.value).toBeNaN();
  });

  test('request children inherit parameters while keeping their own fixed context', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'length = input.int(3)\nvalue = request.security("X", "D", close[length] + open[timeframe.multiplier])\nemit "output0" value',
        ),
      ),
    ).bind({length: 4});
    const request = module.requests[0]!;
    expect(request.module.ready()).toBe(false);
    expect(request.module.parameters[0]!.value).toBe(4);
    const child = request.module.bind({}, new Map([[0, 7]]));
    const rebound = module.bind({length: 6});
    expect(rebound).toBe(module);
    expect(rebound.requests[0]!.module).toBe(child);
    expect(rebound.requests[0]!.module.ready()).toBe(true);
    expect(rebound.requests[0]!.module.parameters[0]!.value).toBe(6);
    expect(
      rebound.requests[0]!.module.inputs.series.map(series => series.depth),
    ).toEqual([
      {kind: 'const', bars: 6},
      {kind: 'const', bars: 7},
    ]);
    expect(child.parameters[0]!.value).toBe(6);
    expect(child.inputs.series.map(series => series.depth)).toEqual([
      {kind: 'const', bars: 6},
      {kind: 'const', bars: 7},
    ]);
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
          'length = input.int(2)\npolicy = input.string("end")\nr = request.security("X", "D", close[length], availability=policy)\nemit "output0" r',
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
    expect(module.requests[0]!.context?.availability).toBe('end');
  });

  test('execution closes binding while an explicit copy can configure another run', () => {
    const module = loadModule(
      generate(
        mustBuild('length = input.int(2)\nemit "output0" close[length]'),
      ),
    ).bind();
    new Context(module);
    expect(() => module.bind({length: 5})).toThrow('execution starts');
    expect(module.clone().bind({length: 5}).parameters[0]!.value).toBe(5);
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
  test('runtime admission rejects mismatched set layouts and missing declarations', () => {
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
    expect(
      () =>
        new Context(
          Object.assign(module.clone(), {outputs: {...module.outputs, schema}}),
        ),
    ).toThrow('disagrees with Arrow field');
    expect(
      () =>
        new Context(
          Object.assign(module.clone(), {
            outputs: {...module.outputs, declarations: []},
          }),
        ),
    ).toThrow('output fields and declarations disagree');
  });

  test.each([new Float32(), new Utf8(), new Struct([])])(
    'runtime admission rejects mismatched append payload %s',
    type => {
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
      expect(
        () =>
          new Context(
            Object.assign(module.clone(), {
              outputs: {...module.outputs, schema},
            }),
          ),
      ).toThrow('disagrees with Arrow field');
    },
  );

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
