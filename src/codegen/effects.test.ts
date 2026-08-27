// Purpose: Generic sparse effects lower from Program call-site schemas into
// the ordinary JS ABI and publish as one ordered row unit.

import {describe, expect, test} from 'vitest';
import * as z from 'zod';
import {IrKind} from '../ir/node';
import type {Program} from '../ir/program';
import {
  IntType,
  Qualifier,
  StringType,
  TypeKind,
  type StructType,
} from '../ir/type';
import {MemorySink} from '../sinks/memory-sink';
import {finiteStream, executeTestModule} from '../testing/batch';
import {loadModule} from '../runtime/load';
import {mustBuild} from '../noder/testing';
import {generate} from './codegen';
import {compileProgramToWgsl} from './wgsl/lower';

const pos = {base: {filename: 'effects.test.tea'}, line: 1, col: 1};

const EVENT: StructType = {
  kind: TypeKind.Struct,
  name: 'OrderSubmitted',
  fields: [
    {name: 'commandId', type: StringType},
    {name: 'barIndex', type: IntType},
  ],
};

const eventSchema = {
  kind: 'struct' as const,
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
  kind: IrKind.NewStruct,
  pos,
  type: EVENT,
  qualifier: Qualifier.Const,
  structType: EVENT,
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

const oneIndex = () => finiteStream(z.object({}), [{}]);

describe('generic sparse effect lowering', () => {
  test('publishes manifest-typed fixed struct payloads in source order', async () => {
    const module = loadModule(generate(program));
    const sink = new MemorySink();
    await executeTestModule(module, {
      stream: oneIndex(),
      sink,
      timeNow: 0,
    });

    expect(module.manifest.effects).toEqual([
      {layout: 0, declaration: {payload: eventSchema}},
    ]);
    expect(sink.effectSchemas).toEqual([{payload: eventSchema}]);
    expect(module.layout[0]).toEqual({
      kind: 'struct',
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
          kind: 'struct',
          fields: ['entry-1', 7],
        },
        provisional: false,
      },
      {
        row: 0,
        effectId: 0,
        payload: {
          kind: 'struct',
          fields: ['entry-1', 7],
        },
        provisional: false,
      },
    ]);
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

    const execution = executeTestModule(forged, {
      stream: oneIndex(),
      sink: new MemorySink(),
      timeNow: 0,
    });
    await expect(execution).rejects.toThrow(
      'effect payload layout 0 disagrees with logical struct schema',
    );
  });

  test('WGSL fails closed for struct effect payloads', () => {
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
    expect(result.status).toBe('staged-unsupported');
    expect(result.eligibility.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );
  });
});
