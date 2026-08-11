// Purpose: Lock CPU replay causality, f32 accounting, lifecycle journals, and boundary failures.

import assert from 'node:assert/strict';
import test from 'node:test';

import {BACKTEST_SETTINGS, parseBacktestInput} from '../src/backtest-contract';
import {
  parseMarketSnapshot,
  parseParameterPair,
  parseParameterPairs,
} from '../src/contracts';
import {runCpuBacktest} from '../src/cpu-backtest';

function bar(index: number, open: number, close: number) {
  const openTimeMs = index * 1_000;
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + 999,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
  };
}

function snapshot(closes: readonly number[], opens: readonly number[]) {
  assert.equal(closes.length, opens.length);
  return {
    schemaVersion: 1,
    venue: 'binance',
    marketType: 'spot',
    symbol: 'BTCUSDT',
    interval: '1h',
    bars: closes.map((close, index) => bar(index, opens[index], close)),
  };
}

function add(left: number, right: number): number {
  return Math.fround(Math.fround(left) + Math.fround(right));
}

function subtract(left: number, right: number): number {
  return Math.fround(Math.fround(left) - Math.fround(right));
}

function multiply(left: number, right: number): number {
  return Math.fround(Math.fround(left) * Math.fround(right));
}

function divide(left: number, right: number): number {
  return Math.fround(Math.fround(left) / Math.fround(right));
}

test('replays strict SMA crosses with next-open fills and final expiration', () => {
  const input = parseBacktestInput({
    snapshot: snapshot([3, 2, 1, 4, 5, 1, 1, 5], [3, 2, 1, 4, 10, 1, 8, 5]),
    parameters: {fastPeriod: 2, slowPeriod: 3},
  });

  const result = runCpuBacktest(input);

  assert.deepEqual(
    result.orders.map(order => ({
      side: order.side,
      signalBarIndex: order.signalBarIndex,
      status: order.status,
      fillBarIndex: order.status === 'filled' ? order.fillBarIndex : undefined,
    })),
    [
      {side: 'buy', signalBarIndex: 3, status: 'filled', fillBarIndex: 4},
      {side: 'sell', signalBarIndex: 5, status: 'filled', fillBarIndex: 6},
      {
        side: 'buy',
        signalBarIndex: 7,
        status: 'expired',
        fillBarIndex: undefined,
      },
    ],
  );
  assert.deepEqual(
    result.events.map(event => [event.type, event.barIndex]),
    [
      ['order-submitted', 3],
      ['order-filled', 4],
      ['order-submitted', 5],
      ['order-filled', 6],
      ['order-submitted', 7],
      ['order-expired', 7],
    ],
  );
  assert.deepEqual(
    result.events.map(event => event.sequence),
    [0, 1, 2, 3, 4, 5],
  );

  const one = Math.fround(1);
  const buyPrice = multiply(
    Math.fround(10),
    add(one, BACKTEST_SETTINGS.adverseSlippageRate),
  );
  const buyQuantity = divide(
    BACKTEST_SETTINGS.initialCash,
    multiply(buyPrice, add(one, BACKTEST_SETTINGS.takerFeeRate)),
  );
  const buyNotional = multiply(buyQuantity, buyPrice);
  const buyFee = multiply(buyNotional, BACKTEST_SETTINGS.takerFeeRate);
  const buyCash = subtract(
    BACKTEST_SETTINGS.initialCash,
    add(buyNotional, buyFee),
  );
  const sellPrice = multiply(
    Math.fround(8),
    subtract(one, BACKTEST_SETTINGS.adverseSlippageRate),
  );
  const sellNotional = multiply(buyQuantity, sellPrice);
  const sellFee = multiply(sellNotional, BACKTEST_SETTINGS.takerFeeRate);
  const finalCash = add(buyCash, subtract(sellNotional, sellFee));

  assert.equal(result.fills[0].fillPrice, buyPrice);
  assert.equal(result.fills[0].quantity, buyQuantity);
  assert.equal(result.fills[0].notional, buyNotional);
  assert.equal(result.fills[0].fee, buyFee);
  assert.equal(result.fills[0].cashAfter, buyCash);
  assert.equal(result.fills[1].fillPrice, sellPrice);
  assert.equal(result.fills[1].notional, sellNotional);
  assert.equal(result.fills[1].fee, sellFee);
  assert.equal(result.summary.finalCash, finalCash);
  assert.equal(result.summary.finalEquity, finalCash);
  assert.equal(result.summary.totalFees, add(buyFee, sellFee));
  assert.equal(result.summary.finalPositionQuantity, 0);
  assert.equal(result.summary.orderCount, 3);
  assert.equal(result.summary.filledOrderCount, 2);
  assert.equal(result.summary.expiredOrderCount, 1);
  assert.equal(result.summary.fillCount, 2);
  assert.equal(result.summary.roundTripCount, 1);
  assert.equal(result.summary.equityPointCount, 8);
  assert.equal(result.summary.eventCount, 6);
  assert.ok(result.summary.maxDrawdown > 0);
  assert.equal(result.roundTrips[0].entryBarIndex, 4);
  assert.equal(result.roundTrips[0].exitBarIndex, 6);
  assert.ok(result.roundTrips[0].netPnl < 0);

  const repeated = runCpuBacktest(input);
  assert.deepEqual(repeated, result);
});

test('marks an open position to the final close without liquidating it', () => {
  const input = parseBacktestInput({
    snapshot: snapshot([3, 2, 1, 4, 5], [3, 2, 1, 4, 10]),
    parameters: {fastPeriod: 2, slowPeriod: 3},
  });

  const result = runCpuBacktest(input);
  const fill = result.fills[0];
  const expectedEquity = add(
    fill.cashAfter,
    multiply(fill.quantity, Math.fround(5)),
  );

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].status, 'filled');
  assert.equal(result.fills.length, 1);
  assert.equal(result.roundTrips.length, 0);
  assert.ok(result.summary.finalPositionQuantity > 0);
  assert.equal(result.summary.finalEquity, expectedEquity);
  assert.equal(result.equityCurve.at(-1)?.close, Math.fround(5));
  assert.equal(result.equityCurve.at(-1)?.equity, expectedEquity);
});

test('parses normalized f32 snapshots and rejects forbidden boundary states', () => {
  const raw = snapshot([1.00000006, 2, 3], [1.00000006, 2, 3]);
  const parsed = parseMarketSnapshot(raw);
  assert.equal(parsed.bars[0].open, Math.fround(1.00000006));
  assert.equal(parsed.bars[0].close, Math.fround(1.00000006));

  assert.throws(() =>
    parseMarketSnapshot({
      ...raw,
      bars: [{...raw.bars[0], high: 0.5}, raw.bars[1], raw.bars[2]],
    }),
  );
  assert.throws(() =>
    parseMarketSnapshot({
      ...raw,
      bars: [raw.bars[0], {...raw.bars[1], openTimeMs: 999}, raw.bars[2]],
    }),
  );
  assert.throws(() => parseMarketSnapshot({...raw, symbol: 'btcusdt'}));
  assert.throws(() => parseMarketSnapshot({...raw, fetchedAt: 123}));
  assert.throws(() =>
    parseMarketSnapshot({
      ...raw,
      bars: [{...raw.bars[0], open: Number.MIN_VALUE}, ...raw.bars.slice(1)],
    }),
  );
  assert.throws(() => parseParameterPair({fastPeriod: 3, slowPeriod: 3}));
  assert.throws(() =>
    parseParameterPair({fastPeriod: 1, slowPeriod: 0x1_0000_0000}),
  );
  assert.throws(() =>
    parseParameterPairs([
      {fastPeriod: 1, slowPeriod: 2},
      {fastPeriod: 1, slowPeriod: 2},
    ]),
  );
  assert.throws(() =>
    parseBacktestInput({
      snapshot: raw,
      parameters: {fastPeriod: 2, slowPeriod: 4},
    }),
  );
});
