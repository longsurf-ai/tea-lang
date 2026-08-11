// Purpose: Validate the GPU exchange journal and replay it into rich CPU orders, trades, and equity artifacts.

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
import {
  GPU_EVENT_FILL,
  GPU_EVENT_ORDER_EXPIRED,
  GPU_EVENT_ORDER_SUBMITTED,
  GPU_SIDE_BUY,
  GPU_SIDE_SELL,
} from './typegpu-kernel';
import type {TypeGpuSweepOutput} from './typegpu-engine';

const F32_ZERO = Math.fround(0);
const F32_ONE = Math.fround(1);
const REPLAY_RELATIVE_TOLERANCE = 0.00002;
const REPLAY_ABSOLUTE_TOLERANCE = 0.0001;

type GpuEvent = TypeGpuSweepOutput['events'][number];

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
    throw new Error(`GPU journal invariant violated: ${message}`);
  }
}

function assertNear(label: string, actual: number, expected: number): void {
  const tolerance = Math.max(
    REPLAY_ABSOLUTE_TOLERANCE,
    Math.abs(expected) * REPLAY_RELATIVE_TOLERANCE,
  );
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `GPU journal ${label} differs: actual ${actual}, expected ${expected}, tolerance ${tolerance}`,
    );
  }
}

function sequenceId(jobId: string, kind: string, sequence: number): string {
  return `${jobId}:${kind}:${String(sequence).padStart(6, '0')}`;
}

function sideFromGpu(side: number): BacktestOrderSide {
  if (side === GPU_SIDE_BUY) return 'buy';
  if (side === GPU_SIDE_SELL) return 'sell';
  throw new Error(`GPU journal contains unknown side ${side}`);
}

function pushSubmittedEvent(options: {
  readonly barIndex: number;
  readonly event: GpuEvent;
  readonly events: BacktestEvent[];
  readonly jobId: string;
  readonly orderSequence: number;
  readonly position: PositionState;
  readonly submittedAtMs: number;
}): PendingOrder {
  const side = sideFromGpu(options.event.side);
  const positionAction: BacktestPositionAction =
    side === 'buy' ? 'open' : 'close';
  assertInvariant(
    (side === 'buy' && options.position.kind === 'flat') ||
      (side === 'sell' && options.position.kind === 'long'),
    `submitted ${side} is incompatible with ${options.position.kind}`,
  );
  const pending: PendingOrder = {
    orderId: sequenceId(options.jobId, 'order', options.orderSequence),
    orderSequence: options.orderSequence,
    side,
    positionAction,
    orderType: 'market',
    sizing: 'all-in',
    timeInForce: 'next-bar-open',
    signalBarIndex: options.barIndex,
    submittedAtMs: options.submittedAtMs,
  };
  options.events.push({
    type: 'order-submitted',
    sequence: options.event.sequence,
    barIndex: options.barIndex,
    timestampMs: options.submittedAtMs,
    orderId: pending.orderId,
    side,
    positionAction,
  });
  return pending;
}

export function replayGpuBacktestJournal(options: {
  readonly events: readonly GpuEvent[];
  readonly input: BacktestInput;
  readonly jobIndex: number;
}): CpuBacktestResult {
  const {snapshot, parameters} = options.input;
  const identity = createBacktestJobIdentity(snapshot, parameters);
  const orders: BacktestOrder[] = [];
  const fills: BacktestFill[] = [];
  const roundTrips: BacktestRoundTrip[] = [];
  const equityCurve: BacktestEquityPoint[] = [];
  const events: BacktestEvent[] = [];
  let cash = BACKTEST_SETTINGS.initialCash;
  let position: PositionState = {kind: 'flat'};
  let pending: PendingOrder | null = null;
  let totalFees = F32_ZERO;
  let peakEquity = BACKTEST_SETTINGS.initialCash;
  let maxDrawdown = F32_ZERO;
  let eventCursor = 0;
  let orderSequence = 0;
  let positionSequence = 0;

  for (let barIndex = 0; barIndex < snapshot.bars.length; barIndex++) {
    const bar = snapshot.bars[barIndex];
    while (options.events[eventCursor]?.barIndex === barIndex) {
      const gpuEvent = options.events[eventCursor];
      assertInvariant(
        gpuEvent.jobIndex === options.jobIndex,
        `event ${eventCursor} references job ${gpuEvent.jobIndex}`,
      );
      assertInvariant(
        gpuEvent.sequence === eventCursor,
        `event sequence ${gpuEvent.sequence} is not contiguous at ${eventCursor}`,
      );

      if (gpuEvent.kind === GPU_EVENT_ORDER_SUBMITTED) {
        assertInvariant(
          pending === null,
          'cannot submit while an order is pending',
        );
        assertNear('submitted price', gpuEvent.price, 0);
        assertNear('submitted quantity', gpuEvent.quantity, 0);
        assertNear('submitted fee', gpuEvent.fee, 0);
        orderSequence++;
        pending = pushSubmittedEvent({
          event: gpuEvent,
          events,
          jobId: identity.jobId,
          orderSequence,
          position,
          barIndex,
          submittedAtMs: bar.closeTimeMs,
        });
      } else if (gpuEvent.kind === GPU_EVENT_FILL) {
        assertInvariant(pending !== null, 'fill requires a pending order');
        assertInvariant(
          pending.signalBarIndex + 1 === barIndex,
          'fill must occur at the next bar open',
        );
        const side = sideFromGpu(gpuEvent.side);
        assertInvariant(
          side === pending.side,
          'fill side must match pending order',
        );
        const expectedFillPrice = multiply(
          bar.open,
          side === 'buy'
            ? add(F32_ONE, BACKTEST_SETTINGS.adverseSlippageRate)
            : subtract(F32_ONE, BACKTEST_SETTINGS.adverseSlippageRate),
        );
        assertNear('fill price', gpuEvent.price, expectedFillPrice);
        const fillSequence = fills.length + 1;
        const fillId = sequenceId(identity.jobId, 'fill', fillSequence);

        if (side === 'buy') {
          assertInvariant(
            position.kind === 'flat',
            'buy fill must open flat state',
          );
          const expectedQuantity = divide(
            cash,
            multiply(
              gpuEvent.price,
              add(F32_ONE, BACKTEST_SETTINGS.takerFeeRate),
            ),
          );
          assertNear('buy quantity', gpuEvent.quantity, expectedQuantity);
          const notional = multiply(gpuEvent.quantity, gpuEvent.price);
          const expectedFee = multiply(
            notional,
            BACKTEST_SETTINGS.takerFeeRate,
          );
          assertNear('buy fee', gpuEvent.fee, expectedFee);
          cash = subtract(cash, add(notional, gpuEvent.fee));
          totalFees = add(totalFees, gpuEvent.fee);
          positionSequence++;
          position = {
            kind: 'long',
            positionId: sequenceId(
              identity.jobId,
              'position',
              positionSequence,
            ),
            entryOrderId: pending.orderId,
            entryFillId: fillId,
            entryBarIndex: barIndex,
            entryTimeMs: bar.openTimeMs,
            quantity: gpuEvent.quantity,
            entryPrice: gpuEvent.price,
            entryNotional: notional,
            entryFee: gpuEvent.fee,
          };
        } else {
          assertInvariant(
            position.kind === 'long',
            'sell fill must close long state',
          );
          const closingPosition = position;
          assertNear(
            'sell quantity',
            gpuEvent.quantity,
            closingPosition.quantity,
          );
          const notional = multiply(gpuEvent.quantity, gpuEvent.price);
          const expectedFee = multiply(
            notional,
            BACKTEST_SETTINGS.takerFeeRate,
          );
          assertNear('sell fee', gpuEvent.fee, expectedFee);
          cash = add(cash, subtract(notional, gpuEvent.fee));
          totalFees = add(totalFees, gpuEvent.fee);
          const totalTradeFees = add(closingPosition.entryFee, gpuEvent.fee);
          const grossPnl = multiply(
            gpuEvent.quantity,
            subtract(gpuEvent.price, closingPosition.entryPrice),
          );
          const netPnl = subtract(grossPnl, totalTradeFees);
          roundTrips.push({
            roundTripId: sequenceId(
              identity.jobId,
              'round-trip',
              roundTrips.length + 1,
            ),
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
            quantity: gpuEvent.quantity,
            entryPrice: closingPosition.entryPrice,
            exitPrice: gpuEvent.price,
            entryNotional: closingPosition.entryNotional,
            exitNotional: notional,
            entryFee: closingPosition.entryFee,
            exitFee: gpuEvent.fee,
            totalFees: totalTradeFees,
            grossPnl,
            netPnl,
            realizedReturn: divide(
              netPnl,
              add(closingPosition.entryNotional, closingPosition.entryFee),
            ),
          });
          position = {kind: 'flat'};
        }

        const positionQuantity =
          position.kind === 'long' ? position.quantity : F32_ZERO;
        const notional = multiply(gpuEvent.quantity, gpuEvent.price);
        fills.push({
          fillId,
          fillSequence,
          orderId: pending.orderId,
          side,
          positionAction: pending.positionAction,
          liquiditySide: 'taker',
          barIndex,
          filledAtMs: bar.openTimeMs,
          referencePrice: bar.open,
          fillPrice: gpuEvent.price,
          quantity: gpuEvent.quantity,
          notional,
          fee: gpuEvent.fee,
          cashAfter: cash,
          positionQuantityAfter: positionQuantity,
        });
        const order: FilledBacktestOrder = {
          ...pending,
          status: 'filled',
          fillId,
          fillBarIndex: barIndex,
          filledAtMs: bar.openTimeMs,
          filledQuantity: gpuEvent.quantity,
        };
        orders.push(order);
        events.push({
          type: 'order-filled',
          sequence: gpuEvent.sequence,
          barIndex,
          timestampMs: bar.openTimeMs,
          orderId: pending.orderId,
          fillId,
          side,
          quantity: gpuEvent.quantity,
          fillPrice: gpuEvent.price,
          fee: gpuEvent.fee,
        });
        pending = null;
      } else if (gpuEvent.kind === GPU_EVENT_ORDER_EXPIRED) {
        assertInvariant(
          pending !== null,
          'expiration requires a pending order',
        );
        assertInvariant(
          barIndex === snapshot.bars.length - 1,
          'only a final-bar order may expire',
        );
        assertInvariant(
          sideFromGpu(gpuEvent.side) === pending.side,
          'expiration side must match pending order',
        );
        orders.push({
          ...pending,
          status: 'expired',
          expiredAtMs: bar.closeTimeMs,
          reason: 'end-of-data',
        });
        events.push({
          type: 'order-expired',
          sequence: gpuEvent.sequence,
          barIndex,
          timestampMs: bar.closeTimeMs,
          orderId: pending.orderId,
          side: pending.side,
          reason: 'end-of-data',
        });
        pending = null;
      } else {
        throw new Error(
          `GPU journal contains unknown event kind ${gpuEvent.kind}`,
        );
      }
      eventCursor++;
    }

    const positionQuantity =
      position.kind === 'long' ? position.quantity : F32_ZERO;
    const equity = add(cash, multiply(positionQuantity, bar.close));
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = divide(subtract(peakEquity, equity), peakEquity);
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
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

  assertInvariant(
    eventCursor === options.events.length,
    'journal has events beyond the series',
  );
  assertInvariant(pending === null, 'journal ends with an unresolved order');
  const finalEquityPoint = equityCurve.at(-1);
  assertInvariant(
    finalEquityPoint !== undefined,
    'equity curve cannot be empty',
  );
  const finalPositionQuantity =
    position.kind === 'long' ? position.quantity : F32_ZERO;
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
      totalReturn: subtract(
        divide(finalEquityPoint.equity, BACKTEST_SETTINGS.initialCash),
        F32_ONE,
      ),
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
