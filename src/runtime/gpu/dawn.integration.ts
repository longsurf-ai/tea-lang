// Purpose: Real Dawn multi-execution, multi-chunk CPU/GPU differential for generic Tea Programs.

/// <reference types="@webgpu/types" />

import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';
import {create, globals} from 'webgpu';
import {Errors} from '../../base/print';
import {generate} from '../../codegen/codegen';
import {compileProgramToWgsl} from '../../codegen/wgsl';
import type {CompiledWgslProgram} from '../../codegen/wgsl/types';
import {compileToProgram} from '../../compile';
import type {Program} from '../../ir/program';
import {mustBuild} from '../../noder/testing';
import {MemorySink} from '../../providers/sinks/memory-sink';
import type {
  BindInputs,
  DataProvider,
  EffectValue,
  OutputSink,
  ProviderContext,
  RowPublication,
  SeriesData,
  Value,
} from '../abi';
import {isEffectUserTypeValue, isUserTypeValue} from '../abi';
import {runCpuBatch} from '../batch';
import {loadModule} from '../load';
import {createGpuExecution} from './session';

class FinalDenseSink implements OutputSink {
  readonly capabilities = {denseRows: 'final'} as const;
  readonly publications: RowPublication[] = [];

  declare(): void {}

  publish(publication: RowPublication): void {
    this.publications.push({
      ...publication,
      outputs: publication.outputs.map(output => ({
        ...output,
        channels: [...output.channels],
      })),
      effects: publication.effects.map(effect => ({...effect})),
    });
  }
}

class FinalDenseWithoutEffectsSink extends FinalDenseSink {
  override readonly capabilities = {
    denseRows: 'final',
    effects: 'none',
  } as const;
}

test('Dawn resumes independent executions and publishes dense values and effects', async () => {
  assert.equal(
    Number(process.versions.node.split('.')[0]),
    22,
    'Dawn GPU integration must run on Node 22',
  );
  const compiled = compileFixture(
    join(
      process.cwd(),
      'testdata/execution/compile/strategy-components/source.tea',
    ),
  );
  const providers = [
    provider({open: [10, 10, 20], close: [10, 11, 18]}),
    provider({open: [5, 6], close: [5, 7]}),
  ];
  const cpuSinks = [new MemorySink(), new MemorySink()];
  const gpuSinks = [new MemorySink(), new MemorySink()];
  await runCpuBatch(
    loadModule(generate(compiled.program)),
    providers.map((source, index) => binding(source, cpuSinks[index])),
  );

  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  const execution = await createGpuExecution(
    device,
    compiled.artifact,
    providers.map((source, index) => binding(source, gpuSinks[index])),
    {maxRowsPerChunk: 1},
  );
  try {
    assert.deepEqual(await execution.runChunk(), {
      bindings: [
        {bindingIndex: 0, rowStart: 0, rowCount: 1, done: false},
        {bindingIndex: 1, rowStart: 0, rowCount: 1, done: false},
      ],
      done: false,
    });
    assert.deepEqual(await execution.runChunk(), {
      bindings: [
        {bindingIndex: 0, rowStart: 1, rowCount: 1, done: false},
        {bindingIndex: 1, rowStart: 1, rowCount: 1, done: true},
      ],
      done: false,
    });
    assert.deepEqual(await execution.runChunk(), {
      bindings: [{bindingIndex: 0, rowStart: 2, rowCount: 1, done: true}],
      done: true,
    });
    const summary = await execution.runAll();
    assert.deepEqual(summary.bindings, [
      {bindingIndex: 0, rows: 3, inputs: []},
      {bindingIndex: 1, rows: 2, inputs: []},
    ]);
    assert.equal(summary.chunks, 3);
    assert.equal(summary.dispatches, 3);
    assert.ok(summary.cache.workgroupSize > 0);
    cpuSinks.forEach((expected, index) =>
      assertSinkParity(expected, gpuSinks[index], compiled.artifact),
    );
  } finally {
    execution.dispose();
    device.destroy();
  }
});

test('Dawn packs fixed-width parameter sweep executions and matches CPU', async () => {
  const program = mustBuild(
    [
      'strategy("parameter sweep")',
      'enum Mode',
      '    fast = "Fast"',
      '    slow = "Slow"',
      'type SweepEvent',
      '    float value',
      'length = input.int(2, minval=1, maxval=5)',
      'scale = input.float(1.5)',
      'enabled = input.bool(true)',
      'mode = input.enum(Mode.fast)',
      'var float seed = length + scale',
      'effect.emit(SweepEvent.new(close * scale))',
      'plot(enabled and mode == Mode.fast ? close * length + seed : 0)',
    ].join('\n'),
  );
  const result = compileProgramToWgsl(program);
  assert.equal(result.status, 'compiled');
  if (result.status !== 'compiled') return;

  const values = [
    {},
    {length: 4, scale: 2.25, enabled: false, mode: 'slow'},
  ] as const;
  const cpuSinks = [new MemorySink(), new MemorySink()];
  await runCpuBatch(
    loadModule(generate(program)),
    values.map((params, index) => ({
      ...binding(provider({close: [10, 20]}), cpuSinks[index]),
      params,
    })),
  );

  let resolutions = 0;
  const sharedProvider: DataProvider = {
    async resolveContext() {
      resolutions += 1;
      return providerContext({close: [10, 20]});
    },
  };
  const gpuSinks = [new MemorySink(), new MemorySink()];
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  const execution = await createGpuExecution(
    device,
    result.artifact,
    values.map((params, index) => ({
      ...binding(sharedProvider, gpuSinks[index]),
      params,
    })),
  );
  try {
    const summary = await execution.runAll();
    assert.equal(resolutions, 1);
    assert.equal(summary.chunks, 1);
    assert.equal(summary.dispatches, 1);
    assert.deepEqual(
      summary.bindings.map(item => item.inputs.map(input => input.value)),
      [
        [2, 1.5, true, 'fast'],
        [4, 2.25, false, 'slow'],
      ],
    );
    cpuSinks.forEach((expected, index) =>
      assertSinkParity(expected, gpuSinks[index], result.artifact),
    );
  } finally {
    execution.dispose();
    device.destroy();
  }
});

test('Dawn executes one-chunk transient and mutable-path programs', async () => {
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  try {
    for (const [fixture, expected] of [
      ['testdata/gpu/transient/source.tea', [7]],
      ['testdata/gpu/path-rebase/source.tea', [7, 1]],
    ] as const) {
      const compiled = compileFixture(join(process.cwd(), fixture));
      const sink = new MemorySink();
      const execution = await createGpuExecution(device, compiled.artifact, [
        binding(provider({close: [7]}), sink),
      ]);
      try {
        await execution.runAll();
        assert.deepEqual(
          sink.emissions.flatMap(emission => emission.channels),
          expected,
        );
      } finally {
        execution.dispose();
      }
    }
  } finally {
    device.destroy();
  }
});

test('Dawn preserves temporal frames and history across one-row chunks', async () => {
  const program = mustBuild(
    [
      'indicator("EMA frame resume")',
      'fastLength = input.int(3)',
      'slowLength = input.int(5)',
      'fast = ta.ema(close, fastLength)',
      'slow = ta.ema(close, slowLength)',
      'longSignal = ta.crossover(fast, slow)',
      'closeSignal = ta.crossunder(fast, slow)',
      'plot(fast)',
      'plot(slow)',
      'plotshape(longSignal)',
      'plotshape(closeSignal)',
    ].join('\n'),
  );
  const result = compileProgramToWgsl(program);
  assert.equal(result.status, 'compiled');
  if (result.status !== 'compiled') return;

  const datasets = [
    {close: [5, 4, 3, 4, 6, 5, 2]},
    {close: [10, 9, 8, 10, 12]},
  ] as const;
  const params = [
    {fastLength: 2, slowLength: 4},
    {fastLength: 3, slowLength: 5},
  ] as const;
  const cpuSinks = datasets.map(() => new MemorySink());
  await runCpuBatch(
    loadModule(generate(program)),
    datasets.map((columns, index) => ({
      ...binding(provider(columns), cpuSinks[index]),
      params: params[index],
    })),
  );

  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  const gpuSinks = datasets.map(() => new MemorySink());
  const execution = await createGpuExecution(
    device,
    result.artifact,
    datasets.map((columns, index) => ({
      ...binding(provider(columns), gpuSinks[index]),
      params: params[index],
    })),
    {maxRowsPerChunk: 1},
  );
  try {
    const summary = await execution.runAll();
    assert.equal(summary.chunks, 7);
    assert.equal(summary.dispatches, 7);
    cpuSinks.forEach((expected, index) =>
      assertSinkParity(expected, gpuSinks[index], result.artifact),
    );
  } finally {
    execution.dispose();
    device.destroy();
  }
});

test('Dawn advances skipped active parameter history at row cadence', async () => {
  const program = mustBuild(
    [
      'indicator("skipped frame")',
      'previous(float source) => source[1]',
      'float value = na',
      'if bar_index >= 2 and bar_index != 3',
      '    value := previous(close)',
      'plot(value)',
    ].join('\n'),
  );
  const result = compileProgramToWgsl(program);
  assert.equal(result.status, 'compiled');
  if (result.status !== 'compiled') return;

  const cpuSink = new MemorySink();
  const source = provider({close: [10, 11, 12, 13, 14]});
  await runCpuBatch(loadModule(generate(program)), [binding(source, cpuSink)]);
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  const gpuSink = new MemorySink();
  const execution = await createGpuExecution(
    device,
    result.artifact,
    [binding(source, gpuSink)],
    {maxRowsPerChunk: 1},
  );
  try {
    await execution.runAll();
    assertSinkParity(cpuSink, gpuSink, result.artifact);
    const values = gpuSink.emissions.map(emission => emission.channels[0]);
    assert.ok(values.slice(0, 4).every(Number.isNaN));
    assert.ok(Number.isNaN(values[4]));
  } finally {
    execution.dispose();
    device.destroy();
  }
});

test('Dawn publishes every sparse effect but only final dense output when requested', async () => {
  const program = mustBuild(
    [
      'indicator("final dense")',
      'type Marker',
      '    int row',
      'if bar_index == 1',
      '    effect.emit(Marker.new(bar_index))',
      'plot(close)',
    ].join('\n'),
  );
  const result = compileProgramToWgsl(program);
  assert.equal(result.status, 'compiled');
  if (result.status !== 'compiled') return;

  const source = provider({close: [10, 11, 12, 13]});
  const cpuFullSink = new MemorySink();
  const cpuSink = new FinalDenseSink();
  await runCpuBatch(loadModule(generate(program)), [
    binding(source, cpuFullSink),
    binding(source, cpuSink),
  ]);

  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  const gpuFullSink = new MemorySink();
  const gpuSink = new FinalDenseSink();
  const execution = await createGpuExecution(
    device,
    result.artifact,
    [binding(source, gpuFullSink), binding(source, gpuSink)],
    {maxRowsPerChunk: 2},
  );
  try {
    await execution.runAll();
    assert.deepEqual(
      cpuSink.publications.map(publication => ({
        row: publication.row,
        outputCount: publication.outputs.length,
        effectCount: publication.effects.length,
      })),
      [
        {row: 1, outputCount: 0, effectCount: 1},
        {row: 3, outputCount: 1, effectCount: 0},
      ],
    );
    assertSinkParity(cpuFullSink, gpuFullSink, result.artifact);
    assertSinkParity(cpuSink, gpuSink, result.artifact);
  } finally {
    execution.dispose();
    device.destroy();
  }
});

test('Dawn omits all effect transport while preserving final dense parity', async () => {
  const program = mustBuild(
    [
      'indicator("effect opt-out")',
      'effect.emit(close)',
      'plot(close * 2)',
    ].join('\n'),
  );
  const result = compileProgramToWgsl(program);
  assert.equal(result.status, 'compiled');
  if (result.status !== 'compiled') return;
  const source = provider({close: [10, 11, 12]});
  const cpuSink = new FinalDenseWithoutEffectsSink();
  await runCpuBatch(loadModule(generate(program)), [binding(source, cpuSink)]);

  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  const gpuSink = new FinalDenseWithoutEffectsSink();
  const execution = await createGpuExecution(
    device,
    result.artifact,
    [binding(source, gpuSink)],
    {maxRowsPerChunk: 1, effectRecordsPerExecution: 0},
  );
  try {
    await execution.runAll();
    assert.equal(cpuSink.publications.length, 1);
    assert.deepEqual(cpuSink.publications[0]?.effects, []);
    assertSinkParity(cpuSink, gpuSink, result.artifact);
  } finally {
    execution.dispose();
    device.destroy();
  }
});

test('Dawn storage, partial, and full cache placements are equivalent', async () => {
  const program = mustBuild(
    [
      'indicator("cache equivalence")',
      'length = input.int(3)',
      'value = ta.ema(close, length)',
      'plot(value)',
      'plot(close[-1])',
    ].join('\n'),
  );
  const result = compileProgramToWgsl(program);
  assert.equal(result.status, 'compiled');
  if (result.status !== 'compiled') return;
  const source = provider({close: [5, 4, 6, 8, 3]});
  const cpuSink = new MemorySink();
  await runCpuBatch(loadModule(generate(program)), [binding(source, cpuSink)]);
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  const first = result.artifact.cache.segments[0]!;
  const budgets = [
    0,
    first.cacheEnd * 4,
    result.artifact.state.wordsPerExecution * 4,
  ];
  try {
    for (const budget of budgets) {
      const sink = new MemorySink();
      const execution = await createGpuExecution(
        device,
        result.artifact,
        [binding(source, sink)],
        {maxRowsPerChunk: 1, maxCacheBytesPerWorkgroup: budget},
      );
      try {
        const summary = await execution.runAll();
        assert.equal(summary.cache.bytesPerWorkgroup <= budget, true);
        assertSinkParity(cpuSink, sink, result.artifact);
      } finally {
        execution.dispose();
      }
    }
  } finally {
    device.destroy();
  }
});

function binding(source: DataProvider, sink: OutputSink): BindInputs {
  return {params: {}, provider: source, sink, timeNow: 0};
}

function provider(
  columns: Readonly<Record<string, readonly number[]>>,
): DataProvider {
  return {resolveContext: async () => providerContext(columns)};
}

function providerContext(
  columns: Readonly<Record<string, readonly number[]>>,
): ProviderContext {
  const rows = Object.values(columns)[0]?.length ?? 0;
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

function compileFixture(filename: string): {
  readonly program: Program;
  readonly artifact: CompiledWgslProgram;
} {
  const errors = new Errors();
  const program = compileToProgram([filename], errors);
  if (program === null) {
    throw new Error(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('\n'),
    );
  }
  const result = compileProgramToWgsl(program);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return {program, artifact: result.artifact};
}

function assertSinkParity(
  expected: {readonly publications: readonly RowPublication[]},
  actual: {readonly publications: readonly RowPublication[]},
  artifact: CompiledWgslProgram,
): void {
  assert.equal(actual.publications.length, expected.publications.length);
  expected.publications.forEach((row, rowIndex) => {
    const received = actual.publications[rowIndex];
    assert.equal(received?.row, row.row);
    assert.equal(received?.provisional, false);
    assert.deepEqual(
      received?.outputs.map(output => output.outputId),
      row.outputs.map(output => output.outputId),
    );
    row.outputs.forEach((output, outputIndex) =>
      output.channels.forEach((value, channelIndex) =>
        assertValueParity(
          value,
          received?.outputs[outputIndex]?.channels[channelIndex],
          artifact,
        ),
      ),
    );
    assert.deepEqual(
      received?.effects.map(effect => effect.effectId),
      row.effects.map(effect => effect.effectId),
    );
    row.effects.forEach((effect, effectIndex) =>
      assertValueParity(
        effect.payload,
        received?.effects[effectIndex]?.payload,
        artifact,
      ),
    );
  });
}

function assertValueParity(
  expected: Value | EffectValue,
  actual: Value | EffectValue | undefined,
  artifact: CompiledWgslProgram,
): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Number.isNaN(expected) && Number.isNaN(actual)) return;
    const tolerance = Math.max(
      artifact.numeric.cpuTolerance.absolute,
      Math.abs(expected) * artifact.numeric.cpuTolerance.relative,
    );
    assert.ok(Math.abs(actual - expected) <= tolerance);
    return;
  }
  if (
    (isUserTypeValue(expected as Value) ||
      isEffectUserTypeValue(expected as EffectValue)) &&
    actual !== undefined &&
    (isUserTypeValue(actual as Value) ||
      isEffectUserTypeValue(actual as EffectValue))
  ) {
    const expectedUser = expected as {
      readonly fields: readonly (Value | EffectValue)[];
    };
    const actualUser = actual as {
      readonly fields: readonly (Value | EffectValue)[];
    };
    assert.equal(actualUser.fields.length, expectedUser.fields.length);
    expectedUser.fields.forEach((field, index) =>
      assertValueParity(field, actualUser.fields[index], artifact),
    );
    return;
  }
  assert.deepEqual(actual, expected);
}
