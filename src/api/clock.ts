/**
 * Clock algebra for time series manipulation.
 *
 * Clock algebra deals with the reasoning of presence of discrete
 * time series data. It helps answering questions like:
 * * Give time series x, y with different time cadence, how to combine them? what semantics are available?
 *
 */

import * as z from 'zod';
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

export const enum Interpolation {
  Stepwise = 1,
  Linear,
  Absent,
}

export abstract class Clocked {
  abstract readonly clock: Clock;

  /**
   * Check if this clock divides the other clock.
   * Note that runtime divisibility check is intentionally made conservative.
   * @param other
   * @returns
   */
  public divides(other: Clocked): boolean {
    if (
      other.clock === i ||
      this.clock === i ||
      other.clock % this.clock !== 0n
    ) {
      return false;
    }
    return true;
  }

  public matches(other: Clocked): boolean {
    return this.clock === other.clock;
  }
}

export class TimeSeries<S extends z.ZodType> extends Clocked {
  readonly schema: S;

  constructor(
    schema: S,
    public readonly clock: Clock,
  ) {
    super();
    this.schema = schema;
  }
}

export class MergePolicy {
  constructor(public readonly ip: Interpolation) {}
}
