// Purpose: Replay the fixed SMA crossover simulator with WGSL-equivalent f32 operation ordering.

import {
  BACKTEST_SETTINGS,
  createBacktestJobIdentity,
  type BacktestEquityPoint,
  type BacktestEvent,
  type BacktestFill,
  type BacktestInput,
  type BacktestOrder,
  type BacktestOrderSide,
  type BacktestPositionAction,
  type BacktestRoundTrip,
  type CpuBacktestResult,
  type FilledBacktestOrder,
} from './backtest-contract';

const F32_ZERO = Math.fround(0);
const F32_ONE = Math.fround(1);

interface PendingOrder {
  readonly orderId: string;
  readonly orderSequence: number;
  readonly side: BacktestOrderSide;
  readonly positionAction: BacktestPositionAction;
  readonly orderType: 'market';
  readonly sizing: 'all-in';
  readonly timeInForce: 'next-bar-open';
  readonly signalBarIndex: number;
  readonly submittedAtMs: number;
}

interface LongPosition {
  readonly kind: 'long';
  readonly positionId: string;
  readonly entryOrderId: string;
  readonly entryFillId: string;
  readonly entryBarIndex: number;
  readonly entryTimeMs: number;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly entryNotional: number;
  readonly entryFee: number;
}

type PositionState = {readonly kind: 'flat'} | LongPosition;

type SmaState =
  | {readonly kind: 'warming'}
  | {readonly kind: 'ready'; readonly fast: number; readonly slow: number};

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

function assertInvariant(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(`Backtest invariant violated: ${message}`);
  }
}

function sequenceId(jobId: string, kind: string, sequence: number): string {
  return `${jobId}:${kind}:${String(sequence).padStart(6, '0')}`;
}

function createPendingOrder(
  jobId: string,
  sequence: number,
  side: BacktestOrderSide,
  positionAction: BacktestPositionAction,
  signalBarIndex: number,
  submittedAtMs: number,
): PendingOrder {
  return {
    orderId: sequenceId(jobId, 'order', sequence),
    orderSequence: sequence,
    side,
    positionAction,
    orderType: 'market',
    sizing: 'all-in',
    timeInForce: 'next-bar-open',
    signalBarIndex,
    submittedAtMs,
  };
}

export function runCpuBacktest(input: BacktestInput): CpuBacktestResult {
  const snapshot = input.snapshot;
  const parameters = input.parameters;
  const identity = createBacktestJobIdentity(snapshot, parameters);
  const orders: BacktestOrder[] = [];
  const fills: BacktestFill[] = [];
  const roundTrips: BacktestRoundTrip[] = [];
  const equityCurve: BacktestEquityPoint[] = [];
  const events: BacktestEvent[] = [];

  let cash = BACKTEST_SETTINGS.initialCash;
  let position: PositionState = {kind: 'flat'};
  let pending: PendingOrder | null = null;
  let sma: SmaState = {kind: 'warming'};
  let fastSum = F32_ZERO;
  let slowSum = F32_ZERO;
  let peakEquity = BACKTEST_SETTINGS.initialCash;
  let maxDrawdown = F32_ZERO;
  let totalFees = F32_ZERO;
  let orderSequence = 0;
  let positionSequence = 0;

  for (let barIndex = 0; barIndex < snapshot.bars.length; barIndex++) {
    const bar = snapshot.bars[barIndex];

    if (pending !== null) {
      const fillSequence = fills.length + 1;
      const fillId = sequenceId(identity.jobId, 'fill', fillSequence);
      const referencePrice = bar.open;

      if (pending.side === 'buy') {
        assertInvariant(
          pending.positionAction === 'open' && position.kind === 'flat',
          'a buy fill must open a flat account',
        );

        const priceMultiplier = add(
          F32_ONE,
          BACKTEST_SETTINGS.adverseSlippageRate,
        );
        const fillPrice = multiply(referencePrice, priceMultiplier);
        const feeMultiplier = add(F32_ONE, BACKTEST_SETTINGS.takerFeeRate);
        const unitCost = multiply(fillPrice, feeMultiplier);
        const quantity = divide(cash, unitCost);
        const notional = multiply(quantity, fillPrice);
        const fee = multiply(notional, BACKTEST_SETTINGS.takerFeeRate);
        cash = subtract(cash, add(notional, fee));
        totalFees = add(totalFees, fee);
        positionSequence++;

        const positionId = sequenceId(
          identity.jobId,
          'position',
          positionSequence,
        );
        position = {
          kind: 'long',
          positionId,
          entryOrderId: pending.orderId,
          entryFillId: fillId,
          entryBarIndex: barIndex,
          entryTimeMs: bar.openTimeMs,
          quantity,
          entryPrice: fillPrice,
          entryNotional: notional,
          entryFee: fee,
        };

        const fill: BacktestFill = {
          fillId,
          fillSequence,
          orderId: pending.orderId,
          side: pending.side,
          positionAction: pending.positionAction,
          liquiditySide: 'taker',
          barIndex,
          filledAtMs: bar.openTimeMs,
          referencePrice,
          fillPrice,
          quantity,
          notional,
          fee,
          cashAfter: cash,
          positionQuantityAfter: quantity,
        };
        const order: FilledBacktestOrder = {
          ...pending,
          status: 'filled',
          fillId,
          fillBarIndex: barIndex,
          filledAtMs: bar.openTimeMs,
          filledQuantity: quantity,
        };
        fills.push(fill);
        orders.push(order);
        events.push({
          type: 'order-filled',
          sequence: events.length,
          barIndex,
          timestampMs: bar.openTimeMs,
          orderId: pending.orderId,
          fillId,
          side: pending.side,
          quantity,
          fillPrice,
          fee,
        });
      } else {
        assertInvariant(
          pending.positionAction === 'close' && position.kind === 'long',
          'a sell fill must close an existing long position',
        );

        const closingPosition = position;
        const priceMultiplier = subtract(
          F32_ONE,
          BACKTEST_SETTINGS.adverseSlippageRate,
        );
        const fillPrice = multiply(referencePrice, priceMultiplier);
        const quantity = closingPosition.quantity;
        const notional = multiply(quantity, fillPrice);
        const fee = multiply(notional, BACKTEST_SETTINGS.takerFeeRate);
        cash = add(cash, subtract(notional, fee));
        totalFees = add(totalFees, fee);

        const totalTradeFees = add(closingPosition.entryFee, fee);
        const priceChange = subtract(fillPrice, closingPosition.entryPrice);
        const grossPnl = multiply(quantity, priceChange);
        const netPnl = subtract(grossPnl, totalTradeFees);
        const entryCost = add(
          closingPosition.entryNotional,
          closingPosition.entryFee,
        );
        const realizedReturn = divide(netPnl, entryCost);
        const roundTripSequence = roundTrips.length + 1;
        const roundTripId = sequenceId(
          identity.jobId,
          'round-trip',
          roundTripSequence,
        );

        const roundTrip: BacktestRoundTrip = {
          roundTripId,
          positionId: closingPosition.positionId,
          entryOrderId: closingPosition.entryOrderId,
          entryFillId: closingPosition.entryFillId,
          exitOrderId: pending.orderId,
          exitFillId: fillId,
          entryBarIndex: closingPosition.entryBarIndex,
          entryTimeMs: closingPosition.entryTimeMs,
          exitBarIndex: barIndex,
          exitTimeMs: bar.openTimeMs,
          durationMs: bar.openTimeMs - closingPosition.entryTimeMs,
          quantity,
          entryPrice: closingPosition.entryPrice,
          exitPrice: fillPrice,
          entryNotional: closingPosition.entryNotional,
          exitNotional: notional,
          entryFee: closingPosition.entryFee,
          exitFee: fee,
          totalFees: totalTradeFees,
          grossPnl,
          netPnl,
          realizedReturn,
        };
        const fill: BacktestFill = {
          fillId,
          fillSequence,
          orderId: pending.orderId,
          side: pending.side,
          positionAction: pending.positionAction,
          liquiditySide: 'taker',
          barIndex,
          filledAtMs: bar.openTimeMs,
          referencePrice,
          fillPrice,
          quantity,
          notional,
          fee,
          cashAfter: cash,
          positionQuantityAfter: F32_ZERO,
        };
        const order: FilledBacktestOrder = {
          ...pending,
          status: 'filled',
          fillId,
          fillBarIndex: barIndex,
          filledAtMs: bar.openTimeMs,
          filledQuantity: quantity,
        };
        fills.push(fill);
        orders.push(order);
        roundTrips.push(roundTrip);
        events.push({
          type: 'order-filled',
          sequence: events.length,
          barIndex,
          timestampMs: bar.openTimeMs,
          orderId: pending.orderId,
          fillId,
          side: pending.side,
          quantity,
          fillPrice,
          fee,
        });
        position = {kind: 'flat'};
      }

      pending = null;
    }

    fastSum = add(fastSum, bar.close);
    if (barIndex >= parameters.fastPeriod) {
      fastSum = subtract(
        fastSum,
        snapshot.bars[barIndex - parameters.fastPeriod].close,
      );
    }

    slowSum = add(slowSum, bar.close);
    if (barIndex >= parameters.slowPeriod) {
      slowSum = subtract(
        slowSum,
        snapshot.bars[barIndex - parameters.slowPeriod].close,
      );
    }

    if (barIndex + 1 >= parameters.slowPeriod) {
      const fast = divide(fastSum, Math.fround(parameters.fastPeriod));
      const slow = divide(slowSum, Math.fround(parameters.slowPeriod));

      if (sma.kind === 'ready') {
        const crossedAbove =
          sma.fast <= sma.slow && fast > slow && position.kind === 'flat';
        const crossedBelow =
          sma.fast >= sma.slow && fast < slow && position.kind === 'long';

        if (crossedAbove || crossedBelow) {
          orderSequence++;
          const side: BacktestOrderSide = crossedAbove ? 'buy' : 'sell';
          const positionAction: BacktestPositionAction = crossedAbove
            ? 'open'
            : 'close';
          pending = createPendingOrder(
            identity.jobId,
            orderSequence,
            side,
            positionAction,
            barIndex,
            bar.closeTimeMs,
          );
          events.push({
            type: 'order-submitted',
            sequence: events.length,
            barIndex,
            timestampMs: bar.closeTimeMs,
            orderId: pending.orderId,
            side,
            positionAction,
          });
        }
      }

      sma = {kind: 'ready', fast, slow};
    }

    const positionQuantity =
      position.kind === 'long' ? position.quantity : F32_ZERO;
    const positionValue = multiply(positionQuantity, bar.close);
    const equity = add(cash, positionValue);
    if (equity > peakEquity) {
      peakEquity = equity;
    }
    const drawdown = divide(subtract(peakEquity, equity), peakEquity);
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }

    equityCurve.push({
      equityPointIndex: equityCurve.length,
      barIndex,
      openTimeMs: bar.openTimeMs,
      closeTimeMs: bar.closeTimeMs,
      cash,
      positionQuantity,
      close: bar.close,
      equity,
      peakEquity,
      drawdown,
    });
  }

  if (pending !== null) {
    const finalBarIndex = snapshot.bars.length - 1;
    const finalBar = snapshot.bars[finalBarIndex];
    orders.push({
      ...pending,
      status: 'expired',
      expiredAtMs: finalBar.closeTimeMs,
      reason: 'end-of-data',
    });
    events.push({
      type: 'order-expired',
      sequence: events.length,
      barIndex: finalBarIndex,
      timestampMs: finalBar.closeTimeMs,
      orderId: pending.orderId,
      side: pending.side,
      reason: 'end-of-data',
    });
  }

  const finalEquityPoint = equityCurve[equityCurve.length - 1];
  assertInvariant(
    finalEquityPoint !== undefined,
    'equity curve cannot be empty',
  );
  const finalPositionQuantity =
    position.kind === 'long' ? position.quantity : F32_ZERO;
  const totalReturn = subtract(
    divide(finalEquityPoint.equity, BACKTEST_SETTINGS.initialCash),
    F32_ONE,
  );
  const expiredOrderCount = orders.filter(
    order => order.status === 'expired',
  ).length;

  return {
    identity,
    settings: BACKTEST_SETTINGS,
    summary: {
      jobId: identity.jobId,
      barCount: snapshot.bars.length,
      initialCash: BACKTEST_SETTINGS.initialCash,
      finalCash: cash,
      finalPositionQuantity,
      finalEquity: finalEquityPoint.equity,
      totalReturn,
      maxDrawdown,
      totalFees,
      orderCount: orders.length,
      filledOrderCount: fills.length,
      expiredOrderCount,
      fillCount: fills.length,
      roundTripCount: roundTrips.length,
      equityPointCount: equityCurve.length,
      eventCount: events.length,
    },
    orders,
    fills,
    roundTrips,
    equityCurve,
    events,
  };
}
