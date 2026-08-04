// Purpose: Registry routing tests — prefix dispatch, prefix stripping, and default-driver fallthrough for unregistered prefixes and empty symbols.

import {describe, expect, test} from 'bun:test';
import type {DataProvider, ProviderContext} from '../../runtime/abi';
import {registryProvider} from './registry';

function recordingDriver(log: string[], tag: string): DataProvider {
  const context: ProviderContext = {rows: 0, axis: null, series: () => null};
  return {
    resolveContext(symbol, timeframe) {
      log.push(`${tag}:${symbol}:${timeframe}`);
      return Promise.resolve(context);
    },
  };
}

describe('registryProvider', () => {
  test('routes registered prefixes with the prefix stripped', async () => {
    const log: string[] = [];
    const registry = registryProvider({
      defaultSource: recordingDriver(log, 'default'),
      sources: {FRED: recordingDriver(log, 'fred')},
    });
    await registry.resolveContext('FRED:CPIAUCSL', 'M', {
      from: null,
      to: null,
      bars: null,
    });
    expect(log).toEqual(['fred:CPIAUCSL:M']);
  });

  test('unregistered prefixes fall through untouched (exchange symbols)', async () => {
    const log: string[] = [];
    const registry = registryProvider({
      defaultSource: recordingDriver(log, 'default'),
      sources: {FRED: recordingDriver(log, 'fred')},
    });
    await registry.resolveContext('NASDAQ:AAPL', 'D', {
      from: null,
      to: null,
      bars: null,
    });
    expect(log).toEqual(['default:NASDAQ:AAPL:D']);
  });

  test('the empty symbol names the default context', async () => {
    const log: string[] = [];
    const registry = registryProvider({
      defaultSource: recordingDriver(log, 'default'),
      sources: {},
    });
    await registry.resolveContext('', '', {from: null, to: null, bars: null});
    expect(log).toEqual(['default::']);
  });
});
