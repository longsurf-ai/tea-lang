// Purpose: Real Dawn parity for concrete GPU bindings and complete Datums.

/// <reference types="@webgpu/types" />

import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {create, globals} from 'webgpu';
import {generate} from '../../codegen/codegen';
import {compileProgramToWgsl} from '../../codegen/wgsl';
import type {CompiledWgslProgram} from '../../gpu/contract';
import type {Program} from '../../ir/program';
import {mustBuild} from '../../noder/testing';
import {MemorySink} from '../../sinks/memory-sink';
import {arrayStream, executeTestModule} from '../../testing/batch';
import {loadModule} from '../load';
import {
  createGpuExecution,
  type GpuBinding,
  type GpuRunSummary,
} from './session';

let sharedDevice: Promise<GPUDevice> | null = null;

after(async () => {
  if (sharedDevice !== null) (await sharedDevice).destroy();
});

test('reference-struct strategies fail closed before Dawn execution', () => {
  const result = compileProgramToWgsl(
    mustBuild(
      [
        'strategy("GPU struct boundary")',
        'import broker',
        'import portfolio',
        'import trade',
        'var state = trade.nextOpen(broker.new(), portfolio.new())',
        'state.begin_bar(close, bar_index)',
      ].join('\n'),
    ),
  );
  assert.equal(result.status, 'staged-unsupported');
});

test('Dawn consumes concrete bindings and preserves outputs and time', async () => {
  const program = mustBuild('plot(close)');
  const bindings = [
    binding({close: [10, 20, 30, 40]}, {}, [100, 200, 300, 400]),
  ];

  const {summary, gpuSinks} = await assertParity(program, bindings);
  assert.deepEqual(
    gpuSinks[0]!.publications.map(datum => datum.time),
    [100, 200, 300, 400],
  );
  assert.equal(gpuSinks[0]!.effectEmissions.length, 0);
  assert.equal(summary.chunks, 1);
  assert.equal(summary.dispatches, 1);
});

async function assertParity(
  program: Program,
  bindings: readonly GpuBinding[],
): Promise<{
  readonly summary: GpuRunSummary;
  readonly cpuSinks: readonly MemorySink[];
  readonly gpuSinks: readonly MemorySink[];
}> {
  const artifact = compiledArtifact(program);
  const module = loadModule(generate(program));
  const cpuSinks = bindings.map(() => new MemorySink());
  for (const [index, input] of bindings.entries()) {
    await executeTestModule(module, {
      params: input.params,
      stream: arrayStream(
        input.series,
        input.time?.map(value => {
          if (value === null) throw new Error('CPU parity time is null');
          return value;
        }),
      ),
      sink: cpuSinks[index]!,
      timeNow: 0,
    });
  }

  const gpuSinks = bindings.map(() => new MemorySink());
  const concrete = bindings.map((input, index) => ({
    ...input,
    sink: gpuSinks[index]!,
  }));
  const gpu = await dawn();
  const execution = await createGpuExecution(gpu.device, artifact, concrete);
  try {
    const summary = await execution.runAll();
    cpuSinks.forEach((expected, index) =>
      assert.deepEqual(normalize(gpuSinks[index]!), normalize(expected)),
    );
    return {summary, cpuSinks, gpuSinks};
  } finally {
    execution.dispose();
  }
}

function binding(
  series: Readonly<Record<string, readonly number[]>>,
  params: Readonly<Record<string, unknown>> = {},
  time?: readonly number[],
): GpuBinding {
  return {
    params,
    indices: Object.values(series)[0]?.length ?? time?.length ?? 0,
    series,
    ...(time === undefined ? {} : {time}),
    sink: new MemorySink(),
  };
}

function compiledArtifact(program: Program): CompiledWgslProgram {
  const compiled = compileProgramToWgsl(program);
  if (compiled.status !== 'compiled') {
    throw new Error(JSON.stringify(compiled.eligibility.issues));
  }
  return compiled.artifact;
}

async function dawn(): Promise<{readonly device: GPUDevice}> {
  if (sharedDevice === null) {
    Object.assign(globalThis, globals);
    sharedDevice = (async () => {
      const gpu = create([]);
      const adapter = await gpu.requestAdapter();
      assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
      return adapter.requestDevice();
    })();
  }
  return {device: await sharedDevice};
}

function normalize(sink: MemorySink): unknown {
  return {
    outputs: sink.outputs,
    effects: sink.effectSchemas,
    publications: sink.publications.map(datum => ({
      index: datum.index,
      time: datum.time,
      outputs: datum.outputs.map(output => ({
        outputId: output.outputId,
        channels: output.channels.map(value =>
          typeof value === 'number' && Number.isNaN(value) ? 'na' : value,
        ),
      })),
      effects: datum.effects,
      provisional: datum.provisional,
    })),
  };
}
