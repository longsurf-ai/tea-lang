// Purpose: GPU preparation consumes concrete arrays and derives physical resources.

import {describe, expect, test} from 'vitest';
import {compileProgramToWgsl} from '../../codegen/wgsl';
import type {CompiledWgslProgram} from '../../gpu/contract';
import {mustBuild} from '../../noder/testing';
import {MemorySink} from '../../sinks/memory-sink';
import {
  GpuBindingError,
  prepareGpuExecutionInputs,
  type GpuBinding,
} from './session';

function strategyArtifact(): CompiledWgslProgram {
  const result = compileProgramToWgsl(
    mustBuild(
      [
        'strategy("GPU session")',
        'for i = 0 to 19',
        '    effect.emit(open + i)',
        'var float sum = 0',
        'sum := sum + close',
        'plot(sum)',
      ].join('\n'),
    ),
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
        'plot(enabled and mode == Mode.fast ? close * length + scale : 0)',
      ].join('\n'),
    ),
  );
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact;
}

function binding(
  series: Readonly<Record<string, readonly number[]>>,
  params: Readonly<Record<string, unknown>> = {},
): GpuBinding {
  return {
    params,
    indices: Object.values(series)[0]?.length ?? 0,
    series,
    sink: new MemorySink(),
  };
}

describe('GPU execution preparation', () => {
  test('packs concrete series in binding and artifact order', async () => {
    const artifact = strategyArtifact();
    const first = binding({open: [10, 11, 12], close: [20, 21, 22]});
    const second = binding({open: [30, 31, 32], close: [40, 41, 42]});

    const prepared = await prepareGpuExecutionInputs(artifact, [first, second]);

    expect(prepared.chunkRows).toBe(3);
    expect(prepared.effectCapacity).toBe(60);
    expect(
      prepared.executions.map(execution => execution.seriesOffset),
    ).toEqual([0, 6]);
    expect(
      prepared.executions.map(execution => execution.resultCapacity),
    ).toEqual([3, 3]);
    expect(prepared.resources.total).toBeGreaterThan(0);
  });

  test('resolves parameters from one concrete binding', async () => {
    const artifact = parameterArtifact();
    const prepared = await prepareGpuExecutionInputs(artifact, [
      binding(
        {close: [10, 20]},
        {length: 4, scale: 2.25, enabled: false, mode: 'slow'},
      ),
    ]);

    expect(
      prepared.executions[0]?.boundInputs.map(input => input.value),
    ).toEqual([4, 2.25, false, 'slow']);
  });

  test('rejects missing or misaligned concrete series', async () => {
    const artifact = strategyArtifact();
    await expect(
      prepareGpuExecutionInputs(artifact, [binding({close: [1, 2]})]),
    ).rejects.toThrow("missing required series 'open'");

    await expect(
      prepareGpuExecutionInputs(artifact, [
        {
          ...binding({open: [1, 2], close: [3, 4]}),
          series: {open: [1], close: [3, 4]},
        },
      ]),
    ).rejects.toThrow("series 'open' has 1 values; expected 2");
  });

  test('validates finite index and time lengths', async () => {
    const artifact = parameterArtifact();
    await expect(
      prepareGpuExecutionInputs(artifact, [
        {...binding({close: [1]}), indices: -1},
      ]),
    ).rejects.toBeInstanceOf(GpuBindingError);
    await expect(
      prepareGpuExecutionInputs(artifact, [
        {...binding({close: [1, 2]}), time: [100]},
      ]),
    ).rejects.toThrow('has 1 times for 2 indices');
  });

  test('keeps zero-index executions allocation-free', async () => {
    const artifact = parameterArtifact();
    const prepared = await prepareGpuExecutionInputs(artifact, [
      {params: {}, indices: 0, series: {close: []}, sink: new MemorySink()},
    ]);

    expect(prepared.chunkRows).toBe(0);
    expect(prepared.resources.total).toBe(0);
  });
});
