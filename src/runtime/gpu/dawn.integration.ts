// Purpose: Real Dawn multi-lane, multi-chunk CPU/GPU differential for generic Tea Programs.

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
  ProviderContext,
  SeriesData,
  Value,
} from '../abi';
import {isEffectUserTypeValue, isUserTypeValue} from '../abi';
import {runCpuBatch} from '../batch';
import {loadModule} from '../load';
import {createGpuExecution} from './session';

test('Dawn resumes independent lanes and publishes dense values and effects', async () => {
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
    assert.deepEqual(await execution.runAll(), {
      bindings: [
        {bindingIndex: 0, rows: 3, inputs: []},
        {bindingIndex: 1, rows: 2, inputs: []},
      ],
      chunks: 3,
      dispatches: 3,
    });
    cpuSinks.forEach((expected, index) =>
      assertSinkParity(expected, gpuSinks[index], compiled.artifact),
    );
  } finally {
    execution.dispose();
    device.destroy();
  }
});

test('Dawn packs fixed-width parameter sweep lanes and matches CPU', async () => {
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

function binding(source: DataProvider, sink: MemorySink): BindInputs {
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
  expected: MemorySink,
  actual: MemorySink,
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
