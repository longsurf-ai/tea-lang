// Purpose: Define the fixed simulator settings and deterministic CPU/GPU parity artifact contract.

import {z} from 'zod';

import {
  MarketSnapshotSchema,
  ParameterPairSchema,
  type MarketSnapshot,
  type ParameterPair,
} from './contracts';

export const BACKTEST_SETTINGS = Object.freeze({
  initialCash: Math.fround(100_000),
  adverseSlippageBps: 1,
  adverseSlippageRate: Math.fround(1 / 10_000),
  takerFeeBps: 1,
  takerFeeRate: Math.fround(1 / 10_000),
});

export type BacktestSettings = typeof BACKTEST_SETTINGS;

export const BacktestInputSchema = z
  .strictObject({
    snapshot: MarketSnapshotSchema,
    parameters: ParameterPairSchema,
  })
  .superRefine((input, context) => {
    if (input.parameters.slowPeriod <= input.snapshot.bars.length) {
      return;
    }
    context.addIssue({
      code: 'custom',
      message: 'slowPeriod must not exceed the snapshot bar count',
      path: ['parameters', 'slowPeriod'],
    });
  })
  .readonly();

export type BacktestInput = z.infer<typeof BacktestInputSchema>;

export interface BacktestJobIdentity {
  readonly jobId: string;
  readonly venue: MarketSnapshot['venue'];
  readonly marketType: MarketSnapshot['marketType'];
  readonly symbol: string;
  readonly interval: MarketSnapshot['interval'];
  readonly parameters: ParameterPair;
}

export type BacktestOrderSide = 'buy' | 'sell';
export type BacktestPositionAction = 'open' | 'close';

interface BacktestOrderBase {
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

export interface FilledBacktestOrder extends BacktestOrderBase {
  readonly status: 'filled';
  readonly fillId: string;
  readonly fillBarIndex: number;
  readonly filledAtMs: number;
  readonly filledQuantity: number;
}

export interface ExpiredBacktestOrder extends BacktestOrderBase {
  readonly status: 'expired';
  readonly expiredAtMs: number;
  readonly reason: 'end-of-data';
}

export type BacktestOrder = FilledBacktestOrder | ExpiredBacktestOrder;

export interface BacktestFill {
  readonly fillId: string;
  readonly fillSequence: number;
  readonly orderId: string;
  readonly side: BacktestOrderSide;
  readonly positionAction: BacktestPositionAction;
  readonly liquiditySide: 'taker';
  readonly barIndex: number;
  readonly filledAtMs: number;
  readonly referencePrice: number;
  readonly fillPrice: number;
  readonly quantity: number;
  readonly notional: number;
  readonly fee: number;
  readonly cashAfter: number;
  readonly positionQuantityAfter: number;
}

export interface BacktestRoundTrip {
  readonly roundTripId: string;
  readonly positionId: string;
  readonly entryOrderId: string;
  readonly entryFillId: string;
  readonly exitOrderId: string;
  readonly exitFillId: string;
  readonly entryBarIndex: number;
  readonly entryTimeMs: number;
  readonly exitBarIndex: number;
  readonly exitTimeMs: number;
  readonly durationMs: number;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly entryNotional: number;
  readonly exitNotional: number;
  readonly entryFee: number;
  readonly exitFee: number;
  readonly totalFees: number;
  readonly grossPnl: number;
  readonly netPnl: number;
  readonly realizedReturn: number;
}

export interface BacktestEquityPoint {
  readonly equityPointIndex: number;
  readonly barIndex: number;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly cash: number;
  readonly positionQuantity: number;
  readonly close: number;
  readonly equity: number;
  readonly peakEquity: number;
  readonly drawdown: number;
}

interface BacktestEventBase {
  readonly sequence: number;
  readonly barIndex: number;
  readonly timestampMs: number;
}

export interface OrderSubmittedEvent extends BacktestEventBase {
  readonly type: 'order-submitted';
  readonly orderId: string;
  readonly side: BacktestOrderSide;
  readonly positionAction: BacktestPositionAction;
}

export interface OrderFilledEvent extends BacktestEventBase {
  readonly type: 'order-filled';
  readonly orderId: string;
  readonly fillId: string;
  readonly side: BacktestOrderSide;
  readonly quantity: number;
  readonly fillPrice: number;
  readonly fee: number;
}

export interface OrderExpiredEvent extends BacktestEventBase {
  readonly type: 'order-expired';
  readonly orderId: string;
  readonly side: BacktestOrderSide;
  readonly reason: 'end-of-data';
}

export type BacktestEvent =
  | OrderSubmittedEvent
  | OrderFilledEvent
  | OrderExpiredEvent;

export interface BacktestSummary {
  readonly jobId: string;
  readonly barCount: number;
  readonly initialCash: number;
  readonly finalCash: number;
  readonly finalPositionQuantity: number;
  readonly finalEquity: number;
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly totalFees: number;
  readonly orderCount: number;
  readonly filledOrderCount: number;
  readonly expiredOrderCount: number;
  readonly fillCount: number;
  readonly roundTripCount: number;
  readonly equityPointCount: number;
  readonly eventCount: number;
}

export interface CpuBacktestResult {
  readonly identity: BacktestJobIdentity;
  readonly settings: BacktestSettings;
  readonly summary: BacktestSummary;
  readonly orders: readonly BacktestOrder[];
  readonly fills: readonly BacktestFill[];
  readonly roundTrips: readonly BacktestRoundTrip[];
  readonly equityCurve: readonly BacktestEquityPoint[];
  readonly events: readonly BacktestEvent[];
}

export function parseBacktestInput(input: unknown): BacktestInput {
  return BacktestInputSchema.parse(input);
}

export function createBacktestJobIdentity(
  snapshot: MarketSnapshot,
  parameters: ParameterPair,
): BacktestJobIdentity {
  const jobId = [
    snapshot.venue,
    snapshot.marketType,
    snapshot.symbol,
    snapshot.interval,
    parameters.fastPeriod,
    parameters.slowPeriod,
  ].join(':');

  return {
    jobId,
    venue: snapshot.venue,
    marketType: snapshot.marketType,
    symbol: snapshot.symbol,
    interval: snapshot.interval,
    parameters,
  };
}
