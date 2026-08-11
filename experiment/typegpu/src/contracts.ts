// Purpose: Parse deterministic Binance OHLCV snapshots and SMA parameter pairs at the package boundary.

import {z} from 'zod';

const SafeTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const PositiveF32Schema = z
  .number()
  .finite()
  .positive()
  .refine(
    value => Number.isFinite(Math.fround(value)) && Math.fround(value) > 0,
    {
      message: 'Value must be representable as a positive finite f32',
    },
  )
  .transform(value => Math.fround(value));

const NonnegativeF32Schema = z
  .number()
  .finite()
  .nonnegative()
  .refine(value => Number.isFinite(Math.fround(value)), {
    message: 'Value must be representable as a finite f32',
  })
  .transform(value => Math.fround(value));

export const MarketBarSchema = z
  .strictObject({
    openTimeMs: SafeTimestampSchema,
    closeTimeMs: SafeTimestampSchema,
    open: PositiveF32Schema,
    high: PositiveF32Schema,
    low: PositiveF32Schema,
    close: PositiveF32Schema,
    volume: NonnegativeF32Schema,
  })
  .superRefine((bar, context) => {
    if (bar.openTimeMs >= bar.closeTimeMs) {
      context.addIssue({
        code: 'custom',
        message: 'openTimeMs must be earlier than closeTimeMs',
        path: ['closeTimeMs'],
      });
    }

    const highestObserved = Math.max(bar.open, bar.low, bar.close);
    if (bar.high < highestObserved) {
      context.addIssue({
        code: 'custom',
        message: 'high must be at least open, low, and close',
        path: ['high'],
      });
    }

    const lowestObserved = Math.min(bar.open, bar.high, bar.close);
    if (bar.low > lowestObserved) {
      context.addIssue({
        code: 'custom',
        message: 'low must be at most open, high, and close',
        path: ['low'],
      });
    }
  })
  .readonly();

export type MarketBar = z.infer<typeof MarketBarSchema>;

const MarketBarsSchema = z
  .array(MarketBarSchema)
  .min(2)
  .superRefine((bars, context) => {
    for (let index = 1; index < bars.length; index++) {
      const previous = bars[index - 1];
      const current = bars[index];
      if (current.openTimeMs > previous.closeTimeMs) {
        continue;
      }
      context.addIssue({
        code: 'custom',
        message: 'Bars must be strictly ordered and non-overlapping',
        path: [index, 'openTimeMs'],
      });
    }
  })
  .readonly();

export const MarketSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    venue: z.literal('binance'),
    marketType: z.literal('spot'),
    symbol: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]+$/),
    interval: z.enum(['1h', '1d']),
    bars: MarketBarsSchema,
  })
  .readonly();

export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const MarketSnapshotsSchema = z
  .array(MarketSnapshotSchema)
  .min(1)
  .superRefine((snapshots, context) => {
    const identities = new Set<string>();
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index];
      const identity = `${snapshot.venue}:${snapshot.marketType}:${snapshot.symbol}:${snapshot.interval}`;
      if (!identities.has(identity)) {
        identities.add(identity);
        continue;
      }
      context.addIssue({
        code: 'custom',
        message: `Duplicate market snapshot ${identity}`,
        path: [index],
      });
    }
  })
  .readonly();

export type MarketSnapshots = z.infer<typeof MarketSnapshotsSchema>;

export const ParameterPairSchema = z
  .strictObject({
    fastPeriod: z.number().int().positive().max(0xffff_ffff),
    slowPeriod: z.number().int().positive().max(0xffff_ffff),
  })
  .refine(pair => pair.fastPeriod < pair.slowPeriod, {
    message: 'fastPeriod must be less than slowPeriod',
    path: ['fastPeriod'],
  })
  .readonly();

export type ParameterPair = z.infer<typeof ParameterPairSchema>;

export const ParameterPairsSchema = z
  .array(ParameterPairSchema)
  .min(1)
  .superRefine((pairs, context) => {
    const identities = new Set<string>();
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index];
      const identity = `${pair.fastPeriod}:${pair.slowPeriod}`;
      if (!identities.has(identity)) {
        identities.add(identity);
        continue;
      }
      context.addIssue({
        code: 'custom',
        message: `Duplicate SMA parameter pair ${identity}`,
        path: [index],
      });
    }
  })
  .readonly();

export type ParameterPairs = z.infer<typeof ParameterPairsSchema>;

export function parseMarketSnapshot(input: unknown): MarketSnapshot {
  return MarketSnapshotSchema.parse(input);
}

export function parseMarketSnapshots(input: unknown): MarketSnapshots {
  return MarketSnapshotsSchema.parse(input);
}

export function parseParameterPair(input: unknown): ParameterPair {
  return ParameterPairSchema.parse(input);
}

export function parseParameterPairs(input: unknown): ParameterPairs {
  return ParameterPairsSchema.parse(input);
}
