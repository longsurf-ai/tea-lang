// Purpose: Registry routing tests — prefix dispatch, prefix stripping, and default-driver fallthrough for unregistered prefixes and empty symbols.

import {describe, expect, test} from 'vitest';
import type {DataProvider, ProviderContext} from '../../runtime/abi';
import {registryProvider} from './registry';

function recordingDriver(log: string[], tag: string): DataProvider {
  const context: ProviderContext = {
    rows: 0,
    axis: null,
    series: () => null,
    builtinValue: () => undefined,
  };
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
    const context = await registry.resolveContext('FRED:CPIAUCSL', 'M', {
      kind: 'full',
    });
    expect(log).toEqual(['fred:CPIAUCSL:M']);
    if ('error' in context) {
      throw new Error(`expected context, got ${context.error}`);
    }
    expect(context.builtinValue({domain: 'syminfo', field: 'tickerid'})).toBe(
      'FRED:CPIAUCSL',
    );
    expect(context.builtinValue({domain: 'syminfo', field: 'ticker'})).toBe(
      'CPIAUCSL',
    );
    expect(context.builtinValue({domain: 'syminfo', field: 'prefix'})).toBe(
      'FRED',
    );
  });

  test('unregistered prefixes fall through untouched (exchange symbols)', async () => {
    const log: string[] = [];
    const registry = registryProvider({
      defaultSource: recordingDriver(log, 'default'),
      sources: {FRED: recordingDriver(log, 'fred')},
    });
    await registry.resolveContext('NASDAQ:AAPL', 'D', {kind: 'full'});
    expect(log).toEqual(['default:NASDAQ:AAPL:D']);
  });

  test('the empty symbol names the default context', async () => {
    const log: string[] = [];
    const registry = registryProvider({
      defaultSource: recordingDriver(log, 'default'),
      sources: {},
    });
    await registry.resolveContext('', '', {kind: 'full'});
    expect(log).toEqual(['default::']);
  });
});
