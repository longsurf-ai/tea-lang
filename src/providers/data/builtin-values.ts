// Purpose: Provider builtin-value helpers for exact syminfo/timeframe source keys; this module derives scalar fields only and owns no runtime context object.

import type {BuiltinSource, Value} from '../../runtime/abi';

type ProviderBuiltinSource = Extract<
  BuiltinSource,
  {readonly domain: 'syminfo' | 'timeframe'}
>;
type ProviderSymbolSource = Extract<
  BuiltinSource,
  {readonly domain: 'syminfo'}
>;

export type ProviderSymbolValues = Readonly<
  Partial<Record<ProviderSymbolSource['field'], Value>>
>;

export function providerBuiltinValue(
  source: ProviderBuiltinSource,
  syminfo: ProviderSymbolValues,
  timeframePeriod: string,
): Value | undefined {
  if (source.domain === 'syminfo') {
    const value = syminfo[source.field];
    if (value !== undefined) {
      return value;
    }
    return source.field === 'mintick' || source.field === 'pointvalue'
      ? NaN
      : null;
  }
  if (source.field === 'period') {
    return timeframePeriod;
  }
  const parts = timeframeParts(timeframePeriod);
  if (parts === null) {
    return undefined;
  }
  switch (source.field) {
    case 'multiplier':
      return parts.multiplier;
    case 'isseconds':
      return parts.unit === 'seconds';
    case 'isminutes':
      return parts.unit === 'minutes';
    case 'isintraday':
      return parts.unit === 'seconds' || parts.unit === 'minutes';
    case 'isdaily':
      return parts.unit === 'days';
    case 'isweekly':
      return parts.unit === 'weeks';
    case 'ismonthly':
      return parts.unit === 'months';
    case 'isdwm':
      return (
        parts.unit === 'days' ||
        parts.unit === 'weeks' ||
        parts.unit === 'months'
      );
  }
}

function timeframeParts(period: string): {
  readonly multiplier: number;
  readonly unit: 'seconds' | 'minutes' | 'days' | 'weeks' | 'months';
} | null {
  if (/^[1-9]\d*$/.test(period)) {
    const multiplier = Number(period);
    return Number.isSafeInteger(multiplier)
      ? {multiplier, unit: 'minutes'}
      : null;
  }
  const match = /^([1-9]\d*)?([SDWM])$/.exec(period);
  if (match === null) {
    return null;
  }
  const multiplier = match[1] === undefined ? 1 : Number(match[1]);
  if (!Number.isSafeInteger(multiplier)) {
    return null;
  }
  const unit =
    match[2] === 'S'
      ? 'seconds'
      : match[2] === 'D'
        ? 'days'
        : match[2] === 'W'
          ? 'weeks'
          : 'months';
  return {multiplier, unit};
}
