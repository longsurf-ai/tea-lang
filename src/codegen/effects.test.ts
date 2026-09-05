// Purpose: Generic sparse effects lower from Program call-site schemas into
// the ordinary JS ABI and publish as one ordered row unit.

import {describe, expect, test} from 'vitest';
import {Schema} from 'apache-arrow';
import {fieldOf} from './schema';
import {IrKind} from '../ir/node';
import type {Program} from '../ir/program';
import {
  IntType,
  Qualifier,
  StringType,
  TypeKind,
  type StructType,
} from '../ir/type';
import {finiteStream, executeTestModule} from '../testing/batch';
import {OutputCapture} from '../testing/output';
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

const nominalIds = new Map([[EVENT, 'effects.test.OrderSubmitted']]);
const eventSchema = fieldOf('payload', EVENT, nominalIds);
const effect = {
  payloadType: EVENT,
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
  nominalIds,
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

const oneIndex = () => finiteStream(new Schema([]), [{}]);

describe('generic sparse effect lowering', () => {
  test('publishes manifest-typed fixed struct payloads in source order', async () => {
    const module = loadModule(generate(program));
    const sink = new OutputCapture();
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
    expect(sink.emissions).toEqual([]);
    expect(sink.effectEmissions).toEqual([
      {
        row: 0,
        effectId: 0,
        payload: {
          commandId: 'entry-1',
          barIndex: 7,
        },
        provisional: false,
      },
      {
        row: 0,
        effectId: 0,
        payload: {
          commandId: 'entry-1',
          barIndex: 7,
        },
        provisional: false,
      },
    ]);
  });

  test('snapshots the same nested Arrow values for outputs and ordered effects', async () => {
    const module = loadModule(
      generate(
        mustBuild(
          [
            'type Event',
            '    array<float> samples',
            '    matrix<float> grid',
            '    map<string, float> values',
            'samples = array.from(float(bar_index), float(na))',
            'grid = matrix.new<float>(0, 4, na)',
            'values = map.new<string, float>()',
            'values.put("first", 7.0)',
            'event = Event.new(samples, grid, values)',
            'output(event, kind="snapshot", args={})',
            'effect.emit([event, values])',
            'event.samples.push(99.0)',
            'event.values.put("second", 8.0)',
            'effect.emit(event)',
          ].join('\n'),
        ),
      ),
    );
    const sink = new OutputCapture();
    await executeTestModule(module, {
      stream: finiteStream(new Schema([]), [{}, {}]),
      sink,
      timeNow: 0,
    });
    const before = (index: number) => ({
      samples: [index, NaN],
      grid: {rows: 0, columns: 4, values: []},
      values: new Map([['first', 7]]),
    });
    expect(sink.emissions.map(emission => emission.channels[0])).toEqual([
      before(0),
      before(1),
    ]);
    expect(
      sink.publications.map(datum =>
        sink.effectEmissions
          .filter(effect => effect.row === datum.index)
          .map(effect => effect.payload),
      ),
    ).toEqual(
      [0, 1].map(index => [
        {_0: before(index), _1: new Map([['first', 7]])},
        {
          ...before(index),
          samples: [index, NaN, 99],
          values: new Map([
            ['first', 7],
            ['second', 8],
          ]),
        },
      ]),
    );
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
              payload: eventSchema.clone({
                metadata: new Map([
                  ...eventSchema.metadata,
                  ['tea:typeId', 'forged.Other'],
                ]),
              }),
            },
          },
        ],
      },
    };

    const execution = executeTestModule(forged, {
      stream: oneIndex(),
      sink: new OutputCapture(),
      timeNow: 0,
    });
    await expect(execution).rejects.toThrow(/schema|layout|identity/);
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
