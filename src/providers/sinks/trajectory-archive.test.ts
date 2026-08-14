// Purpose: Compact sweep trajectory archives preserve values while enforcing one aggregate budget.

import {describe, expect, test} from 'bun:test';
import type {ExecutionBindingSummary} from '../../execute';
import type {
  EffectValue,
  ExecutionDeclaration,
  OutputChannelSpec,
  OutputChannelTransport,
  ParamSpec,
} from '../../runtime/abi';
import {
  TrajectoryArchive,
  TrajectoryArchiveBudgetError,
  TrajectoryArchiveProjectionBudgetError,
  TrajectoryArchiveUnsupportedTransportError,
} from './trajectory-archive';
import {SweepReportSink} from './report-sink';

const LENGTH: ParamSpec = {
  name: 'length',
  title: 'Length',
  type: 'int',
  control: 'int',
  defaultValue: 10,
  constraints: null,
  enumType: null,
  group: null,
  inline: null,
  tooltip: null,
  confirm: false,
  display: 'all',
  seriesSid: null,
};

const channels: OutputChannelSpec[] = [
  {name: 'equity', type: 'float', transport: {kind: 'float'}},
  {name: 'trades', type: 'int', transport: {kind: 'int'}},
  {name: 'active', type: 'bool', transport: {kind: 'bool'}},
  {name: 'note', type: 'string', transport: {kind: 'string'}},
  {name: 'color', type: 'color', transport: {kind: 'color'}},
  {
    name: 'side',
    type: 'broker.Side',
    transport: {kind: 'enum', name: 'broker.Side', members: ['buy', 'sell']},
  },
];

const declaration: ExecutionDeclaration = {
  outputs: channels.map(channel => ({
    spec: {
      effect: 'plot',
      staticArgs: [{name: 'title', value: channel.name}],
      channels: [channel],
    },
    boundArgs: [],
  })),
  effects: [
    {
      payload: {
        kind: 'user-type',
        typeId: 'broker.FillExecuted',
        displayName: 'FillExecuted',
        fields: [
          {name: 'id', value: {kind: 'int'}},
          {
            name: 'fill',
            value: {
              kind: 'user-type',
              typeId: 'broker.Fill',
              displayName: 'Fill',
              fields: [
                {name: 'price', value: {kind: 'float'}},
                {name: 'note', value: {kind: 'string'}},
                {name: 'live', value: {kind: 'bool'}},
              ],
            },
          },
        ],
      },
    },
  ],
};

const effect: EffectValue = {
  kind: 'user-type',
  fields: [7, {kind: 'user-type', fields: [101.25, 'entry', true]}],
};

const binding = (rows: number): ExecutionBindingSummary => ({
  bindingIndex: 0,
  rows,
  inputs: [{spec: LENGTH, value: 12, active: true}],
});

describe('trajectory archive', () => {
  test('preserves exact times, scalar/null rows, and typed sparse effects', () => {
    const archive = new TrajectoryArchive({maxBytes: 1 << 20});
    const sink = archive.createSink();
    expect(sink.capabilities).toEqual({denseRows: 'all', effects: 'all'});
    sink.declare(declaration);
    sink.publish({
      row: 0,
      time: 1_700_000_000_122,
      outputs: declaration.outputs.map((_, outputId) => ({
        outputId,
        channels: [999],
      })),
      effects: [{effectId: 0, payload: effect}],
      provisional: true,
    });
    sink.publish({
      row: 0,
      time: 1_700_000_000_123,
      outputs: [
        {outputId: 0, channels: [100.5]},
        {outputId: 1, channels: [7]},
        {outputId: 2, channels: [true]},
        {outputId: 3, channels: ['ready']},
        {outputId: 4, channels: ['#008000']},
        {outputId: 5, channels: ['buy']},
      ],
      effects: [{effectId: 0, payload: effect}],
      provisional: false,
    });
    sink.publish({
      row: 1,
      time: null,
      outputs: [
        {outputId: 0, channels: [Number.NaN]},
        {outputId: 1, channels: [null]},
        {outputId: 2, channels: [null]},
        {outputId: 3, channels: [null]},
        {outputId: 4, channels: ['#ff0000']},
        {outputId: 5, channels: ['sell']},
      ],
      effects: [],
      provisional: false,
    });

    const snapshot = sink.snapshot(9);
    expect(snapshot.bindingIndex).toBe(9);
    expect(snapshot.rows).toBe(2);
    expect(snapshot.finalOutputs.map(output => output.channels[0])).toEqual([
      Number.NaN,
      null,
      null,
      null,
      '#ff0000',
      'sell',
    ]);

    const trajectory = sink.trajectory(binding(2), 9);
    expect(trajectory.bindingIndex).toBe(9);
    expect(trajectory.time).toEqual([1_700_000_000_123, null]);
    expect(trajectory.parameters).toEqual([
      {
        id: 'parameter:length',
        name: 'length',
        label: 'Length',
        type: 'int',
        value: 12,
        active: true,
      },
    ]);
    expect(trajectory.outputs.map(output => output.values)).toEqual([
      [100.5, null],
      [7, null],
      [true, null],
      ['ready', null],
      ['#008000', '#ff0000'],
      ['buy', 'sell'],
    ]);
    expect(trajectory.effects).toEqual([
      {
        row: 0,
        effectId: 'effect:0',
        payload: {id: 7, fill: {price: 101.25, note: 'entry', live: true}},
      },
    ]);
  });

  test('keeps missing rows aligned and snapshots the latest value per output', () => {
    const archive = new TrajectoryArchive({maxBytes: 1 << 20});
    const sink = archive.createSink();
    const reference = new SweepReportSink();
    sink.declare(declaration);
    reference.declare(declaration);
    const first = {
      row: 0,
      time: 100,
      outputs: [{outputId: 0, channels: [1]}],
      effects: [],
      provisional: false as const,
    };
    const second = {
      row: 1,
      time: 200,
      outputs: [{outputId: 1, channels: [2]}],
      effects: [],
      provisional: false as const,
    };
    sink.publish(first);
    reference.publish(first);
    sink.publish(second);
    reference.publish(second);

    expect(sink.snapshot(0)).toEqual(reference.snapshot(0));
    const result = sink.trajectory(binding(2));
    expect(result.outputs[0]!.values).toEqual([1, null]);
    expect(result.outputs[1]!.values).toEqual([null, 2]);
  });

  test('fails closed before exceeding the budget and can be reset', () => {
    const archive = new TrajectoryArchive({maxBytes: 64 * 1024});
    const sink = archive.createSink();
    sink.declare(declaration);
    const huge = 'x'.repeat(30_000);
    expect(() =>
      sink.publish({
        row: 0,
        outputs: [
          {outputId: 0, channels: [1]},
          {outputId: 1, channels: [1]},
          {outputId: 2, channels: [true]},
          {outputId: 3, channels: [huge]},
        ],
        effects: [],
        provisional: false,
      }),
    ).toThrow(TrajectoryArchiveBudgetError);
    expect(archive.usedBytes).toBeLessThanOrEqual(archive.maxBytes);
    expect(() => sink.snapshot(0)).toThrow('failed and must be reset');

    sink.reset();
    expect(archive.usedBytes).toBe(0);
    sink.declare(declaration);
    sink.publish({
      row: 0,
      outputs: [{outputId: 3, channels: ['small']}],
      effects: [],
      provisional: false,
    });
    expect(sink.trajectory(binding(1)).outputs[3]!.values).toEqual(['small']);
  });

  test('shares the aggregate budget and resets all sinks', () => {
    const archive = new TrajectoryArchive({maxBytes: 1 << 20});
    const first = archive.createSink();
    const second = archive.createSink();
    first.declare(declaration);
    second.declare(declaration);
    first.publish({
      row: 0,
      outputs: [{outputId: 0, channels: [1]}],
      effects: [],
      provisional: false,
    });
    second.publish({
      row: 0,
      outputs: [{outputId: 0, channels: [2]}],
      effects: [],
      provisional: false,
    });
    expect(archive.usedBytes).toBe(first.bytesUsed + second.bytesUsed);
    expect(() => first.declare(declaration)).toThrow('more than once');

    archive.reset();
    expect(archive.usedBytes).toBe(0);
    expect(first.bytesUsed).toBe(0);
    expect(second.bytesUsed).toBe(0);
  });

  test('dictionary-codes repeated strings without retaining them twice', () => {
    const archive = new TrajectoryArchive({maxBytes: 1 << 20});
    const sink = archive.createSink();
    sink.declare(declaration);
    sink.publish({
      row: 0,
      outputs: [{outputId: 3, channels: ['same']}],
      effects: [],
      provisional: false,
    });
    const afterFirst = archive.usedBytes;
    sink.publish({
      row: 1,
      outputs: [{outputId: 3, channels: ['same']}],
      effects: [],
      provisional: false,
    });
    expect(archive.usedBytes).toBe(afterFirst);
  });

  test('rejects repeated dictionary-string expansion before materialization', () => {
    const archive = new TrajectoryArchive({maxBytes: 1024 * 1024});
    const sink = archive.createSink();
    const stringDeclaration: ExecutionDeclaration = {
      outputs: [
        {
          spec: {
            effect: 'plot',
            staticArgs: [],
            channels: [
              {name: 'note', type: 'string', transport: {kind: 'string'}},
            ],
          },
          boundArgs: [],
        },
      ],
      effects: [],
    };
    sink.declare(stringDeclaration);
    const repeated = 'x'.repeat(100_000);
    for (let row = 0; row < 10_000; row += 1) {
      sink.publish({
        row,
        outputs: [{outputId: 0, channels: [repeated]}],
        effects: [],
        provisional: false,
      });
    }
    expect(archive.usedBytes).toBeLessThan(archive.maxBytes);

    let failure: unknown;
    try {
      sink.trajectory(binding(10_000));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TrajectoryArchiveProjectionBudgetError);
    expect(failure).toMatchObject({maxBytes: archive.maxBytes});
    expect(
      (failure as TrajectoryArchiveProjectionBudgetError).estimatedBytes,
    ).toBeGreaterThan(archive.maxBytes);
  });

  test.each([
    [
      'enum',
      {
        kind: 'enum',
        name: 'broker.Side',
        members: ['buy', 'sell'],
      } satisfies OutputChannelTransport,
      true,
    ],
    [
      'resource',
      {kind: 'resource', handle: 'line'} satisfies OutputChannelTransport,
      false,
    ],
    [
      'output-ref',
      {kind: 'output-ref', output: 'plot'} satisfies OutputChannelTransport,
      false,
    ],
    [
      'user-type',
      {kind: 'user-type', name: 'Point'} satisfies OutputChannelTransport,
      false,
    ],
    ['array', {kind: 'array'} satisfies OutputChannelTransport, false],
    ['matrix', {kind: 'matrix'} satisfies OutputChannelTransport, false],
    ['map', {kind: 'map'} satisfies OutputChannelTransport, false],
    ['tuple', {kind: 'tuple'} satisfies OutputChannelTransport, false],
  ] as const)(
    'checks %s transport eligibility before reserving storage',
    (kind, transport, supported) => {
      const archive = new TrajectoryArchive({maxBytes: 1 << 20});
      const sink = archive.createSink();
      const candidate: ExecutionDeclaration = {
        outputs: [
          {
            spec: {effect: 'empty', staticArgs: [], channels: []},
            boundArgs: [],
          },
          {
            spec: {
              effect: 'candidate',
              staticArgs: [],
              channels: [
                {name: 'scalar', type: 'float', transport: {kind: 'float'}},
                {name: kind, type: kind, transport},
              ],
            },
            boundArgs: [],
          },
        ],
        effects: [],
      };
      if (supported) {
        sink.declare(candidate);
        sink.publish({
          row: 0,
          outputs: [{outputId: 1, channels: [1, 'buy']}],
          effects: [],
          provisional: false,
        });
        expect(sink.trajectory(binding(1)).outputs[1]!.values).toEqual(['buy']);
        return;
      }

      let failure: unknown;
      try {
        sink.declare(candidate);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(
        TrajectoryArchiveUnsupportedTransportError,
      );
      expect(failure).toMatchObject({
        outputId: 1,
        channel: 1,
        transport: kind,
      });
      expect(archive.usedBytes).toBe(0);
      expect(sink.bytesUsed).toBe(0);
    },
  );

  test('does not retain bound aggregate or resource values', () => {
    const declarationWithBoundResource: ExecutionDeclaration = {
      outputs: [
        {
          spec: {
            effect: 'plot',
            staticArgs: [],
            channels: [
              {name: 'series', type: 'float', transport: {kind: 'float'}},
            ],
          },
          boundArgs: [
            {
              name: 'runtime-resource',
              value: {kind: 'resource', handle: 'line', id: 99},
            },
          ],
        },
      ],
      effects: [],
    };
    const archive = new TrajectoryArchive({maxBytes: 1 << 20});
    const sink = archive.createSink();
    sink.declare(declarationWithBoundResource);
    expect(sink.snapshot(0).declaration.outputs[0]!.boundArgs).toEqual([]);
  });

  test('keeps the representative daily sweep archive below 40 MiB', () => {
    const mib = 1024 * 1024;
    const archive = new TrajectoryArchive({maxBytes: 40 * mib});
    const numericDeclaration: ExecutionDeclaration = {
      outputs: [
        {
          spec: {
            effect: 'plot',
            staticArgs: [],
            channels: Array.from({length: 13}, (_, index) => ({
              name: `value${index}`,
              type: 'float',
              transport: {kind: 'float' as const},
            })),
          },
          boundArgs: [],
        },
      ],
      effects: [],
    };
    const values = Array.from({length: 13}, (_, index) => index + 0.5);
    let selected: ReturnType<TrajectoryArchive['createSink']> | undefined;
    for (let execution = 0; execution < 100; execution += 1) {
      const sink = archive.createSink();
      selected ??= sink;
      sink.declare(numericDeclaration);
      for (let row = 0; row < 3_283; row += 1) {
        sink.publish({
          row,
          time: 1_500_000_000_000 + row * 86_400_000,
          outputs: [{outputId: 0, channels: values}],
          effects: [],
          provisional: false,
        });
      }
    }
    expect(archive.usedBytes).toBeGreaterThan(35 * mib);
    expect(archive.usedBytes).toBeLessThan(40 * mib);
    expect(selected!.trajectory(binding(3_283)).outputs).toHaveLength(13);
    archive.reset();
    expect(archive.usedBytes).toBe(0);
  });
});
