// Purpose: Scalar Tea intrinsics shared by handwritten and generated programs.

import {fatal} from '../base/print';
import {applyTransparency, rgbColor} from '../base/color';
import type {Scalar} from './value';
import {Value, bool, color, float, int, text, type Numeric} from './js/value';

function numeric<N extends Numeric>(value: number, kind: N): Value<number, N> {
  return new Value(Number.isFinite(value) ? value : NaN, kind);
}

function round(x: Value<number, Numeric>): Value<number, 'int'>;
function round(
  x: Value<number, Numeric>,
  precision: Value<number, 'int'>,
): Value<number, 'float'>;
function round(x: Value<number, Numeric>, precision?: Value<number, 'int'>) {
  if (precision === undefined) return int(Math.round(x.value));
  const scale = Math.pow(10, precision.value);
  return float(Math.round(x.value * scale) / scale);
}

/**
 * Numeric intrinsics preserve Tea's result kind and normalize overflow to NA.
 * @example `math.round(float(1.235), int(2)).value` is 1.24.
 */
export const math = {
  abs<N extends Numeric>(x: Value<number, N>): Value<number, N> {
    return numeric(Math.abs(x.value), x.kind);
  },
  sign<N extends Numeric>(x: Value<number, N>): Value<number, N> {
    return numeric(Math.sign(x.value), x.kind);
  },
  floor: (x: Value<number, Numeric>) => int(Math.floor(x.value)),
  ceil: (x: Value<number, Numeric>) => int(Math.ceil(x.value)),
  round,
  sqrt: (x: Value<number, Numeric>) => float(Math.sqrt(x.value)),
  pow: (x: Value<number, Numeric>, y: Value<number, Numeric>) =>
    float(Math.pow(x.value, y.value)),
  log: (x: Value<number, Numeric>) => float(Math.log(x.value)),
  log10: (x: Value<number, Numeric>) => float(Math.log10(x.value)),
  exp: (x: Value<number, Numeric>) => float(Math.exp(x.value)),
  max<N extends Numeric>(
    ...values: readonly Value<number, N>[]
  ): Value<number, N> {
    return numeric(
      Math.max(...values.map(x => x.value)),
      values.some(x => x.kind === 'float') ? 'float' : 'int',
    ) as Value<number, N>;
  },
  min<N extends Numeric>(
    ...values: readonly Value<number, N>[]
  ): Value<number, N> {
    return numeric(
      Math.min(...values.map(x => x.value)),
      values.some(x => x.kind === 'float') ? 'float' : 'int',
    ) as Value<number, N>;
  },
  avg: (...values: readonly Value<number, Numeric>[]) =>
    float(values.reduce((sum, x) => sum + x.value, 0) / values.length),
};

/**
 * Colors reuse the canonical encoding also used by constant folding.
 * @example `colors.rgb(int(255), int(0), int(0)).value` is '#FF0000'.
 */
export const colors = {
  new(
    value: Value<string | null, 'color'>,
    transparency: Value<number, Numeric>,
  ) {
    return color(
      value.value === null || !Number.isFinite(transparency.value)
        ? null
        : applyTransparency(value.value, transparency.value),
    );
  },
  rgb(
    r: Value<number, Numeric>,
    g: Value<number, Numeric>,
    b: Value<number, Numeric>,
    transparency?: Value<number, Numeric>,
  ) {
    const channels = [r.value, g.value, b.value, transparency?.value ?? 0];
    return color(
      channels.every(Number.isFinite)
        ? rgbColor(r.value, g.value, b.value, transparency?.value ?? null)
        : null,
    );
  },
};

export const str = {
  tostring(
    value: Value<unknown>,
    titles: readonly (readonly [string, string])[] = [],
  ) {
    const raw = value.value;
    return text(
      raw === null || Number.isNaN(raw)
        ? 'NaN'
        : (titles.find(([name]) => name === raw)?.[1] ?? String(raw)),
    );
  },
};

/** Numeric NA is NaN, nullable NA is null, and booleans have no NA value. */
export function na(value: Value<unknown>): Value<boolean, 'bool'> {
  return bool(value.value === null || Number.isNaN(value.value));
}

/** Use the replacement only when the captured value is missing. */
export function nz<T, K extends string>(
  value: Value<T, K>,
  replacement?: Value<T, K>,
): Value<T, K> {
  if (!na(value).value) return value;
  if (replacement !== undefined) return replacement;
  const raw =
    value.kind === 'int' || value.kind === 'float'
      ? 0
      : value.kind === 'string'
        ? ''
        : value.kind === 'color'
          ? '#00000000'
          : fatal(`nz requires a replacement for ${value.kind}`);
  return new Value(raw as T, value.kind);
}

/** Invalid offsets demand no retained history. */
export function historyDepth(
  value: Value<number, Numeric>,
): Value<number, 'int'> {
  return int(
    Number.isSafeInteger(value.value) && value.value >= 0 ? value.value : 0,
  );
}

/** Stop a range whose floating-point step can no longer advance its index. */
export function rangeNext<N extends Numeric>(
  x: Value<number, N>,
  step: Value<number, N>,
): Value<number, N> {
  const next = x.value + step.value;
  return numeric(
    (step.value > 0 && next > x.value) || (step.value < 0 && next < x.value)
      ? next
      : NaN,
    x.kind,
  );
}

/** @internal Read a bind-visible builtin; execution-only builtins have no value here. */
export function contextValue(
  values: ReadonlyMap<number, Scalar> | undefined,
  id: number,
  name: string,
): Scalar {
  if (values === undefined || !values.has(id)) {
    throw new Error(`builtin '${name}' is not bind-visible`);
  }
  return values.get(id)!;
}
