import type {Module} from '../module-binding';
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
import {outputFields, type Datum} from '../output';

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
        '',
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
  const program = mustBuild('emit "output0" close');
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

test('empty GPU bindings declare outputs without delivering rows', async () => {
  const artifact = compiledArtifact(mustBuild('emit "output0" close'));
  const calls: string[] = [];
  const {device} = await dawn();
  const execution = await createGpuExecution(device, artifact, [
    {
      params: {},
      indices: 0,
      series: {close: []},
      declare(outputs) {
        assert.equal(outputFields(outputs.schema)[0]!.name, 'output0');
        calls.push('declare');
      },
      next() {
        calls.push('row');
      },
    },
    {
      params: {},
      indices: 0,
      series: {close: []},
      next() {
        calls.push('row');
      },
    },
  ]);
  try {
    assert.deepEqual(calls, ['declare']);
    const summary = await execution.runAll();
    assert.deepEqual(
      summary.bindings.map(binding => binding.rows),
      [0, 0],
    );
    assert.deepEqual(calls, ['declare']);
  } finally {
    execution.dispose();
  }
});

test('Dawn preserves Arrow enum payloads, missing values and per-column append order', async () => {
  const program = mustBuild(
    [
      'enum Side',
      '    buy = "Buy"',
      '    sell = "Sell"',
      'for i = 0 to 2',
      '    emit.append "effect0" close',
      '    emit.append "effect1" Side.buy',
      'emit "output0" close',
    ].join('\n'),
  );
  const {gpuSinks} = await assertParity(program, [
    binding({close: [10, NaN, -0]}),
  ]);
  const row = gpuSinks[0]!.publications[0]!;
  assert.deepEqual(row.effect0, [10, 10, 10]);
  assert.deepEqual(row.effect1, ['buy', 'buy', 'buy']);
});

test('Dawn decodes Color append payloads as detached RGBA structs', async () => {
  const program = mustBuild(
    [
      'emit.append "opaque" #FF5252',
      'emit.append "partial" #01020380',
      'color missing = na',
      'emit.append "missing" missing',
      'emit "price" close',
    ].join('\n'),
  );
  const {gpuSinks} = await assertParity(program, [binding({close: [1, 2]})]);
  const row = gpuSinks[0]!.publications[0]!;
  assert.deepEqual(row.opaque, [{r: 255, g: 82, b: 82, a: 255}]);
  assert.deepEqual(row.partial, [{r: 1, g: 2, b: 3, a: 128}]);
  assert.deepEqual(row.missing, [null]);
});

test('Dawn preserves conditional set presence, lazy branches and helper returns', async () => {
  const program = mustBuild(
    [
      'publish(const string id, float value) =>',
      '    emit id value',
      '    return value',
      'choose(int value) =>',
      '    emit.append "choices" value',
      '    return value',
      'run(float value) =>',
      '    var int count = 0',
      '    count += 1',
      '    if value > 0',
      '        publish("positive", value)',
      '    emit "missing" float(na)',
      '    selected = value > 0 ? choose(1) : choose(2)',
      '    if value < 0',
      '        return count',
      '    emit "count" count',
      '    return count',
      'run(close)',
    ].join('\n'),
  );
  const {gpuSinks} = await assertParity(program, [
    binding({close: [1, -1, 2]}),
  ]);
  const rows = gpuSinks[0]!.publications;
  assert.deepEqual(
    rows.map(row => row.positive),
    [1, null, 2],
  );
  assert.deepEqual(
    rows.map(row => row.count),
    [1, null, 3],
  );
  assert.deepEqual(
    rows.map(row => row.choices),
    [[1], [2], [1]],
  );
  assert.ok(rows.every(row => Number.isNaN(row.missing)));
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
      'emit "output0" left + right + total',
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

test('Dawn applies concrete native and ordinary function argument conversions', async () => {
  const program = mustBuild(
    [
      'rounded(float value) =>',
      '    return math.floor(value)',
      'emit "maximum" math.max(close, 2)',
      'emit "rounded" rounded(2)',
      'emit "absolute" math.abs(close)',
    ].join('\n'),
  );
  const {gpuSinks} = await assertParity(program, [binding({close: [-1, 3]})]);
  assert.deepEqual(
    gpuSinks[0]!.publications.map(row => [
      row.maximum,
      row.rounded,
      row.absolute,
    ]),
    [
      [2, 2, 1],
      [3, 2, 3],
    ],
  );
});

test('Dawn captures Arrow schema ownership before observer mutation', async () => {
  const artifact = compiledArtifact(
    mustBuild(
      [
        'enum Side',
        '    buy = "Buy"',
        'emit.append "effect0" Side.buy',
        'emit "output0" close',
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
      declare(declaration) {
        first.declare(declaration);
        outputFields(declaration.schema)
          .find(field => field.name === 'effect0')!
          .type.children[0]!.metadata.set('tea:members', '[{"name":"wrong"}]');
      },
      next: row => first.publish(row),
    },
    {
      params: {},
      indices: 1,
      series: {close: [1]},
      declare: outputs => second.declare(outputs),
      next: row => second.publish(row),
    },
  ]);
  try {
    await execution.runAll();
    assert.equal(
      second.fields
        .find(field => field.name === 'effect0')!
        .type.children[0]!.metadata.get('tea:members'),
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
    declare: (outputs: Module['outputs']) => gpuSinks[index]!.declare(outputs),
    next: (row: Datum) => gpuSinks[index]!.publish(row),
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
    next() {},
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
    publications: sink.publications,
  };
}
