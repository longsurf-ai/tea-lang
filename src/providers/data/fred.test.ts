// Purpose: Offline FRED driver tests — a fake fetch dispatches on URL, pinning normalization, the native-frequency timeframe gate, and the typed error mapping without the network.

import {describe, expect, test} from 'bun:test';
import type {
  ContextError,
  ProviderContext,
  RangeDemand,
  SeriesData,
} from '../../runtime/abi';
import {isContextError} from '../../runtime/abi';
import {fredProvider} from './fred';

const FULL_RANGE: RangeDemand = {from: null, to: null, bars: null};

const MONTHLY_META = {seriess: [{id: 'CPIAUCSL', frequency_short: 'M'}]};
const MONTHLY_OBSERVATIONS = {
  observations: [
    {date: '2024-01-01', value: '308.417'},
    {date: '2024-02-01', value: '.'},
    {date: '2024-03-01', value: '312.332'},
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

// A fake fetch dispatching on URL substring; records every URL it receives.
function fakeFetch(handlers: {
  series: () => Response | Promise<Response>;
  observations?: () => Response | Promise<Response>;
}): {fetchImpl: typeof fetch; urls: string[]} {
  const urls: string[] = [];
  const impl = async (input: unknown): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/fred/series/observations?')) {
      if (handlers.observations === undefined) {
        throw new Error(`unexpected observations request: ${url}`);
      }
      return handlers.observations();
    }
    if (url.includes('/fred/series?')) {
      return handlers.series();
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  return {fetchImpl: impl as typeof fetch, urls};
}

function resolved(result: ProviderContext | ContextError): ProviderContext {
  if (isContextError(result)) {
    throw new Error(
      `expected a context, got ${result.error}: ${result.detail}`,
    );
  }
  return result;
}

function failed(result: ProviderContext | ContextError): ContextError {
  if (!isContextError(result)) {
    throw new Error('expected a ContextError, got a context');
  }
  return result;
}

function column(context: ProviderContext, id: string): SeriesData {
  const data = context.series(id);
  if (data === null) {
    throw new Error(`missing series '${id}'`);
  }
  return data;
}

describe('fredProvider', () => {
  test('monthly series normalizes to the ambient set with a period-open axis', async () => {
    const {fetchImpl} = fakeFetch({
      series: () => json(MONTHLY_META),
      observations: () => json(MONTHLY_OBSERVATIONS),
    });
    const provider = fredProvider({apiKey: 'test-key', fetchImpl});
    const context = resolved(
      await provider.resolveContext('CPIAUCSL', '', FULL_RANGE),
    );

    expect(context.rows).toBe(3);
    const close = column(context, 'close');
    expect(close.length).toBe(3);
    expect(close.at(0)).toBe(308.417);
    expect(close.at(1)).toBeNaN(); // '.' = missing observation
    expect(close.at(2)).toBe(312.332);

    // Single-valued collapse: open/high/low serve the close column; the
    // derived ambients therefore equal close too.
    for (const id of ['open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']) {
      const data = column(context, id);
      expect(data.at(0)).toBe(308.417);
      expect(data.at(1)).toBeNaN();
      expect(data.at(2)).toBe(312.332);
    }
    const volume = column(context, 'volume');
    expect(volume.at(0)).toBeNaN();
    expect(volume.at(2)).toBeNaN();

    // Axis: observation dates are period OPENs; a bar closes when the next
    // opens, and the last spans a nominal month.
    const jan = Date.UTC(2024, 0, 1);
    const feb = Date.UTC(2024, 1, 1);
    const mar = Date.UTC(2024, 2, 1);
    const axis = context.axis;
    if (axis === null) {
      throw new Error('expected an axis');
    }
    expect(axis.time(0)).toBe(jan);
    expect(axis.time(1)).toBe(feb);
    expect(axis.time(2)).toBe(mar);
    expect(axis.closeTime(0)).toBe(feb);
    expect(axis.closeTime(1)).toBe(mar);
    expect(axis.closeTime(2)).toBe(mar + 30 * 86_400_000);
    const time = column(context, 'time');
    expect(time.at(0)).toBe(jan);
  });

  test("requesting 'M' on a monthly series passes the timeframe gate", async () => {
    const {fetchImpl} = fakeFetch({
      series: () => json(MONTHLY_META),
      observations: () => json(MONTHLY_OBSERVATIONS),
    });
    const provider = fredProvider({apiKey: 'test-key', fetchImpl});
    const context = resolved(
      await provider.resolveContext('CPIAUCSL', 'M', FULL_RANGE),
    );
    expect(context.rows).toBe(3);
  });

  test("requesting 'D' on a monthly series is unsupportedTimeframe naming the native frequency", async () => {
    const {fetchImpl, urls} = fakeFetch({
      series: () => json(MONTHLY_META),
    });
    const provider = fredProvider({apiKey: 'test-key', fetchImpl});
    const error = failed(
      await provider.resolveContext('CPIAUCSL', 'D', FULL_RANGE),
    );
    expect(error.error).toBe('unsupportedTimeframe');
    expect(error.detail).toContain("'M'");
    expect(error.detail).toContain("'D'");
    // The gate fires off the metadata alone — no observations fetch.
    expect(urls).toHaveLength(1);
  });

  test('HTTP 400 with an error_message maps to unknownSymbol carrying the message', async () => {
    const message = 'Bad Request. The series does not exist.';
    const {fetchImpl} = fakeFetch({
      series: () => json({error_code: 400, error_message: message}, 400),
    });
    const provider = fredProvider({apiKey: 'test-key', fetchImpl});
    const error = failed(
      await provider.resolveContext('NOSUCH', '', FULL_RANGE),
    );
    expect(error.error).toBe('unknownSymbol');
    expect(error.detail).toBe(message);
  });

  test('a rejecting fetch maps to fetchFailed', async () => {
    const {fetchImpl} = fakeFetch({
      series: () => Promise.reject(new Error('connection refused')),
    });
    const provider = fredProvider({apiKey: 'test-key', fetchImpl});
    const error = failed(
      await provider.resolveContext('CPIAUCSL', '', FULL_RANGE),
    );
    expect(error.error).toBe('fetchFailed');
    expect(error.detail).toContain('connection refused');
  });

  test('a malformed response shape maps to fetchFailed', async () => {
    const {fetchImpl} = fakeFetch({
      series: () => json({seriess: 'not-an-array'}),
    });
    const provider = fredProvider({apiKey: 'test-key', fetchImpl});
    const error = failed(
      await provider.resolveContext('CPIAUCSL', '', FULL_RANGE),
    );
    expect(error.error).toBe('fetchFailed');
    expect(error.detail).toContain('malformed');
  });

  test('the empty symbol is unknownSymbol without any fetch', async () => {
    const {fetchImpl, urls} = fakeFetch({
      series: () => json(MONTHLY_META),
    });
    const provider = fredProvider({apiKey: 'test-key', fetchImpl});
    const error = failed(await provider.resolveContext('', '', FULL_RANGE));
    expect(error.error).toBe('unknownSymbol');
    expect(urls).toHaveLength(0);
  });

  test('the api_key and series_id land in both request URLs', async () => {
    const {fetchImpl, urls} = fakeFetch({
      series: () => json(MONTHLY_META),
      observations: () => json(MONTHLY_OBSERVATIONS),
    });
    const provider = fredProvider({apiKey: 'secret-key', fetchImpl});
    resolved(await provider.resolveContext('CPIAUCSL', '', FULL_RANGE));

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('https://api.stlouisfed.org/fred/series?');
    expect(urls[1]).toContain(
      'https://api.stlouisfed.org/fred/series/observations?',
    );
    for (const url of urls) {
      expect(url).toContain('api_key=secret-key');
      expect(url).toContain('series_id=CPIAUCSL');
      expect(url).toContain('file_type=json');
    }
  });
});
