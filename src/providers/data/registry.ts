// Purpose: The source registry — routes context resolution by symbol prefix (the quantmod pattern); construction is host configuration, and API keys live in the drivers, never here or in the runtime.

import type {DataProvider} from '../../runtime/abi';

// "FRED:CPIAUCSL" routes to sources["FRED"] with symbol "CPIAUCSL"; an
// unregistered prefix (an exchange like "NASDAQ:AAPL") and the empty symbol
// go to the default driver with the symbol untouched.
export function registryProvider(options: {
  readonly defaultSource: DataProvider;
  readonly sources: Readonly<Record<string, DataProvider>>;
}): DataProvider {
  return {
    resolveContext(symbol, timeframe, range) {
      const colon = symbol.indexOf(':');
      if (colon > 0) {
        const driver = options.sources[symbol.slice(0, colon)];
        if (driver !== undefined) {
          return driver.resolveContext(
            symbol.slice(colon + 1),
            timeframe,
            range,
          );
        }
      }
      return options.defaultSource.resolveContext(symbol, timeframe, range);
    },
  };
}
