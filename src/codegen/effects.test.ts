// Purpose: Generic sparse effects lower from Program call-site schemas into
// the ordinary JS ABI and publish as one ordered row unit.

import {describe, expect, test} from 'bun:test';
import {IrKind} from '../ir/node';
import type {Program} from '../ir/program';
import {
  IntType,
  Qualifier,
  StringType,
  TypeKind,
  type UserType,
} from '../ir/type';
import {MemorySink} from '../providers/sinks/memory-sink';
import type {DataProvider, ProviderContext} from '../runtime/abi';
import {bind} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';
import {mustBuild} from '../noder/testing';
import {generate} from './codegen';
import {compileProgramToWgsl} from './wgsl/lower';

const pos = {base: {filename: 'effects.test.tea'}, line: 1, col: 1};

const EVENT: UserType = {
  kind: TypeKind.UserType,
  name: 'OrderSubmitted',
  fields: [
    {name: 'commandId', type: StringType},
    {name: 'barIndex', type: IntType},
  ],
};

const eventSchema = {
  kind: 'user-type' as const,
  typeId: 'effects.test.OrderSubmitted',
  displayName: 'OrderSubmitted',
  fields: [
    {name: 'commandId', value: {kind: 'string' as const}},
    {name: 'barIndex', value: {kind: 'int' as const}},
  ],
};
const effect = {
  payloadType: EVENT,
  payloadSchema: eventSchema,
  sourcePosition: pos,
};
const payload = {
  kind: IrKind.NewUserValue,
  pos,
  type: EVENT,
  qualifier: Qualifier.Const,
  userType: EVENT,
  args: [
    {
      kind: IrKind.Const,
      pos,
      type: StringType,
      qualifier: Qualifier.Const,
      value: 'entry-1',
    },
    {
      kind: IrKind.Const,
      pos,
      type: IntType,
      qualifier: Qualifier.Const,
      value: 7,
    },
  ],
  argumentEvaluationOrder: [0, 1],
} as const;

const program: Program = {
  version: 1,
  params: [],
  requests: [],
  outputs: [],
  effects: [effect],
  packageGlobals: [],
  init: [],
  body: [
    {kind: IrKind.EmitEffect, pos, effect, payload},
    // Repeated execution of one call site appends a second ordered record.
    {kind: IrKind.EmitEffect, pos, effect, payload},
  ],
};

const context: ProviderContext = {
  rows: 1,
  axis: null,
  series: () => null,
  builtinValue: () => undefined,
};
const provider: DataProvider = {
  resolveContext: () => Promise.resolve(context),
};

describe('generic sparse effect lowering', () => {
  test('publishes manifest-typed fixed UDT payloads in source order', async () => {
    const module = loadModule(generate(program));
    const sink = new MemorySink();
    const execution = await bind(module, {
      params: {},
      provider,
      sink,
      timeNow: 0,
    });

    await execution.runAll();

    expect(module.manifest.effects).toEqual([
      {layout: 0, declaration: {payload: eventSchema}},
    ]);
    expect(sink.effectSchemas).toEqual([{payload: eventSchema}]);
    expect(module.aggregateLayouts.layouts[0]).toEqual({
      kind: 'user-type',
      name: 'OrderSubmitted',
      typeId: 'effects.test.OrderSubmitted',
      fields: [
        {name: 'commandId', layout: 1},
        {name: 'barIndex', layout: 2},
      ],
    });
    expect(sink.publications).toHaveLength(1);
    expect(sink.publications[0].outputs).toEqual([]);
    expect(sink.effectEmissions).toEqual([
      {
        row: 0,
        effectId: 0,
        payload: {
          kind: 'user-type',
          fields: ['entry-1', 7],
        },
        provisional: false,
      },
      {
        row: 0,
        effectId: 0,
        payload: {
          kind: 'user-type',
          fields: ['entry-1', 7],
        },
        provisional: false,
      },
    ]);
    execution.dispose();
  });

  test('rejects a same-shaped logical payload with a forged nominal id', async () => {
    const module = loadModule(generate(program));
    const original = module.manifest.effects[0]!;
    const forged = {
      ...module,
      manifest: {
        ...module.manifest,
        effects: [
          {
            ...original,
            declaration: {
              payload: {...eventSchema, typeId: 'forged.Other'},
            },
          },
        ],
      },
    };

    await expect(
      bind(forged, {
        params: {},
        provider,
        sink: new MemorySink(),
        timeNow: 0,
      }),
    ).rejects.toThrow(
      'effect payload layout 0 disagrees with logical user-type schema',
    );
  });

  test('WGSL publishes a fixed append contract for the same generic effects', () => {
    const gpuProgram = mustBuild(
      [
        'strategy("GPU effects")',
        'type OrderSubmitted',
        '    string commandId',
        '    int barIndex',
        'emitOne() =>',
        '    effect.emit(OrderSubmitted.new("entry-1", 7))',
        '    1',
        'emitOne()',
        'emitOne()',
        'close',
      ].join('\n'),
    );
    const result = compileProgramToWgsl(gpuProgram);
    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;

    expect(result.artifact.maxEffectsPerRow).toBe(2);
    expect(result.artifact.literalStrings).toEqual(['entry-1']);
    expect(result.artifact.effectSchemas).toHaveLength(1);
    expect(result.artifact.effectSchemas[0]).toMatchObject({
      effectId: 0,
      payloadWordCount: 5,
      declaration: {
        payload: {
          kind: 'user-type',
          typeId: '@entry.OrderSubmitted',
          fields: [
            {name: 'commandId', value: {kind: 'string'}},
            {name: 'barIndex', value: {kind: 'int'}},
          ],
        },
      },
      payload: {
        kind: 'user-type',
        validByteOffset: 0,
        name: 'OrderSubmitted',
        fields: [
          {
            name: 'commandId',
            byteOffset: 4,
            value: {
              kind: 'string',
              validByteOffset: 0,
              valueByteOffset: 4,
            },
          },
          {
            name: 'barIndex',
            byteOffset: 12,
            value: {
              kind: 'int',
              validByteOffset: 0,
              valueByteOffset: 4,
            },
          },
        ],
      },
    });
  });
});
