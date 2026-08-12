// Purpose: Verify generic GPU session preparation resolves providers, packs lanes, and bounds all device resources.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import type {CompiledWgslProgram} from '../../codegen/wgsl/types';
import {compileProgramToWgsl} from '../../codegen/wgsl';
import {mustBuild} from '../../noder/testing';
import {MemorySink} from '../../providers/sinks/memory-sink';
import type {
  BindInputs,
  ContextError,
  DataProvider,
  ProviderContext,
  SeriesData,
} from '../abi';
import {GpuBindingError, prepareGpuExecutionInputs} from './session';

function strategyArtifact(): CompiledWgslProgram {
  const source = readFileSync(
    join(
      import.meta.dir,
      '../../../testdata/execution/compile/strategy-components/source.tea',
    ),
    'utf8',
  );
  const result = compileProgramToWgsl(mustBuild(source));
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact;
}

function resultlessArtifact(): CompiledWgslProgram {
  const result = compileProgramToWgsl(
    mustBuild(`indicator("resultless")
var float sum = 0
sum := sum + close`),
  );
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact;
}

function parameterArtifact(): CompiledWgslProgram {
  const result = compileProgramToWgsl(
    mustBuild(
      [
        'strategy("parameters")',
        'enum Mode',
        '    fast = "Fast"',
        '    slow = "Slow"',
        'length = input.int(2, minval=1, maxval=5)',
        'scale = input.float(1.5)',
        'enabled = input.bool(true)',
        'mode = input.enum(Mode.fast)',
        'var float seed = length + scale',
        'plot(enabled and mode == Mode.fast ? close * length + seed : 0)',
      ].join('\n'),
    ),
  );
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact;
}

function context(
  columns: Readonly<Record<string, readonly number[]>>,
  rows = Object.values(columns)[0]?.length ?? 0,
): ProviderContext {
  return {
    rows,
    axis: null,
    series(id): SeriesData | null {
      const values = columns[id];
      return values === undefined
        ? null
        : {length: values.length, at: row => values[row] ?? NaN};
    },
    builtinValue: () => undefined,
  };
}

function binding(provider: DataProvider): BindInputs {
  return {
    params: {},
    provider,
    sink: new MemorySink(),
    timeNow: 0,
    symbol: 'TEST',
    timeframe: 'D',
  };
}

describe('GPU execution preparation', () => {
  test('packs an actual strategy artifact in caller lane and artifact series order', async () => {
    const artifact = strategyArtifact();
    expect(artifact.maxEffectsPerRow).toBe(5);
    const requested: Array<readonly [string, string]> = [];
    const columns = {
      open: [10, 11, 12],
      close: [20, 21, 22],
    } as const;
    const provider: DataProvider = {
      async resolveContext(symbol, timeframe) {
        requested.push([symbol, timeframe]);
        return context(columns);
      },
    };
    const prepared = await prepareGpuExecutionInputs(
      artifact,
      [binding(provider), binding(provider)],
      {maxRowsPerChunk: 3, effectRecordsPerLane: 10},
    );

    expect(requested).toEqual([['TEST', 'D']]);
    expect(prepared.lanes.map(lane => lane.bindingIndex)).toEqual([0, 1]);
    expect(prepared.lanes.map(lane => lane.seriesOffset)).toEqual([0, 0]);
    expect(prepared.chunkRows).toBe(2);
    expect(prepared.effectRecordsPerLane).toBe(10);

    const series = new DataView(
      prepared.seriesPayload.buffer,
      prepared.seriesPayload.byteOffset,
      prepared.seriesPayload.byteLength,
    );
    const expectedFirstLane = artifact.requiredSeries.flatMap(required => [
      ...columns[required.id as keyof typeof columns],
    ]);
    expect(
      expectedFirstLane.map((_, index) => series.getFloat32(index * 4, true)),
    ).toEqual(expectedFirstLane);

    const descriptors = new DataView(
      prepared.descriptorPayload.buffer,
      prepared.descriptorPayload.byteOffset,
      prepared.descriptorPayload.byteLength,
    );
    const offsets = artifact.jobDescriptorOffsets;
    expect([
      descriptors.getUint32(offsets.rowCount, true),
      descriptors.getUint32(offsets.resultOffset, true),
      descriptors.getUint32(offsets.resultCount, true),
      descriptors.getUint32(offsets.effectOffset, true),
      descriptors.getUint32(offsets.effectCapacity, true),
      descriptors.getUint32(offsets.chunkRows, true),
      descriptors.getUint32(offsets.paramsOffset, true),
    ]).toEqual([3, 0, 2 * artifact.resultChannels.length, 0, 10, 2, 0]);
    const second = artifact.jobDescriptorByteStride;
    expect([
      descriptors.getUint32(second + offsets.resultOffset, true),
      descriptors.getUint32(second + offsets.effectOffset, true),
    ]).toEqual([2 * artifact.resultChannels.length, 10]);

    expect(prepared.resources.readbackResults).toBe(prepared.resources.results);
    expect(prepared.resources.readbackEffectStatus).toBe(
      prepared.resources.effectStatus,
    );
    expect(prepared.resources.readbackEffectRecords).toBe(
      prepared.resources.effectRecords,
    );
    expect(prepared.resources.total).toBe(
      Object.entries(prepared.resources)
        .filter(([name]) => name !== 'total')
        .reduce((sum, [, value]) => sum + value, 0),
    );
  });

  test('resolves, packs, and reports fixed-width parameters for shared-context lanes', async () => {
    const artifact = parameterArtifact();
    let resolutions = 0;
    const provider: DataProvider = {
      resolveContext: async () => {
        resolutions += 1;
        return context({close: [10, 20]});
      },
    };
    const defaults = binding(provider);
    const override = {
      ...binding(provider),
      params: {length: 4, scale: 2.25, enabled: false, mode: 'slow'},
    };
    const prepared = await prepareGpuExecutionInputs(
      artifact,
      [defaults, override],
      {maxRowsPerChunk: 2},
    );

    expect(resolutions).toBe(1);
    expect(prepared.lanes.map(lane => lane.seriesOffset)).toEqual([0, 0]);
    expect(prepared.seriesPayload.byteLength).toBe(2 * 4);
    expect(prepared.lanes.map(lane => lane.paramsOffset)).toEqual([0, 4]);
    expect(
      prepared.lanes.map(lane =>
        lane.boundInputs.map(input => [input.spec.name, input.value]),
      ),
    ).toEqual([
      [
        ['length', 2],
        ['scale', 1.5],
        ['enabled', true],
        ['mode', 'fast'],
      ],
      [
        ['length', 4],
        ['scale', 2.25],
        ['enabled', false],
        ['mode', 'slow'],
      ],
    ]);
    const params = new DataView(
      prepared.paramPayload.buffer,
      prepared.paramPayload.byteOffset,
      prepared.paramPayload.byteLength,
    );
    expect([
      params.getInt32(0, true),
      params.getFloat32(4, true),
      params.getUint32(8, true),
      params.getUint32(12, true),
      params.getInt32(16, true),
      params.getFloat32(20, true),
      params.getUint32(24, true),
      params.getUint32(28, true),
    ]).toEqual([2, 1.5, 1, 0, 4, 2.25, 0, 1]);
    const descriptors = new DataView(
      prepared.descriptorPayload.buffer,
      prepared.descriptorPayload.byteOffset,
      prepared.descriptorPayload.byteLength,
    );
    expect(
      descriptors.getUint32(artifact.jobDescriptorOffsets.paramsOffset, true),
    ).toBe(0);
    expect(
      descriptors.getUint32(
        artifact.jobDescriptorByteStride +
          artifact.jobDescriptorOffsets.paramsOffset,
        true,
      ),
    ).toBe(4);
  });

  test('derives a smaller chunk from the effect bound and total GPU budget', async () => {
    const artifact = strategyArtifact();
    const provider: DataProvider = {
      resolveContext: async () => context({open: [1, 2, 3], close: [4, 5, 6]}),
    };
    const twoRows = await prepareGpuExecutionInputs(
      artifact,
      [binding(provider)],
      {maxRowsPerChunk: 2},
    );
    const oneRow = await prepareGpuExecutionInputs(
      artifact,
      [binding(provider)],
      {maxRowsPerChunk: 3, maxGpuBytes: twoRows.resources.total - 1},
    );
    expect(oneRow.chunkRows).toBe(1);
    expect(oneRow.effectRecordsPerLane).toBe(artifact.maxEffectsPerRow);
    expect(oneRow.resources.total).toBeLessThan(twoRows.resources.total);
    await expect(
      prepareGpuExecutionInputs(artifact, [binding(provider)], {
        effectRecordsPerLane: artifact.maxEffectsPerRow - 1,
      }),
    ).rejects.toThrow(/cannot hold one row/);
  });

  test('keeps empty and zero-row binding sets inert', async () => {
    const artifact = strategyArtifact();
    const empty = await prepareGpuExecutionInputs(artifact, []);
    expect(empty).toMatchObject({
      lanes: [],
      chunkRows: 0,
      effectRecordsPerLane: 0,
      resources: {total: 0},
    });
    const zero = await prepareGpuExecutionInputs(artifact, [
      binding({resolveContext: async () => context({open: [], close: []})}),
    ]);
    expect(zero.lanes[0]?.rows).toBe(0);
    expect(zero.resources.total).toBe(0);
  });

  test('uses shader element strides for logically empty bound buffers', async () => {
    const artifact = resultlessArtifact();
    expect(artifact.resultChannels).toHaveLength(0);
    expect(artifact.maxEffectsPerRow).toBe(0);
    const prepared = await prepareGpuExecutionInputs(artifact, [
      binding({resolveContext: async () => context({close: [7]})}),
    ]);
    expect(prepared.resources.results).toBe(artifact.resultCellByteStride);
    expect(prepared.resources.effectRecords).toBe(
      artifact.effectRecordByteStride,
    );
    expect(prepared.resources.readbackResults).toBe(
      artifact.resultCellByteStride,
    );
    expect(prepared.resources.readbackEffectRecords).toBe(
      artifact.effectRecordByteStride,
    );
  });

  test('reports provider, parameter, and required-series failures before allocation', async () => {
    const artifact = strategyArtifact();
    const failure: ContextError = {
      error: 'unknownSymbol',
      detail: 'NOPE',
    };
    await expect(
      prepareGpuExecutionInputs(artifact, [
        binding({resolveContext: async () => failure}),
      ]),
    ).rejects.toThrow('GPU binding 0 context failed (unknownSymbol): NOPE');
    const params = parameterArtifact();
    await expect(
      prepareGpuExecutionInputs(params, [
        {
          ...binding({resolveContext: async () => context({close: [1]})}),
          params: {length: 9},
        },
      ]),
    ).rejects.toThrow(/above maxval 5/);
    await expect(
      prepareGpuExecutionInputs(artifact, [
        binding({resolveContext: async () => context({open: [1]})}),
      ]),
    ).rejects.toThrow("missing required series 'close'");
  });

  test('rejects series extent and non-f32 payload mismatches', async () => {
    const artifact = strategyArtifact();
    await expect(
      prepareGpuExecutionInputs(artifact, [
        binding({
          resolveContext: async () => context({open: [1, 2], close: [3]}, 2),
        }),
      ]),
    ).rejects.toThrow(/has 1 rows; expected 2/);
    await expect(
      prepareGpuExecutionInputs(artifact, [
        binding({
          resolveContext: async () =>
            context({open: [1], close: [Number.POSITIVE_INFINITY]}),
        }),
      ]),
    ).rejects.toThrow(GpuBindingError);
  });

  test('rejects malformed physical strides and effect schema ids', async () => {
    const artifact = strategyArtifact();
    await expect(
      prepareGpuExecutionInputs({...artifact, laneStateByteStride: 4}, []),
    ).rejects.toThrow(/laneStateByteStride 4 is below minimum 8/);
    const malformedEffects = artifact.effectSchemas.map((schema, index) =>
      index === 0 ? {...schema, effectId: 99} : schema,
    );
    await expect(
      prepareGpuExecutionInputs(
        {...artifact, effectSchemas: malformedEffects},
        [],
      ),
    ).rejects.toThrow(/invalid effect schema 0/);
    const first = artifact.effectSchemas[0]!;
    if (first.declaration.payload.kind !== 'user-type') {
      throw new Error('strategy effect 0 must be a user type');
    }
    const forgedNominal = [
      {
        ...first,
        declaration: {
          payload: {...first.declaration.payload, typeId: 'forged.Other'},
        },
      },
      ...artifact.effectSchemas.slice(1),
    ];
    await expect(
      prepareGpuExecutionInputs(
        {...artifact, effectSchemas: forgedNominal},
        [],
      ),
    ).rejects.toThrow(/logical declaration disagrees/);
    await expect(
      prepareGpuExecutionInputs({...artifact, maxEffectsPerRow: 0}, []),
    ).rejects.toThrow(/effect schemas disagree with maxEffectsPerRow/);
    const resultless = resultlessArtifact();
    await expect(
      prepareGpuExecutionInputs({...resultless, maxEffectsPerRow: 1}, []),
    ).rejects.toThrow(/effect schemas disagree with maxEffectsPerRow/);
  });
});
