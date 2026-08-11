// Purpose: Lock CPU sweep job ordering and aggregate parity with single-job CPU backtests.

import assert from 'node:assert/strict';
import test from 'node:test';

import {parseBacktestInput} from '../src/backtest-contract';
import {parseMarketSnapshot, parseParameterPairs} from '../src/contracts';
import {runCpuBacktest} from '../src/cpu-backtest';
import {
  buildCpuBacktestInputs,
  runCpuBacktestSweep,
  worstCaseEventCapacity,
} from '../src/experiment';

function bar(index: number, price: number) {
  const openTimeMs = index * 1_000;
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + 999,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1,
  };
}

function snapshot(symbol: string, prices: readonly number[]) {
  return parseMarketSnapshot({
    schemaVersion: 1,
    venue: 'binance',
    marketType: 'spot',
    symbol,
    interval: '1h',
    bars: prices.map((price, index) => bar(index, price)),
  });
}

const snapshots = [
  snapshot('BTCUSDT', [10, 9, 8, 9, 10, 11, 10, 9, 8, 9, 10]),
  snapshot('ETHUSDT', [3, 2, 1, 4, 5, 1, 1, 5, 6, 2, 3]),
];
const parameters = parseParameterPairs([
  {fastPeriod: 2, slowPeriod: 3},
  {fastPeriod: 2, slowPeriod: 4},
  {fastPeriod: 3, slowPeriod: 5},
]);

test('builds inputs in GPU job order: seriesIndex * parameterCount + parameterIndex', () => {
  const inputs = buildCpuBacktestInputs({snapshots, parameters});

  assert.equal(inputs.length, snapshots.length * parameters.length);
  for (let seriesIndex = 0; seriesIndex < snapshots.length; seriesIndex++) {
    for (
      let parameterIndex = 0;
      parameterIndex < parameters.length;
      parameterIndex++
    ) {
      const jobIndex = seriesIndex * parameters.length + parameterIndex;
      const input = inputs[jobIndex];
      assert.ok(input);
      assert.equal(input.snapshot.symbol, snapshots[seriesIndex]?.symbol);
      assert.deepEqual(input.parameters, parameters[parameterIndex]);
    }
  }
});

test('worst-case capacity is 2 × (barCount - slowPeriod) per job and bounds actual events', () => {
  // 11 bars × slow {3, 4, 5} per series: 2×8 + 2×7 + 2×6 = 42; two series = 84.
  const bound = worstCaseEventCapacity({snapshots, parameters});
  assert.equal(bound, 84);

  const run = runCpuBacktestSweep(buildCpuBacktestInputs({snapshots, parameters}));
  assert.ok(run.eventCount > 0);
  assert.ok(run.eventCount <= bound);
});

test('sweep aggregates match per-job CPU backtests and report elapsed time', () => {
  const inputs = buildCpuBacktestInputs({snapshots, parameters});
  const run = runCpuBacktestSweep(inputs);

  let expectedEvents = 0;
  let expectedEquityPoints = 0;
  for (const snapshotValue of snapshots) {
    for (const parameterPair of parameters) {
      const result = runCpuBacktest(
        parseBacktestInput({
          snapshot: snapshotValue,
          parameters: parameterPair,
        }),
      );
      expectedEvents += result.events.length;
      expectedEquityPoints += result.equityCurve.length;
    }
  }

  assert.ok(expectedEvents > 0);
  assert.equal(run.eventCount, expectedEvents);
  assert.equal(run.equityPointCount, expectedEquityPoints);
  assert.ok(Number.isFinite(run.elapsedMs) && run.elapsedMs >= 0);
});
