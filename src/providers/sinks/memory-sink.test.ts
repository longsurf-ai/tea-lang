// Purpose: MemorySink snapshots declaration and emission arrays without adding batch policy.

import {describe, expect, test} from 'vitest';
import type {
  EffectValue,
  OutputSink,
  OutputSpec,
  Value,
} from '../../runtime/abi';
import {MemorySink} from './memory-sink';

describe('MemorySink', () => {
  test('clones declarations and emitted channel arrays', () => {
    const sink = new MemorySink();
    const staticArgs: OutputSpec['staticArgs'][number][] = [
      {name: 'title', value: 'Price'},
    ];
    const channels: OutputSpec['channels'][number][] = [
      {name: 'series', type: 'float', transport: {kind: 'float' as const}},
    ];
    const boundArgs = [{name: 'display', value: 'all'}] as {
      name: string;
      value: Value;
    }[];
    const declaration: Parameters<OutputSink['declare']>[0] = {
      outputs: [
        {
          spec: {effect: 'plot', staticArgs, channels},
          boundArgs,
        },
      ],
      effects: [{payload: {kind: 'int'}}],
    };
    const emitted: Value[] = [42];

    sink.declare(declaration);
    sink.publish({
      row: 7,
      outputs: [{outputId: 0, channels: emitted}],
      effects: [{effectId: 0, payload: 17}],
      provisional: false,
    });
    staticArgs.push({name: 'extra', value: true});
    channels.push({
      name: 'color',
      type: 'color',
      transport: {kind: 'color'},
    });
    boundArgs.push({name: 'linewidth', value: 2});
    emitted[0] = 99;

    expect(sink.outputs).toEqual([
      {
        spec: {
          effect: 'plot',
          staticArgs: [{name: 'title', value: 'Price'}],
          channels: [
            {name: 'series', type: 'float', transport: {kind: 'float'}},
          ],
        },
        boundArgs: [{name: 'display', value: 'all'}],
      },
    ]);
    expect(sink.emissions).toEqual([
      {row: 7, outputId: 0, channels: [42], provisional: false},
    ]);
    expect(sink.effectSchemas).toEqual([{payload: {kind: 'int'}}]);
    expect(sink.effectEmissions).toEqual([
      {row: 7, effectId: 0, payload: 17, provisional: false},
    ]);
  });

  test('replaces declarations while retaining emissions', () => {
    const sink = new MemorySink();
    sink.declare({outputs: [], effects: []});
    sink.publish({
      row: 0,
      outputs: [{outputId: 0, channels: [1]}],
      effects: [],
      provisional: true,
    });
    sink.declare({
      outputs: [
        {
          spec: {effect: 'indicator', staticArgs: [], channels: []},
          boundArgs: [],
        },
      ],
      effects: [],
    });

    expect(sink.outputs.map(output => output.spec.effect)).toEqual([
      'indicator',
    ]);
    expect(sink.emissions).toHaveLength(1);
  });

  test('recursively snapshots fixed struct effect payloads', () => {
    const sink = new MemorySink();
    const nestedFields: EffectValue[] = [3];
    const nested: EffectValue = {
      kind: 'struct',
      fields: nestedFields,
    };
    const fields: EffectValue[] = ['order-1', nested];
    const payload: EffectValue = {
      kind: 'struct',
      fields,
    };
    sink.declare({
      outputs: [],
      effects: [
        {
          payload: {
            kind: 'struct',
            typeId: 'test.Event',
            displayName: 'Event',
            fields: [],
          },
        },
      ],
    });
    sink.publish({
      row: 2,
      outputs: [],
      effects: [{effectId: 0, payload}],
      provisional: false,
    });

    fields[0] = 'changed';
    nestedFields[0] = 99;

    expect(sink.effectEmissions[0].payload).toEqual({
      kind: 'struct',
      fields: ['order-1', {kind: 'struct', fields: [3]}],
    });
  });
});
