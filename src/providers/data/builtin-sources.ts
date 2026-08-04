// Purpose: The built-in source registry — the package's standard wiring of its own drivers: a host-supplied primary context at '', yahoo for other unprefixed symbols, prefix routes to every built-in driver.

import type {DataProvider} from '../../runtime/abi';
import {fredProvider} from './fred';
import {registryProvider} from './registry';
import {stooqProvider} from './stooq';
import {yahooProvider} from './yahoo';

// The quantmod parallel: drivers AND the default-source policy live in the
// package (getSymbols' src dispatch + setDefaults); hosts only parameterize
// it — the primary context ('' — a csv file, a chart) and API keys. Unlike
// quantmod there is no global mutable state: every call builds an
// independent provider.
export function builtinSources(options: {
  readonly primary: DataProvider;
  readonly fredApiKey?: string;
  // Injected into every driver so tests stay offline.
  readonly fetchImpl?: typeof fetch;
}): DataProvider {
  const fetchImpl = options.fetchImpl;
  const yahoo = yahooProvider({fetchImpl});
  const fredKey = options.fredApiKey ?? '';
  const fred: DataProvider =
    fredKey === ''
      ? {
          resolveContext: () =>
            Promise.resolve({
              error: 'unknownSource' as const,
              detail: 'a FRED api key is required for FRED: symbols',
            }),
        }
      : fredProvider({apiKey: fredKey, fetchImpl});
  return registryProvider({
    defaultSource: {
      // '' names the host's own context; any other unprefixed symbol is an
      // equity-shaped ticker and defaults to yahoo (docs/requests.md).
      resolveContext: (symbol, timeframe, range) =>
        symbol === ''
          ? options.primary.resolveContext(symbol, timeframe, range)
          : yahoo.resolveContext(symbol, timeframe, range),
    },
    sources: {
      YAHOO: yahoo,
      STOOQ: stooqProvider({fetchImpl}),
      FRED: fred,
    },
  });
}
