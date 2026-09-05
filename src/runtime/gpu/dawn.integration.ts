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
import {arrayStream, executeTestModule} from '../../testing/batch';
import {OutputCapture} from '../../testing/output';
import {loadModule} from '../load';
import {outputFields} from '../output';
import {
  createGpuExecution,
  type GpuBinding,
  type GpuRunSummary,
} from './session';

// webgpu's native backend lives only while its GPU owner remains reachable.
let sharedGpu: GPU | null = null;
let sharedDevice: Promise<GPUDevice> | null = null;

after(async () => {
  if (sharedDevice !== null) (await sharedDevice).destroy();
  sharedDevice = null;
  sharedGpu = null;
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

test('Dawn preserves Arrow enum payloads, missing values and global event order', async () => {
  const program = mustBuild(
    [
      'enum Side',
      '    buy = "Buy"',
      '    sell = "Sell"',
      'for i = 0 to 2',
      '    effect.emit(close)',
      '    effect.emit(Side.buy)',
      'plot(close)',
    ].join('\n'),
  );
  const {gpuSinks} = await assertParity(program, [
    binding({close: [10, NaN, -0]}),
  ]);
  const row = gpuSinks[0]!.publications[0]!;
  assert.deepEqual(row.effect0, [
    {ordinal: 0, payload: 10},
    {ordinal: 2, payload: 10},
    {ordinal: 4, payload: 10},
  ]);
  assert.deepEqual(row.effect1, [
    {ordinal: 1, payload: 'buy'},
    {ordinal: 3, payload: 'buy'},
    {ordinal: 5, payload: 'buy'},
  ]);
});

test('Dawn keeps bound history and persistent state separate for every binding', async () => {
  const program = mustBuild(
    [
      'lag = input.int(1, minval=0, maxval=8)',
      'previous(float value) => value[lag]',
      'var float total = 0',
      'total += close',
      'left = previous(close)',
      'right = previous(open)',
      'plot(left + right + total)',
    ].join('\n'),
  );
  const {gpuSinks} = await assertParity(program, [
    binding({close: [1, 2, 3, 4], open: [4, 3, 2, 1]}, {lag: 1}),
    binding({close: [10, 20, 30], open: [8, 9, 10]}, {lag: 2}),
  ]);
  assert.deepEqual(
    gpuSinks.map(sink => sink.emissions.map(emission => emission.channels[0])),
    [
      [NaN, 8, 11, 15],
      [NaN, NaN, 78],
    ],
  );
});

test('Dawn captures Arrow schema ownership before observer mutation', async () => {
  const artifact = compiledArtifact(
    mustBuild(
      [
        'enum Side',
        '    buy = "Buy"',
        'effect.emit(Side.buy)',
        'plot(close)',
      ].join('\n'),
    ),
  );
  const first = new OutputCapture();
  const second = new OutputCapture();
  const {device} = await dawn();
  const execution = await createGpuExecution(device, artifact, [
    {
      params: {},
      indices: 1,
      series: {close: [1]},
      sink: {
        declare(declaration) {
          first.declare(declaration);
          outputFields(declaration.schema)
            .find(field => field.name === 'effect0')!
            .type.children[0]!.type.children[1]!.metadata.set(
              'tea:members',
              '[{"name":"wrong"}]',
            );
        },
        publish: row => first.publish(row),
      },
    },
    {params: {}, indices: 1, series: {close: [1]}, sink: second},
  ]);
  try {
    await execution.runAll();
    assert.equal(
      second.fields
        .find(field => field.name === 'effect0')!
        .type.children[0]!.type.children[1]!.metadata.get('tea:members'),
      '[{"name":"buy","title":"Buy"}]',
    );
    assert.equal(first.effectEmissions[0]!.payload, 'buy');
    assert.equal(second.effectEmissions[0]!.payload, 'buy');
  } finally {
    execution.dispose();
  }
});

async function assertParity(
  program: Program,
  bindings: readonly GpuBinding[],
): Promise<{
  readonly summary: GpuRunSummary;
  readonly cpuSinks: readonly OutputCapture[];
  readonly gpuSinks: readonly OutputCapture[];
}> {
  const artifact = compiledArtifact(program);
  const module = loadModule(generate(program));
  const cpuSinks = bindings.map(() => new OutputCapture());
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

  const gpuSinks = bindings.map(() => new OutputCapture());
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
    sink: new OutputCapture(),
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
      sharedGpu = create([]);
      const adapter = await sharedGpu.requestAdapter();
      assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
      return adapter.requestDevice();
    })();
  }
  return {device: await sharedDevice};
}

function normalize(sink: OutputCapture): unknown {
  return {
    schema: sink.schema,
    declarations: sink.declarations,
    publications: sink.publications,
  };
}
