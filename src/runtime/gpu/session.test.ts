// Purpose: Verify generic GPU session preparation resolves providers, packs executions, and bounds all device resources.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import type {CompiledWgslProgram} from '../../gpu/contract';
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
import {
  createGpuExecution,
  GpuBindingError,
  planGpuWorkgroupCache,
  prepareGpuExecutionInputs,
} from './session';

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

function manySegmentArtifact(): CompiledWgslProgram {
  const localCount = 32;
  const result = compileProgramToWgsl(
    mustBuild(
      [
        'indicator("many cache segments")',
        ...Array.from(
          {length: localCount},
          (_, index) => `value${index} = close + ${index}.0`,
        ),
        `plot(value${localCount - 1})`,
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

function binding(
  provider: DataProvider,
  sink: BindInputs['sink'] = new MemorySink(),
): BindInputs {
  return {
    params: {},
    provider,
    sink,
    timeNow: 0,
    symbol: 'TEST',
    timeframe: 'D',
  };
}

class FinalDenseMemorySink extends MemorySink {
  readonly capabilities = {denseRows: 'final'} as const;
}

describe('GPU execution preparation', () => {
  test('selects zero, whole partial, and full ranked cache prefixes', () => {
    const artifact = parameterArtifact();
    const limits = {
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupStorageSize: 64 * 1024,
    };
    const zero = planGpuWorkgroupCache(artifact, 8, limits, {
      maxCacheBytesPerWorkgroup: 0,
    });
    expect(zero).toMatchObject({
      mode: 'storage-only',
      entryPoint: artifact.cache.storageEntryPoint,
      cachedWordsPerExecution: 0,
      bytesPerWorkgroup: 0,
      segmentIds: [],
    });
    const first = artifact.cache.segments[0]!;
    const partial = planGpuWorkgroupCache(artifact, 8, limits, {
      maxCacheBytesPerWorkgroup: first.cacheEnd * 8 * 4,
    });
    expect(partial.segmentIds).toEqual([first.id]);
    expect(partial.cachedWordsPerExecution).toBe(first.cacheEnd);
    const full = planGpuWorkgroupCache(artifact, 8, limits, {
      maxCacheBytesPerWorkgroup:
        artifact.state.wordsPerExecution * 8 * Uint32Array.BYTES_PER_ELEMENT,
    });
    expect(full.segmentIds).toEqual(
      artifact.cache.segments.map(segment => segment.id),
    );
    expect(full.cachedWordsPerExecution).toBe(artifact.state.wordsPerExecution);
  });

  test('keeps a one-execution workgroup on authoritative storage', () => {
    const artifact = parameterArtifact();
    const placement = planGpuWorkgroupCache(
      artifact,
      1,
      {
        maxComputeInvocationsPerWorkgroup: 256,
        maxComputeWorkgroupSizeX: 256,
        maxComputeWorkgroupStorageSize: 64 * 1024,
      },
      {maxCacheBytesPerWorkgroup: 64 * 1024},
    );

    expect(placement).toMatchObject({
      mode: 'storage-only',
      entryPoint: artifact.cache.storageEntryPoint,
      workgroupSize: 1,
      cachedWordsPerExecution: 0,
      bytesPerWorkgroup: 0,
      segmentIds: [],
    });
  });

  test('keeps deep cache-routing artifacts on authoritative storage', () => {
    const artifact = manySegmentArtifact();
    expect(artifact.cache.segments.length).toBeGreaterThan(16);

    const placement = planGpuWorkgroupCache(
      artifact,
      8,
      {
        maxComputeInvocationsPerWorkgroup: 256,
        maxComputeWorkgroupSizeX: 256,
        maxComputeWorkgroupStorageSize: 64 * 1024,
      },
      {maxCacheBytesPerWorkgroup: 64 * 1024},
    );

    expect(placement).toMatchObject({
      mode: 'storage-only',
      entryPoint: artifact.cache.storageEntryPoint,
      workgroupSize: 8,
      cachedWordsPerExecution: 0,
      bytesPerWorkgroup: 0,
      segmentIds: [],
    });
  });

  test('packs an actual strategy artifact in caller execution and artifact series order', async () => {
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
      {maxRowsPerChunk: 3, effectRecordsPerExecution: 10},
    );

    expect(requested).toEqual([['TEST', 'D']]);
    expect(
      prepared.executions.map(execution => execution.bindingIndex),
    ).toEqual([0, 1]);
    expect(
      prepared.executions.map(execution => execution.seriesOffset),
    ).toEqual([0, 0]);
    expect(prepared.chunkRows).toBe(2);
    expect(prepared.effectRecordsPerExecution).toBe(10);

    const series = new DataView(
      prepared.seriesPayload.buffer,
      prepared.seriesPayload.byteOffset,
      prepared.seriesPayload.byteLength,
    );
    const expectedFirstExecution = artifact.requiredSeries.flatMap(required => [
      ...columns[required.id as keyof typeof columns],
    ]);
    expect(
      expectedFirstExecution.map((_, index) =>
        series.getFloat32(index * 4, true),
      ),
    ).toEqual(expectedFirstExecution);

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

  test('packs mixed complete and final-dense result ranges without chunk-sized final storage', async () => {
    const artifact = parameterArtifact();
    const provider: DataProvider = {
      resolveContext: async () => context({close: [10, 20, 30]}),
    };
    const prepared = await prepareGpuExecutionInputs(
      artifact,
      [binding(provider), binding(provider, new FinalDenseMemorySink())],
      {maxRowsPerChunk: 3},
    );
    const channels = artifact.resultChannels.length;
    expect(
      prepared.executions.map(execution => ({
        final: execution.finalDenseOnly,
        offset: execution.resultOffset,
        capacity: execution.resultCapacity,
      })),
    ).toEqual([
      {final: false, offset: 0, capacity: 3 * channels},
      {final: true, offset: 3 * channels, capacity: channels},
    ]);
    expect(prepared.resources.results).toBe(
      4 * channels * artifact.resultCellByteStride,
    );

    const descriptors = new DataView(
      prepared.descriptorPayload.buffer,
      prepared.descriptorPayload.byteOffset,
      prepared.descriptorPayload.byteLength,
    );
    const offsets = artifact.jobDescriptorOffsets;
    const second = artifact.jobDescriptorByteStride;
    expect([
      descriptors.getUint32(offsets.resultOffset, true),
      descriptors.getUint32(offsets.resultCount, true),
      descriptors.getUint32(second + offsets.resultOffset, true),
      descriptors.getUint32(second + offsets.resultCount, true),
    ]).toEqual([0, 3 * channels, 3 * channels, channels]);
  });

  test('keeps all-final sweep result transport proportional to executions, not chunk rows', async () => {
    const artifact = parameterArtifact();
    const provider: DataProvider = {
      resolveContext: async () => context({close: Array(10).fill(1)}),
    };
    const prepared = await prepareGpuExecutionInputs(
      artifact,
      Array.from({length: 4}, () =>
        binding(provider, new FinalDenseMemorySink()),
      ),
      {maxRowsPerChunk: 8},
    );
    const channels = artifact.resultChannels.length;
    expect(prepared.chunkRows).toBe(8);
    expect(
      prepared.executions.map(execution => execution.resultCapacity),
    ).toEqual(Array(4).fill(channels));
    expect(prepared.resources.results).toBe(
      4 * channels * artifact.resultCellByteStride,
    );
  });

  test('resolves, packs, and reports fixed-width parameters for shared-context executions', async () => {
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
    expect(
      prepared.executions.map(execution => execution.seriesOffset),
    ).toEqual([0, 0]);
    expect(prepared.seriesPayload.byteLength).toBe(2 * 4);
    expect(
      prepared.executions.map(execution => execution.paramsOffset),
    ).toEqual([0, 4]);
    expect(
      prepared.executions.map(execution =>
        execution.boundInputs.map(input => [input.spec.name, input.value]),
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
    expect(oneRow.effectRecordsPerExecution).toBe(artifact.maxEffectsPerRow);
    expect(oneRow.resources.total).toBeLessThan(twoRows.resources.total);
    await expect(
      prepareGpuExecutionInputs(artifact, [binding(provider)], {
        effectRecordsPerExecution: artifact.maxEffectsPerRow - 1,
      }),
    ).rejects.toThrow(/cannot hold one row/);
  });

  test('packs mixed effect-capture executions into disjoint logical ranges', async () => {
    const artifact = strategyArtifact();
    const provider: DataProvider = {
      resolveContext: async () => context({open: [1, 2], close: [3, 4]}),
    };
    const noEffects = new MemorySink();
    Object.defineProperty(noEffects, 'capabilities', {
      value: {effects: 'none'},
    });
    const prepared = await prepareGpuExecutionInputs(
      artifact,
      [
        binding(provider, noEffects),
        binding(provider),
        binding(provider, noEffects),
      ],
      {maxRowsPerChunk: 2},
    );

    expect(
      prepared.executions.map(execution => ({
        captures: execution.capturesEffects,
        offset: execution.effectOffset,
        capacity: execution.effectCapacity,
      })),
    ).toEqual([
      {captures: false, offset: 0, capacity: 0},
      {captures: true, offset: 0, capacity: 2 * artifact.maxEffectsPerRow},
      {captures: false, offset: 0, capacity: 0},
    ]);
    expect(prepared.effectRecordCount).toBe(2 * artifact.maxEffectsPerRow);
    const descriptors = new DataView(
      prepared.descriptorPayload.buffer,
      prepared.descriptorPayload.byteOffset,
      prepared.descriptorPayload.byteLength,
    );
    const {effectOffset, effectCapacity} = artifact.jobDescriptorOffsets;
    expect(
      prepared.executions.map((_, index) => {
        const base = index * artifact.jobDescriptorByteStride;
        return [
          descriptors.getUint32(base + effectOffset, true),
          descriptors.getUint32(base + effectCapacity, true),
        ];
      }),
    ).toEqual([
      [0, 0],
      [0, 2 * artifact.maxEffectsPerRow],
      [0, 0],
    ]);
  });

  test('all-none effect capture uses zero logical records and ignores effect capacity', async () => {
    const artifact = strategyArtifact();
    const provider: DataProvider = {
      resolveContext: async () => context({open: [1, 2], close: [3, 4]}),
    };
    const noEffects = new MemorySink();
    Object.defineProperty(noEffects, 'capabilities', {
      value: {effects: 'none'},
    });
    const prepared = await prepareGpuExecutionInputs(
      artifact,
      [binding(provider, noEffects)],
      {maxRowsPerChunk: 2, effectRecordsPerExecution: 0},
    );

    expect(prepared.effectRecordsPerExecution).toBe(0);
    expect(prepared.effectRecordCount).toBe(0);
    expect(prepared.executions[0]).toMatchObject({
      capturesEffects: false,
      effectOffset: 0,
      effectCapacity: 0,
    });
    expect(prepared.resources.effectRecords).toBe(
      artifact.effectRecordByteStride,
    );
  });

  test('keeps empty and zero-row binding sets inert', async () => {
    const artifact = strategyArtifact();
    const empty = await prepareGpuExecutionInputs(artifact, []);
    expect(empty).toMatchObject({
      executions: [],
      chunkRows: 0,
      effectRecordsPerExecution: 0,
      resources: {total: 0},
    });
    const zero = await prepareGpuExecutionInputs(artifact, [
      binding({resolveContext: async () => context({open: [], close: []})}),
    ]);
    expect(zero.executions[0]?.rows).toBe(0);
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

  test('uses a throughput-oriented default chunk ceiling', async () => {
    const artifact = resultlessArtifact();
    const rows = 70_000;
    const prepared = await prepareGpuExecutionInputs(artifact, [
      binding({
        resolveContext: async () =>
          context({close: Array.from({length: rows}, () => 0)}, rows),
      }),
    ]);
    expect(prepared.chunkRows).toBe(65_536);
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

  test('validates every required series handle before reading any cells', async () => {
    const artifact = strategyArtifact();
    let reads = 0;
    const open: SeriesData = {
      length: 2,
      at: row => {
        reads += 1;
        return row + 1;
      },
    };
    await expect(
      prepareGpuExecutionInputs(artifact, [
        binding({
          resolveContext: async () => ({
            rows: 2,
            axis: null,
            series: id => (id === 'open' ? open : null),
            builtinValue: () => undefined,
          }),
        }),
      ]),
    ).rejects.toThrow("missing required series 'close'");
    expect(reads).toBe(0);

    await expect(
      prepareGpuExecutionInputs(artifact, [
        binding({
          resolveContext: async () => ({
            rows: 2,
            axis: null,
            series: id =>
              id === 'open' ? open : {length: 1, at: () => (reads += 1)},
            builtinValue: () => undefined,
          }),
        }),
      ]),
    ).rejects.toThrow("series 'close' has 1 rows; expected 2");
    expect(reads).toBe(0);
  });

  test('fails oversized series payloads before reading provider cells', async () => {
    const artifact = strategyArtifact();
    let reads = 0;
    const rows = 1_000_000;
    const provider: DataProvider = {
      async resolveContext() {
        return {
          rows,
          axis: null,
          series(): SeriesData {
            return {length: rows, at: () => (reads += 1)};
          },
          builtinValue: () => undefined,
        };
      },
    };
    await expect(
      prepareGpuExecutionInputs(artifact, [binding(provider)], {
        maxGpuBytes: 1024,
      }),
    ).rejects.toThrow(/series payload requires .* above maxGpuBytes 1024/);
    expect(reads).toBe(0);
  });

  test('fails a complete minimum-resource budget before reading provider cells', async () => {
    const artifact = resultlessArtifact();
    let reads = 0;
    const rows = 1_000;
    const provider: DataProvider = {
      async resolveContext() {
        return {
          rows,
          axis: null,
          series(): SeriesData {
            return {length: rows, at: () => (reads += 1)};
          },
          builtinValue: () => undefined,
        };
      },
    };
    const seriesBytes = rows * artifact.seriesScalarByteStride;
    await expect(
      prepareGpuExecutionInputs(artifact, [binding(provider)], {
        maxRowsPerChunk: 1,
        // The packed series itself fits. Descriptors, execution state, and
        // the minimum one-row transports do not.
        maxGpuBytes: seriesBytes + 1,
      }),
    ).rejects.toThrow(/cannot fit one row/);
    expect(reads).toBe(0);
  });

  test('fails device buffer limits before reading provider cells', async () => {
    const artifact = resultlessArtifact();
    let reads = 0;
    const rows = 1_000;
    const provider: DataProvider = {
      async resolveContext() {
        return {
          rows,
          axis: null,
          series(): SeriesData {
            return {length: rows, at: () => (reads += 1)};
          },
          builtinValue: () => undefined,
        };
      },
    };
    const device = {
      limits: {
        maxBufferSize: 1024,
        maxStorageBufferBindingSize: 1024,
      },
    } as unknown as GPUDevice;
    await expect(
      createGpuExecution(device, artifact, [binding(provider)]),
    ).rejects.toThrow(
      'GPU series buffer requires 4000 bytes; device limit is 1024',
    );
    expect(reads).toBe(0);
  });

  test('shrinks full-output and effect transports to the device binding limit', async () => {
    const artifact = strategyArtifact();
    const rows = 70_000;
    let reads = 0;
    const provider: DataProvider = {
      async resolveContext() {
        return {
          rows,
          axis: null,
          series(id): SeriesData | null {
            if (id !== 'open' && id !== 'close') return null;
            return {
              length: rows,
              at: row => {
                reads += 1;
                return row;
              },
            };
          },
          builtinValue: () => undefined,
        };
      },
    };
    let reachedShaderCreation = false;
    const device = {
      limits: {
        maxBufferSize: 1024 * 1024,
        maxStorageBufferBindingSize: 1024 * 1024,
        maxComputeInvocationsPerWorkgroup: 256,
        maxComputeWorkgroupSizeX: 256,
        maxComputeWorkgroupSizeY: 256,
        maxComputeWorkgroupSizeZ: 64,
        maxComputeWorkgroupsPerDimension: 65_535,
        maxComputeWorkgroupStorageSize: 64 * 1024,
      },
      createShaderModule() {
        reachedShaderCreation = true;
        throw new Error('shader creation reached');
      },
    } as unknown as GPUDevice;

    await expect(
      createGpuExecution(
        device,
        artifact,
        Array.from({length: 32}, () => binding(provider)),
      ),
    ).rejects.toThrow('shader creation reached');
    expect(reachedShaderCreation).toBe(true);
    expect(reads).toBe(rows * artifact.requiredSeries.length);
  });

  test('rejects malformed physical strides and effect schema ids', async () => {
    const artifact = strategyArtifact();
    await expect(
      prepareGpuExecutionInputs(
        {...artifact, abi: 2} as unknown as CompiledWgslProgram,
        [],
      ),
    ).rejects.toThrow(/unsupported GPU artifact ABI 2; expected 1/);
    await expect(
      prepareGpuExecutionInputs({...artifact, executionStateByteStride: 4}, []),
    ).rejects.toThrow(/executionStateByteStride 4 is below minimum 8/);
    await expect(
      prepareGpuExecutionInputs(
        {
          ...artifact,
          state: {
            ...artifact.state,
            wordsPerExecution: artifact.state.wordsPerExecution + 1,
          },
        },
        [],
      ),
    ).rejects.toThrow(/invalid execution-state manifest/);
    const rootFrame = artifact.state.frames[0]!;
    await expect(
      prepareGpuExecutionInputs(
        {
          ...artifact,
          state: {
            ...artifact.state,
            frames: [
              {
                ...rootFrame,
                tentativeActivationWordOffset:
                  rootFrame.committedActivationWordOffset,
              },
              ...artifact.state.frames.slice(1),
            ],
          },
        },
        [],
      ),
    ).rejects.toThrow(/overlapping tentative activation range/);
    const persistentIndex = rootFrame.locals.findIndex(
      local => local.storage === 'var',
    );
    if (persistentIndex < 0) throw new Error('strategy root needs a var');
    await expect(
      prepareGpuExecutionInputs(
        {
          ...artifact,
          state: {
            ...artifact.state,
            frames: [
              {
                ...rootFrame,
                locals: rootFrame.locals.map((local, index) =>
                  index === persistentIndex
                    ? {
                        ...local,
                        historyCapacity: 0,
                        historyWordOffset: null,
                      }
                    : local,
                ),
              },
              ...artifact.state.frames.slice(1),
            ],
          },
        },
        [],
      ),
    ).rejects.toThrow(/invalid local/);
    await expect(
      prepareGpuExecutionInputs(
        {
          ...artifact,
          cache: {
            ...artifact.cache,
            segments: artifact.cache.segments.map((segment, index) =>
              index === 0
                ? {...segment, cacheEnd: segment.cacheEnd + 1}
                : segment,
            ),
          },
        },
        [],
      ),
    ).rejects.toThrow(/invalid cache segment 0/);
    const hugeRootWords = 0xffff_ffff;
    await expect(
      prepareGpuExecutionInputs(
        {
          ...artifact,
          executionStateByteStride:
            (artifact.state.rootFrameWordOffset + hugeRootWords) * 4,
          state: {
            ...artifact.state,
            wordsPerExecution:
              artifact.state.rootFrameWordOffset + hugeRootWords,
            frames: [
              {...rootFrame, wordCount: hugeRootWords},
              ...artifact.state.frames.slice(1),
            ],
          },
        },
        [],
      ),
    ).rejects.toThrow(/cache segments disagree with execution state/);
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
