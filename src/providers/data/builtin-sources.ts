// Purpose: The built-in source registry — the package's standard wiring of its own drivers: a host-supplied primary context at '', yahoo for other unprefixed symbols, prefix routes to every built-in driver.

import type {DataProvider} from '../../runtime/abi';
import {fredProvider} from './fred';
import {registryProvider} from './registry';
import {yahooProvider} from './yahoo';

// The quantmod parallel: drivers AND the default-source policy live in the
// package (getSymbols' src dispatch + setDefaults), and so do the drivers'
// configuration conventions (which keys exist, what they are named) — the
// way getSymbols.av owns its av.key convention. Hosts hand in only a
// primary context ('' — a csv file, a chart) and an opaque configuration
// surface; they never know which driver needs what. Unlike quantmod there
// is no global mutable state: every call builds an independent provider.
export function builtinSources(options: {
  readonly primary: DataProvider;
  // Key/value configuration the drivers' settings are extracted from
  // ('FRED_API_KEY'). The CLI hands in process.env; other hosts hand in
  // their own stores under the same key names.
  readonly config?: Readonly<Record<string, string | undefined>>;
  // Injected into every driver so tests stay offline.
  readonly fetchImpl?: typeof fetch;
}): DataProvider {
  const fetchImpl = options.fetchImpl;
  const yahoo = yahooProvider({fetchImpl});
  const fredKey = options.config?.['FRED_API_KEY'] ?? '';
  const fred: DataProvider =
    fredKey === ''
      ? {
          resolveContext: () =>
            Promise.resolve({
              error: 'unknownSource' as const,
              detail: "FRED: symbols need FRED_API_KEY in the host's config",
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
      FRED: fred,
    },
  });
}
