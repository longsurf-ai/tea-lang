// Purpose: Host data-provider seam for fixed historical Program contexts.

import type {ExecutionSource} from '../ir/builtin';
import type {Value} from './value';

export interface SeriesData {
  readonly length: number;
  at(index: number): number;
}

export interface TimeAxis {
  time(row: number): number;
  closeTime(row: number): number;
}

export interface ProviderContext {
  readonly rows: number;
  readonly axis: TimeAxis | null;
  series(id: string): SeriesData | null;
  builtinValue(
    source: Extract<
      ExecutionSource,
      {readonly domain: 'syminfo' | 'timeframe'}
    >,
  ): Value | undefined;
}

export interface ContextError {
  readonly error:
    | 'unknownSource'
    | 'unknownSymbol'
    | 'unsupportedTimeframe'
    | 'fetchFailed';
  readonly detail: string;
}

export function isContextError(
  x: ProviderContext | ContextError,
): x is ContextError {
  return 'error' in x;
}

export type RangeDemand =
  | {readonly kind: 'full'}
  | {readonly kind: 'trailing-bars'; readonly bars: number};

export interface DataProvider {
  resolveContext(
    symbol: string,
    timeframe: string,
    range: RangeDemand,
  ): Promise<ProviderContext | ContextError>;
}
