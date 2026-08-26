/**
 * Clock algebra for time series manipulation.
 *
 * Clock algebra deals with the reasoning of presence of discrete
 * time series data. It helps answering questions like:
 * * Give time series x, y with different time cadence, how to combine them? what semantics are available?
 *
 */

declare const clock: unique symbol;

export type Clock = bigint & {
  readonly [clock]: true;
};

// Defining irregular clock as 0 has the benefit of not
// being able to be divided by any other clock.
export const i: Clock = 0n as Clock;
export const ns: Clock = 1n as Clock;
export const us: Clock = (1000n * ns) as Clock;
export const ms: Clock = (1000n * us) as Clock;
export const s: Clock = (1000n * ms) as Clock;
export const m: Clock = (60n * s) as Clock;
export const h: Clock = (60n * m) as Clock;
export const d: Clock = (24n * h) as Clock;
export const w: Clock = (7n * d) as Clock;
export const M: Clock = (30n * d) as Clock;
export const y: Clock = (360n * d) as Clock;

/** Convert one concrete Tea timeframe to its regular clock, or `i`. */
export function timeframeClock(timeframe: string): Clock {
  const match = /^([1-9]\d*)?([SDWM])$/.exec(timeframe);
  if (/^[1-9]\d*$/.test(timeframe)) {
    return (BigInt(timeframe) * m) as Clock;
  }
  if (match === null) return i;
  const count = BigInt(match[1] ?? '1');
  const unit =
    match[2] === 'S' ? s : match[2] === 'D' ? d : match[2] === 'W' ? w : M;
  return (count * unit) as Clock;
}
