// Purpose: The public executor lowers one generic Program, preserves binding order, and reports backend-neutral results.

import {describe, expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {csvProvider} from '../providers/data/csv';
import {MemorySink} from '../providers/sinks/memory-sink';
import {executeProgram, UnsupportedExecutionBackendError} from './execute';

describe('executeProgram', () => {
  test('executes ordered CPU bindings and reports resolved inputs', async () => {
    const program = mustBuild(
      [
        'indicator("executor")',
        'scale = input.float(2.0)',
        'plot(close * scale)',
      ].join('\n'),
    );
    const first = new MemorySink();
    const second = new MemorySink();

    const result = await executeProgram(
      program,
      [
        {
          params: {},
          provider: csvProvider('time,close\n100,1\n200,2\n'),
          sink: first,
          timeNow: 1_800_000_000_000,
        },
        {
          params: {scale: 3},
          provider: csvProvider('close\n4\n'),
          sink: second,
          timeNow: 1_800_000_000_000,
        },
      ],
      {kind: 'cpu'},
    );

    expect(result.backend).toBe('cpu');
    expect(result.numericProfile).toBe('js-f64');
    expect(result.bindings.map(binding => binding.bindingIndex)).toEqual([
      0, 1,
    ]);
    expect(result.bindings.map(binding => binding.rows)).toEqual([2, 1]);
    expect(
      result.bindings.map(binding => binding.inputs.map(input => input.value)),
    ).toEqual([[2], [3]]);
    expect(first.emissions.map(emission => emission.channels[0])).toEqual([
      2, 4,
    ]);
    expect(first.publications.map(publication => publication.time)).toEqual([
      100, 200,
    ]);
    expect(second.publications.map(publication => publication.time)).toEqual([
      undefined,
    ]);
    expect(second.emissions.map(emission => emission.channels[0])).toEqual([
      12,
    ]);
    expect(result.timing.loweringMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.executionMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(
      result.timing.loweringMs + result.timing.executionMs,
    );
  });

  test('rejects an ineligible GPU Program before using the device', async () => {
    const program = mustBuild(
      'value = request.security("X", "D", close)\nplot(value)',
    );

    try {
      await executeProgram(program, [], {
        kind: 'gpu',
        device: null as unknown as GPUDevice,
      });
      throw new Error('expected GPU lowering to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedExecutionBackendError);
      expect((error as UnsupportedExecutionBackendError).issues.length).toBe(1);
      expect(
        (error as UnsupportedExecutionBackendError).issues[0]?.message.length,
      ).toBeGreaterThan(0);
    }
  });

  test('reports an empty eligible GPU execution without creating device resources', async () => {
    const device = {
      limits: {
        maxComputeInvocationsPerWorkgroup: 256,
        maxComputeWorkgroupSizeX: 256,
        maxComputeWorkgroupStorageSize: 64 * 1024,
        maxBufferSize: 256 * 1024 * 1024,
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
      },
    } as unknown as GPUDevice;
    const result = await executeProgram(mustBuild('plot(close)'), [], {
      kind: 'gpu',
      device,
    });

    expect(result.backend).toBe('gpu');
    expect(result.numericProfile).toBe('wgsl-f32-i32');
    expect(result.bindings).toEqual([]);
    if (result.backend !== 'gpu') {
      throw new Error('expected GPU execution summary');
    }
    expect(result.chunks).toBe(0);
    expect(result.dispatches).toBe(0);
    expect(result.timing.preparationMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.encodeSubmitMs).toBe(0);
    expect(result.timing.completionReadbackMs).toBe(0);
    expect(result.timing.decodePublicationMs).toBe(0);
    expect(result.cache).toEqual(
      expect.objectContaining({
        mode: expect.stringMatching(/^(storage-only|workgroup-prefix)$/),
        workgroupSize: expect.any(Number),
        cachedBytesPerExecution: expect.any(Number),
        bytesPerWorkgroup: expect.any(Number),
        segmentIds: expect.any(Array),
      }),
    );
  });
});
