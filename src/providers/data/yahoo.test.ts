// Purpose: Yahoo driver tests — offline via an injected fake fetch; pin URL construction, quote-array normalization, axis conventions, and the typed error taxonomy.

import {describe, expect, test} from 'bun:test';
import type {
  ContextError,
  ProviderContext,
  RangeDemand,
  SeriesData,
} from '../../runtime/abi';
import {isContextError} from '../../runtime/abi';
import {yahooProvider} from './yahoo';

const FULL_RANGE: RangeDemand = {from: null, to: null, bars: null};

const DAY_S = 86_400;

interface QuoteArrays {
  readonly open: readonly (number | null)[];
  readonly high: readonly (number | null)[];
  readonly low: readonly (number | null)[];
  readonly close: readonly (number | null)[];
  readonly volume: readonly (number | null)[];
}

// The chart-API happy shape: one result carrying bar-open timestamps in
// epoch SECONDS plus rows-aligned quote arrays.
function chartPayload(
  timestamp: readonly number[],
  quote: QuoteArrays,
): unknown {
  return {
    chart: {
      result: [{timestamp, indicators: {quote: [quote]}}],
      error: null,
    },
  };
}

const DAILY = chartPayload([DAY_S, 2 * DAY_S, 3 * DAY_S], {
  open: [10, 11, 12],
  high: [15, 16, 17],
  low: [5, 6, 7],
  close: [12, 13, 14],
  volume: [100, 200, 300],
});

// A fake fetch that records requested URLs and answers a canned payload;
// the tests never touch the network (bun test must pass offline).
function fetchStub(
  payload: unknown,
  status = 200,
): {calls: string[]; fetchImpl: typeof fetch} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), {status});
  }) as typeof fetch;
  return {calls, fetchImpl};
}

function expectContext(
  result: ProviderContext | ContextError,
): ProviderContext {
  if (isContextError(result)) {
    throw new Error(
      `expected a context, got ${result.error}: ${result.detail}`,
    );
  }
  return result;
}

function expectError(result: ProviderContext | ContextError): ContextError {
  if (!isContextError(result)) {
    throw new Error('expected a ContextError, got a context');
  }
  return result;
}

function series(context: ProviderContext, id: string): SeriesData {
  const data = context.series(id);
  if (data === null) {
    throw new Error(`expected series '${id}'`);
  }
  return data;
}

function values(data: SeriesData): number[] {
  return Array.from({length: data.length}, (_, i) => data.at(i));
}

describe('yahooProvider', () => {
  test('serves daily bars with epoch-ms opens and next-open closes', async () => {
    const {calls, fetchImpl} = fetchStub(DAILY);
    const provider = yahooProvider({fetchImpl});
    const context = expectContext(
      await provider.resolveContext('AAPL', 'D', FULL_RANGE),
    );
    expect(calls).toEqual([
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=max',
    ]);
    expect(context.rows).toBe(3);
    expect(values(series(context, 'open'))).toEqual([10, 11, 12]);
    expect(values(series(context, 'close'))).toEqual([12, 13, 14]);
    expect(values(series(context, 'volume'))).toEqual([100, 200, 300]);
    // `time` serves bar opens in epoch ms (yahoo timestamps are seconds).
    expect(values(series(context, 'time'))).toEqual([
      86_400_000, 172_800_000, 259_200_000,
    ]);
    const axis = context.axis;
    if (axis === null) {
      throw new Error('expected an axis');
    }
    expect([axis.time(0), axis.time(1), axis.time(2)]).toEqual([
      86_400_000, 172_800_000, 259_200_000,
    ]);
    // A bar closes when the next opens; the last spans a nominal day.
    expect(axis.closeTime(0)).toBe(172_800_000);
    expect(axis.closeTime(1)).toBe(259_200_000);
    expect(axis.closeTime(2)).toBe(259_200_000 + 86_400_000);
  });

  test("timeframe 'W' requests interval=1wk over yahoo's max range", async () => {
    const {calls, fetchImpl} = fetchStub(DAILY);
    const provider = yahooProvider({fetchImpl});
    await provider.resolveContext('MSFT', 'W', FULL_RANGE);
    expect(calls).toEqual([
      'https://query1.finance.yahoo.com/v8/finance/chart/MSFT?interval=1wk&range=max',
    ]);
  });

  test('an unmapped timeframe is unsupportedTimeframe without fetching', async () => {
    const {calls, fetchImpl} = fetchStub(DAILY);
    const provider = yahooProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('AAPL', '240', FULL_RANGE),
    );
    expect(error.error).toBe('unsupportedTimeframe');
    expect(calls).toEqual([]);
  });

  test('the empty symbol is unknownSymbol without fetching', async () => {
    const {calls, fetchImpl} = fetchStub(DAILY);
    const provider = yahooProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('', '', FULL_RANGE),
    );
    expect(error.error).toBe('unknownSymbol');
    expect(error.detail).toBe('yahoo needs a ticker symbol');
    expect(calls).toEqual([]);
  });

  test('chart.error is unknownSymbol carrying the description', async () => {
    const payload = {
      chart: {
        result: null,
        error: {
          code: 'Not Found',
          description: 'No data found, symbol may be delisted',
        },
      },
    };
    const {fetchImpl} = fetchStub(payload, 404);
    const provider = yahooProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('NOSUCH', 'D', FULL_RANGE),
    );
    expect(error.error).toBe('unknownSymbol');
    expect(error.detail).toBe('No data found, symbol may be delisted');
  });

  test('a rejected fetch is fetchFailed', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const provider = yahooProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('AAPL', 'D', FULL_RANGE),
    );
    expect(error.error).toBe('fetchFailed');
    expect(error.detail).toContain('network down');
  });

  test('null quote entries are kept in place as na rows', async () => {
    // Yahoo emits rows whose quote values are all null; they must keep
    // their slot so columns stay aligned with the timestamp axis.
    const payload = chartPayload([DAY_S, 2 * DAY_S, 3 * DAY_S], {
      open: [10, null, 12],
      high: [15, null, 17],
      low: [5, null, 7],
      close: [12, null, 14],
      volume: [100, null, 300],
    });
    const {fetchImpl} = fetchStub(payload);
    const provider = yahooProvider({fetchImpl});
    const context = expectContext(
      await provider.resolveContext('AAPL', 'D', FULL_RANGE),
    );
    expect(context.rows).toBe(3);
    expect(series(context, 'close').at(1)).toBeNaN();
    expect(series(context, 'volume').at(1)).toBeNaN();
    expect(series(context, 'close').at(2)).toBe(14);
    const axis = context.axis;
    if (axis === null) {
      throw new Error('expected an axis');
    }
    expect(axis.time(1)).toBe(172_800_000);
  });

  test('derives hl2 and friends from the normalized columns', async () => {
    const {fetchImpl} = fetchStub(DAILY);
    const provider = yahooProvider({fetchImpl});
    const context = expectContext(
      await provider.resolveContext('AAPL', 'D', FULL_RANGE),
    );
    expect(values(series(context, 'hl2'))).toEqual([10, 11, 12]);
    expect(values(series(context, 'hlc3'))).toEqual([
      (15 + 5 + 12) / 3,
      (16 + 6 + 13) / 3,
      (17 + 7 + 14) / 3,
    ]);
    expect(values(series(context, 'ohlc4'))).toEqual([
      (10 + 15 + 5 + 12) / 4,
      (11 + 16 + 6 + 13) / 4,
      (12 + 17 + 7 + 14) / 4,
    ]);
    expect(values(series(context, 'hlcc4'))).toEqual([
      (15 + 5 + 12 + 12) / 4,
      (16 + 6 + 13 + 13) / 4,
      (17 + 7 + 14 + 14) / 4,
    ]);
  });

  test('intraday bars close exactly one interval after they open', async () => {
    const hourly = chartPayload([3_600, 7_200, 10_800], {
      open: [10, 11, 12],
      high: [15, 16, 17],
      low: [5, 6, 7],
      close: [12, 13, 14],
      volume: [100, 200, 300],
    });
    const {calls, fetchImpl} = fetchStub(hourly);
    const provider = yahooProvider({fetchImpl});
    const context = expectContext(
      await provider.resolveContext('AAPL', '60', FULL_RANGE),
    );
    expect(calls).toEqual([
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1h&range=730d',
    ]);
    const axis = context.axis;
    if (axis === null) {
      throw new Error('expected an axis');
    }
    expect(axis.closeTime(0)).toBe(3_600_000 + 3_600_000);
    // The last intraday bar also spans exactly its interval.
    expect(axis.closeTime(2)).toBe(10_800_000 + 3_600_000);
  });

  test('a shape deviation is fetchFailed naming the field', async () => {
    const payload = chartPayload([DAY_S, 2 * DAY_S], {
      open: [10], // wrong length: not rows-aligned
      high: [15, 16],
      low: [5, 6],
      close: [12, 13],
      volume: [100, 200],
    });
    const {fetchImpl} = fetchStub(payload);
    const provider = yahooProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('AAPL', 'D', FULL_RANGE),
    );
    expect(error.error).toBe('fetchFailed');
    expect(error.detail).toContain('open');
  });
});
