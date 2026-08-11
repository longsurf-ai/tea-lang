// Purpose: Built-in registry routing tests — '' reaches the host primary, unprefixed symbols default to yahoo, prefixes reach their drivers, FRED without a key is a typed configuration error.

import {describe, expect, test} from 'bun:test';
import type {
  DataProvider,
  ProviderContext,
  RangeDemand,
} from '../../runtime/abi';
import {isContextError} from '../../runtime/abi';
import {builtinSources} from './builtin-sources';

const FULL_RANGE: RangeDemand = {kind: 'full'};

function primaryDouble(log: string[]): DataProvider {
  const context: ProviderContext = {
    rows: 0,
    axis: null,
    series: () => null,
    builtinValue: () => undefined,
  };
  return {
    resolveContext(symbol) {
      log.push(`primary:${symbol}`);
      return Promise.resolve(context);
    },
  };
}

// Drivers reject anything they fetch; the URLs tell us who was routed to.
function urlRecorder(urls: string[]): typeof fetch {
  const impl = (input: unknown): Promise<Response> => {
    urls.push(String(input));
    return Promise.reject(new Error('offline test'));
  };
  return impl as typeof fetch;
}

describe('builtinSources', () => {
  test('the empty symbol reaches the host primary, nothing is fetched', async () => {
    const log: string[] = [];
    const urls: string[] = [];
    const sources = builtinSources({
      primary: primaryDouble(log),
      fetchImpl: urlRecorder(urls),
    });
    await sources.resolveContext('', '', FULL_RANGE);
    expect(log).toEqual(['primary:']);
    expect(urls).toEqual([]);
  });

  test('unprefixed symbols default to yahoo; prefixes reach their drivers', async () => {
    const urls: string[] = [];
    const sources = builtinSources({
      primary: primaryDouble([]),
      config: {FRED_API_KEY: 'k'},
      fetchImpl: urlRecorder(urls),
    });
    await sources.resolveContext('AAPL', 'D', FULL_RANGE);
    await sources.resolveContext('FRED:GDP', '', FULL_RANGE);
    expect(urls[0]).toContain('finance.yahoo.com');
    expect(urls[1]).toContain('api.stlouisfed.org');
  });

  test('FRED without a key is a typed configuration error, no fetch', async () => {
    const urls: string[] = [];
    const sources = builtinSources({
      primary: primaryDouble([]),
      fetchImpl: urlRecorder(urls),
    });
    const result = await sources.resolveContext('FRED:GDP', '', FULL_RANGE);
    expect(isContextError(result) && result.error).toBe('unknownSource');
    expect(urls).toEqual([]);
  });
});
