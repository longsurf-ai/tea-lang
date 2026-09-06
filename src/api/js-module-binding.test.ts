import type {Module} from '../runtime/module-binding';
// Purpose: Mutable module configuration stays separate from Node stream ownership.

import {DataType, Schema} from 'apache-arrow';
import {describe, expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {BindError} from '../runtime/errors';
import {loadModule} from '../runtime/load';
import {moduleSeriesNames} from '../runtime/module-binding';

import {createNode} from './node';

describe('Module.bind', () => {
  test('fills defaults and recomputes derived facts without requiring streams', () => {
    const raw = compileModule(
      'length = input.int(14)\nemit "output0" close[length] + open',
    );
    const initial = raw.bind();
    expect(initial.parameters[0]!.value).toBe(14);
    expect(initial.inputs.series[0]!.depth).toEqual({kind: 'const', bars: 14});
    const rebound = initial.bind({length: 20});
    expect(rebound.parameters[0]!.value).toBe(20);
    expect(rebound.inputs.series[0]!.depth).toEqual({kind: 'const', bars: 20});
    expect(initial.ready()).toBe(true);
    expect(initial.remaining()).toEqual([]);
    expect(moduleSeriesNames(initial)).toEqual(['close', 'open']);
    expect(rebound).toBe(initial);
    expect(initial).toBe(raw);
    expect(initial.inputs.series.every(series => !('supplied' in series))).toBe(
      true,
    );
    expect(initial.parameters.every(param => !('bindable' in param))).toBe(
      true,
    );
    expect('manifest' in initial).toBe(false);
    expect('concretize' in initial).toBe(false);
  });

  test('leaves a parameter without a usable default unresolved until supplied', () => {
    const raw = compileModule(
      'length = input.int(14)\nemit "output0" close[length]',
    );
    const pending = Object.assign(raw.clone(), {
      parameters: raw.parameters.map(param => ({...param, defaultValue: null})),
    }).bind();
    expect(pending.remaining()).toEqual(['length']);
    expect(pending.ready()).toBe(false);
    expect(pending.inputs.series[0]!.depth).toEqual({kind: 'bound'});
    const bound = pending.bind({length: 4});
    expect(bound.remaining()).toEqual([]);
    expect(bound.ready()).toBe(true);
    expect(bound.inputs.series[0]!.depth).toEqual({kind: 'const', bars: 4});
    expect(bound).toBe(pending);
  });

  test('rejects invalid values and unknown parameter names with BindError', () => {
    const module = compileModule(
      'length = input.int(14)\nemit "output0" length',
    ).bind();
    expect(() => module.bind({length: 2.5})).toThrow(BindError);
    expect(() => module.bind({length: 2.5})).toThrow(/length/);
    expect(() => module.bind({missing: 1})).toThrow(BindError);
    expect(module.parameters[0]!.value).toBe(14);
    expect(module.bind({length: 20}).bind().parameters[0]!.value).toBe(20);
  });

  test('explicit copies isolate schemas and parameter configurations', () => {
    const original = compileModule(
      'length = input.int(1)\nemit "output0" close + length',
    ).bind();
    original.inputs.schema.metadata.set('feed', 'prices');
    original.inputs.schema.fields[0]!.metadata.set('unit', 'USD');
    const bound = original.clone().bind({length: 2});
    const rebound = original.clone().bind({length: 3});
    original.inputs.schema.metadata.set('feed', 'changed');
    original.inputs.schema.fields[0]!.metadata.set('unit', 'changed');
    bound.outputs.schema.metadata.set('owner', 'changed');
    const copy = rebound.clone();
    copy.inputs.schema.fields[0]!.metadata.set('unit', 'reader');
    expect(rebound.inputs.schema).toBeInstanceOf(Schema);
    expect(DataType.isFloat(rebound.inputs.schema.fields[0]!.type)).toBe(true);
    expect(rebound.inputs.schema.metadata.get('feed')).toBe('prices');
    expect(rebound.inputs.schema.fields[0]!.metadata.get('unit')).toBe('USD');
    expect(rebound.outputs.schema.metadata.has('owner')).toBe(false);
    expect(bound.parameters[0]!.value).toBe(2);
    expect(rebound.parameters[0]!.value).toBe(3);
  });

  test('explicit copies isolate child metadata and parameters', () => {
    const original = compileModule(
      'length = input.int(3)\nr = request.security("X", "D", close[length])\nemit "output0" r',
    ).bind();
    original.requests[0]!.module.inputs.schema.fields[0]!.metadata.set(
      'owner',
      'original',
    );
    const rebound = original.clone().bind({length: 6});
    original.requests[0]!.module.inputs.schema.fields[0]!.metadata.set(
      'owner',
      'changed',
    );
    expect(rebound.requests[0]!.module.parameters[0]!.value).toBe(6);
    expect(rebound.requests[0]!.module.inputs.series[0]!.depth).toEqual({
      kind: 'const',
      bars: 6,
    });
    expect(original.requests[0]!.module.inputs.series[0]!.depth).toEqual({
      kind: 'const',
      bars: 3,
    });
    expect(
      rebound.requests[0]!.module.inputs.schema.fields[0]!.metadata.get(
        'owner',
      ),
    ).toBe('original');
    expect(rebound.requests[0]!.module.ready()).toBe(true);
    expect(rebound.requests[0]!.mode).toBe('sample');
  });

  test('source selection changes required series without connecting any data', () => {
    const initial = compileModule(
      'source = input.source(close)\nemit "output0" source',
    ).bind();
    expect(initial.parameters[0]!.value).toBe('close');
    const selected = initial.bind({source: 'open'});
    expect(selected).toBe(initial);
    expect(selected.parameters[0]!.value).toBe('open');
    expect(moduleSeriesNames(selected)).toContain('open');
    expect(selected.remaining()).toEqual([]);
    expect(selected.ready()).toBe(true);
  });

  test('records parameter-dependent activity and history', () => {
    const module = compileModule(
      'enabled = input.bool(true)\nwidth = input.int(2, active=enabled)\nvalue = close * 2\nemit "output0" value[width]',
    ).bind({enabled: false, width: 4});
    expect(
      module.parameters.map(({value, active}) => ({value, active})),
    ).toEqual([
      {value: false, active: true},
      {value: 4, active: false},
    ]);
    expect(module.state.frames[0]!.locals[0]!.depth).toEqual({
      kind: 'const',
      bars: 4,
    });
    expect(module.outputs.declarations[0]).toEqual({
      layout: expect.any(Number),
    });
  });

  test('Node owns the given module and delegates parameter patches to it', () => {
    const module = compileModule(
      'length = input.int(2)\nemit "output0" close[length]',
    );
    const node = createNode(module);
    expect(node.module).toBe(module);
    expect(node.bind({length: 5})).toBe(node);
    expect(node.module).toBe(module);
    expect(module.parameters[0]!.value).toBe(5);
    expect(module.inputs.series[0]!.depth).toEqual({kind: 'const', bars: 5});
    node.dispose();
  });

  test('static request settings share the record with their executable child', () => {
    const module = compileModule(
      'r = request.security("X", "D", close)\nemit "output0" r',
    ).bind();
    expect(module.requests[0]!.context).toEqual({
      symbol: 'X',
      timeframe: 'D',
      fill: 'carry',
      availability: 'end',
      ignoreInvalidSymbol: false,
      calcBarsCount: 0,
    });
    expect(module.requests[0]!.module.inputs.schema.fields[0]!.name).toBe(
      'close',
    );
    expect(module.requests[0]!.module.remaining()).toEqual([]);
    expect(module.requests[0]!.module.ready()).toBe(true);
  });
});

function compileModule(source: string): Module {
  return loadModule(generate(mustBuild(source)));
}
