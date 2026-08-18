// Purpose: Prove the canonical strategy sweep against the complete checked-in
// Binance BTCUSDT daily history on the real Dawn/WebGPU execution path.

/// <reference types="@webgpu/types" />

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {create, globals} from 'webgpu';
import {Errors} from '../src/base/print';
import {compileToProgram} from '../src/compile';
import {executeProgram} from '../src/execute';
import {csvProvider} from '../src/providers/data/csv';
import type {
  ExecutionDeclaration,
  OutputSink,
  RowPublication,
} from '../src/runtime/abi';

const SOURCE = join(process.cwd(), 'examples/strategy/ema-cross/strategy.tea');
const TURTLE_SOURCE = join(
  process.cwd(),
  'examples/strategy/turtle-system/strategy.tea',
);
const DATA = join(process.cwd(), 'examples/data/binance/btcusdt-1d.csv');
const DATA_SOURCE = join(
  process.cwd(),
  'examples/data/binance/btcusdt-1d.source.json',
);

interface Scenario {
  readonly [name: string]: unknown;
  readonly fast_length: number;
  readonly slow_length: number;
  readonly initial_cash: number;
  readonly slippage: number;
  readonly fee: number;
}

interface TurtleScenario {
  readonly [name: string]: unknown;
  readonly stop_n: number;
  readonly risk_percent: number;
  readonly pyramid_n: number;
  readonly max_units: number;
  readonly atr_length: number;
  readonly l1_entry_length: number;
  readonly l2_entry_length: number;
  readonly l1_exit_length: number;
  readonly l2_exit_length: number;
  readonly initial_cash: number;
}

test('Dawn sweeps the canonical EMA strategy over real Binance daily history', async () => {
  const csv = readFileSync(DATA, 'utf8');
  const source = JSON.parse(readFileSync(DATA_SOURCE, 'utf8')) as {
    readonly sha256: string;
    readonly rows: number;
  };
  assert.equal(createHash('sha256').update(csv).digest('hex'), source.sha256);
  assert.equal(source.rows, 3_283);

  const errors = new Errors();
  const program = compileToProgram([SOURCE], errors);
  assert.ok(program, formatErrors(errors));
  assert.equal(errors.count, 0);

  const scenarios = sweepScenarios();
  assert.equal(scenarios.length, 100);
  const provider = csvProvider(csv);
  const sinks = scenarios.map(() => new FinalMetricSink());

  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  try {
    const result = await executeProgram(
      program,
      scenarios.map((params, index) => ({
        params,
        provider,
        sink: sinks[index],
        timeNow: 1_800_000_000_000,
      })),
      {kind: 'gpu', device},
    );

    assert.equal(result.numericProfile, 'wgsl-f32-i32');
    assert.equal(result.bindings.length, 100);
    assert.ok(result.bindings.every(binding => binding.rows === 3_283));
    assert.ok(sinks.every(sink => sink.publications === 1));

    const rows = scenarios.map((params, index) => ({
      params,
      totalReturn: sinks[index].metric('total return'),
      maxDrawdown: sinks[index].metric('maximum drawdown'),
    }));
    assert.deepEqual(extreme(rows, 'totalReturn', 'max'), {
      fast: 10,
      slow: 32,
      value: 50.25574493408203,
    });
    assert.deepEqual(extreme(rows, 'totalReturn', 'min'), {
      fast: 20,
      slow: 24,
      value: 17.628833770751953,
    });
    assert.deepEqual(extreme(rows, 'maxDrawdown', 'min'), {
      fast: 8,
      slow: 36,
      value: 0.5844814777374268,
    });
    assert.deepEqual(extreme(rows, 'maxDrawdown', 'max'), {
      fast: 6,
      slow: 24,
      value: 0.7870401740074158,
    });

    const profileSensitive = scenarios.findIndex(
      scenario => scenario.fast_length === 16 && scenario.slow_length === 40,
    );
    assert.notEqual(profileSensitive, -1);
    // Pin the WGSL f32 result directly. A near-equal EMA comparison takes a
    // different trade branch under JS f64, so this is not a CPU parity check.
    assert.equal(
      sinks[profileSensitive].metric('total return'),
      26.247896194458008,
    );
    assert.equal(
      sinks[profileSensitive].metric('maximum drawdown'),
      0.7109495997428894,
    );
    assert.equal(sinks[profileSensitive].metric('round trips'), 34);
  } finally {
    device.destroy();
  }
});

test('Dawn runs bind-sized Turtle histories across chunks and publishes final metrics', async () => {
  const csv = readFileSync(DATA, 'utf8');
  const errors = new Errors();
  const program = compileToProgram([TURTLE_SOURCE], errors);
  assert.ok(program, formatErrors(errors));
  assert.equal(errors.count, 0);

  const scenarios: readonly TurtleScenario[] = [
    {
      stop_n: 2,
      risk_percent: 0.01,
      pyramid_n: 0.5,
      max_units: 4,
      atr_length: 10,
      l1_entry_length: 20,
      l2_entry_length: 55,
      l1_exit_length: 10,
      l2_exit_length: 20,
      initial_cash: 100_000,
    },
    {
      stop_n: 2,
      risk_percent: 0.01,
      pyramid_n: 0.5,
      max_units: 4,
      atr_length: 30,
      l1_entry_length: 40,
      l2_entry_length: 120,
      l1_exit_length: 15,
      l2_exit_length: 45,
      initial_cash: 100_000,
    },
  ];
  const provider = csvProvider(csv);
  const sinks = scenarios.map(() => new FinalMetricSink());

  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  assert.ok(adapter, 'Dawn did not expose a WebGPU adapter');
  const device = await adapter.requestDevice();
  try {
    const result = await executeProgram(
      program,
      scenarios.map((params, index) => ({
        params,
        provider,
        sink: sinks[index],
        timeNow: 1_800_000_000_000,
      })),
      {
        kind: 'gpu',
        device,
        options: {maxRowsPerChunk: 512, maxCacheBytesPerWorkgroup: 0},
      },
    );

    assert.equal(result.numericProfile, 'wgsl-f32-i32');
    assert.deepEqual(
      result.bindings.map(binding => binding.rows),
      [3_283, 3_283],
    );
    assert.ok(result.chunks > 1);
    assert.ok(result.dispatches > 1);
    assert.ok(sinks.every(sink => sink.publications === 1));

    const metrics = sinks.map(sink => ({
      equity: sink.metric('equity'),
      fillCount: sink.metric('fill count'),
      roundTrips: sink.metric('round trips'),
      maxDrawdown: sink.metric('maximum drawdown'),
      totalReturn: sink.metric('total return'),
    }));
    assert.deepEqual(metrics, [
      {
        equity: 2_508_134,
        fillCount: 195,
        roundTrips: 49,
        maxDrawdown: 0.42579373717308044,
        totalReturn: 24.081340789794922,
      },
      {
        equity: 1_296_219.75,
        fillCount: 143,
        roundTrips: 34,
        maxDrawdown: 0.39330393075942993,
        totalReturn: 11.962198257446289,
      },
    ]);
  } finally {
    device.destroy();
  }
});

class FinalMetricSink implements OutputSink {
  readonly capabilities = {denseRows: 'final', effects: 'none'} as const;
  private outputs: ExecutionDeclaration['outputs'] = [];
  private final: RowPublication | null = null;
  publications = 0;

  declare(declaration: ExecutionDeclaration): void {
    this.outputs = declaration.outputs;
  }

  publish(publication: RowPublication): void {
    assert.equal(publication.row, 3_282);
    assert.equal(publication.provisional, false);
    assert.deepEqual(publication.effects, []);
    this.publications++;
    this.final = publication;
  }

  metric(title: string): number {
    const outputId = this.outputs.findIndex(output =>
      output.spec.staticArgs.some(
        argument => argument.name === 'title' && argument.value === title,
      ),
    );
    assert.notEqual(outputId, -1, `missing output '${title}'`);
    const value = this.final?.outputs.find(
      output => output.outputId === outputId,
    )?.channels[0];
    assert.equal(typeof value, 'number', `missing final value for '${title}'`);
    return value as number;
  }
}

function sweepScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  for (let fast = 2; fast <= 20; fast += 2) {
    for (let slow = 24; slow <= 60; slow += 4) {
      scenarios.push({
        fast_length: fast,
        slow_length: slow,
        initial_cash: 100_000,
        slippage: 0.0005,
        fee: 0.001,
      });
    }
  }
  return scenarios;
}

function extreme(
  rows: readonly {
    readonly params: Scenario;
    readonly totalReturn: number;
    readonly maxDrawdown: number;
  }[],
  metric: 'totalReturn' | 'maxDrawdown',
  direction: 'min' | 'max',
): {readonly fast: number; readonly slow: number; readonly value: number} {
  const selected = rows.reduce((best, row) => {
    const improves =
      direction === 'max'
        ? row[metric] > best[metric]
        : row[metric] < best[metric];
    return improves ? row : best;
  });
  return {
    fast: selected.params.fast_length,
    slow: selected.params.slow_length,
    value: selected[metric],
  };
}

function formatErrors(errors: Errors): string {
  return errors
    .flushErrors()
    .map(error => error.msg)
    .join('; ');
}
