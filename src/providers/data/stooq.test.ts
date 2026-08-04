// Purpose: Stooq driver tests — offline via an injected fake fetch; pin URL construction, CSV normalization, axis conventions, and the typed error taxonomy.

import {describe, expect, test} from 'bun:test';
import type {
  ContextError,
  ProviderContext,
  RangeDemand,
  SeriesData,
} from '../../runtime/abi';
import {isContextError} from '../../runtime/abi';
import {stooqProvider} from './stooq';

const FULL_RANGE: RangeDemand = {from: null, to: null, bars: null};

const DAILY_CSV = [
  'Date,Open,High,Low,Close,Volume',
  '2024-01-02,100,110,90,105,1000',
  '2024-01-03,105,115,95,112,1500',
  '2024-01-04,112,120,100,118,2000',
].join('\n');

// A fake fetch that records requested URLs and answers a canned body; the
// tests never touch the network (bun test must pass offline).
function fetchStub(
  body: string,
  status = 200,
): {calls: string[]; fetchImpl: typeof fetch} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body, {status});
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

describe('stooqProvider', () => {
  test('serves daily rows with UTC-midnight opens and next-open closes', async () => {
    const {fetchImpl} = fetchStub(DAILY_CSV);
    const provider = stooqProvider({fetchImpl});
    const context = expectContext(
      await provider.resolveContext('aapl.us', 'D', FULL_RANGE),
    );
    expect(context.rows).toBe(3);
    expect(values(series(context, 'close'))).toEqual([105, 112, 118]);
    expect(values(series(context, 'volume'))).toEqual([1000, 1500, 2000]);
    const t0 = Date.UTC(2024, 0, 2);
    const t1 = Date.UTC(2024, 0, 3);
    const t2 = Date.UTC(2024, 0, 4);
    expect(values(series(context, 'time'))).toEqual([t0, t1, t2]);
    const axis = context.axis;
    if (axis === null) {
      throw new Error('expected an axis');
    }
    expect([axis.time(0), axis.time(1), axis.time(2)]).toEqual([t0, t1, t2]);
    // A bar closes when the next opens; the last spans a nominal day.
    expect(axis.closeTime(0)).toBe(t1);
    expect(axis.closeTime(1)).toBe(t2);
    expect(axis.closeTime(2)).toBe(t2 + 86_400_000);
  });

  test('requests the lowercased symbol with the mapped interval', async () => {
    const {calls, fetchImpl} = fetchStub(DAILY_CSV);
    const provider = stooqProvider({fetchImpl});
    await provider.resolveContext('AAPL.US', '', FULL_RANGE);
    await provider.resolveContext('AAPL.US', 'W', FULL_RANGE);
    await provider.resolveContext('spy.us', 'M', FULL_RANGE);
    expect(calls).toEqual([
      'https://stooq.com/q/d/l/?s=aapl.us&i=d',
      'https://stooq.com/q/d/l/?s=aapl.us&i=w',
      'https://stooq.com/q/d/l/?s=spy.us&i=m',
    ]);
  });

  test('the last weekly bar spans a nominal seven days', async () => {
    const weekly = [
      'Date,Open,High,Low,Close,Volume',
      '2024-01-01,100,110,90,105,1000',
      '2024-01-08,105,115,95,112,1500',
    ].join('\n');
    const {fetchImpl} = fetchStub(weekly);
    const provider = stooqProvider({fetchImpl});
    const context = expectContext(
      await provider.resolveContext('aapl.us', 'W', FULL_RANGE),
    );
    const axis = context.axis;
    if (axis === null) {
      throw new Error('expected an axis');
    }
    expect(axis.closeTime(1)).toBe(Date.UTC(2024, 0, 8) + 7 * 86_400_000);
  });

  test('an intraday timeframe is unsupportedTimeframe without fetching', async () => {
    const {calls, fetchImpl} = fetchStub(DAILY_CSV);
    const provider = stooqProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('aapl.us', '5', FULL_RANGE),
    );
    expect(error.error).toBe('unsupportedTimeframe');
    expect(calls).toEqual([]);
  });

  test('the empty symbol is unknownSymbol without fetching', async () => {
    const {calls, fetchImpl} = fetchStub(DAILY_CSV);
    const provider = stooqProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('', '', FULL_RANGE),
    );
    expect(error.error).toBe('unknownSymbol');
    expect(calls).toEqual([]);
  });

  test('a `No data` body is unknownSymbol', async () => {
    const {fetchImpl} = fetchStub('No data');
    const provider = stooqProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('nosuch.us', '', FULL_RANGE),
    );
    expect(error.error).toBe('unknownSymbol');
    expect(error.detail).toContain('nosuch.us');
  });

  test('a headers-only CSV is unknownSymbol', async () => {
    const {fetchImpl} = fetchStub('Date,Open,High,Low,Close,Volume\n');
    const provider = stooqProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('nosuch.us', '', FULL_RANGE),
    );
    expect(error.error).toBe('unknownSymbol');
  });

  test('a non-2xx answer is fetchFailed', async () => {
    const {fetchImpl} = fetchStub('gateway timeout', 504);
    const provider = stooqProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('aapl.us', '', FULL_RANGE),
    );
    expect(error.error).toBe('fetchFailed');
    expect(error.detail).toContain('504');
  });

  test('a rejected fetch is fetchFailed', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const provider = stooqProvider({fetchImpl});
    const error = expectError(
      await provider.resolveContext('aapl.us', '', FULL_RANGE),
    );
    expect(error.error).toBe('fetchFailed');
    expect(error.detail).toContain('network down');
  });

  test('derives hlc3 from the normalized columns', async () => {
    const {fetchImpl} = fetchStub(DAILY_CSV);
    const provider = stooqProvider({fetchImpl});
    const context = expectContext(
      await provider.resolveContext('aapl.us', '', FULL_RANGE),
    );
    expect(values(series(context, 'hlc3'))).toEqual([
      (110 + 90 + 105) / 3,
      (115 + 95 + 112) / 3,
      (120 + 100 + 118) / 3,
    ]);
  });

  test('missing and non-numeric cells are NaN', async () => {
    const ragged = [
      'Date,Open,High,Low,Close,Volume',
      '2024-01-02,abc,110,90,105,',
    ].join('\n');
    const {fetchImpl} = fetchStub(ragged);
    const provider = stooqProvider({fetchImpl});
    const context = expectContext(
      await provider.resolveContext('aapl.us', '', FULL_RANGE),
    );
    expect(series(context, 'open').at(0)).toBeNaN();
    expect(series(context, 'volume').at(0)).toBeNaN();
    expect(series(context, 'close').at(0)).toBe(105);
  });
});
