// Purpose: The source registry — routes context resolution by symbol prefix (the quantmod pattern); construction is host configuration, and API keys live in the drivers, never here or in the runtime.

import {
  isContextError,
  type DataProvider,
  type ProviderContext,
} from '../../runtime/abi';

// "FRED:CPIAUCSL" routes to sources["FRED"] with symbol "CPIAUCSL"; an
// unregistered prefix (an exchange like "NASDAQ:AAPL") and the empty symbol
// go to the default driver with the symbol untouched.
export function registryProvider(options: {
  readonly defaultSource: DataProvider;
  readonly sources: Readonly<Record<string, DataProvider>>;
}): DataProvider {
  return {
    async resolveContext(symbol, timeframe, range) {
      const colon = symbol.indexOf(':');
      if (colon > 0) {
        const driver = options.sources[symbol.slice(0, colon)];
        if (driver !== undefined) {
          const context = await driver.resolveContext(
            symbol.slice(colon + 1),
            timeframe,
            range,
          );
          return isContextError(context)
            ? context
            : preserveRequestedIdentity(context, symbol);
        }
      }
      const context = await options.defaultSource.resolveContext(
        symbol,
        timeframe,
        range,
      );
      return isContextError(context)
        ? context
        : preserveRequestedIdentity(context, symbol);
    },
  };
}

function preserveRequestedIdentity(
  context: ProviderContext,
  symbol: string,
): ProviderContext {
  if (symbol === '') {
    return context;
  }
  const colon = symbol.indexOf(':');
  const prefix = colon > 0 ? symbol.slice(0, colon) : undefined;
  const ticker = colon > 0 ? symbol.slice(colon + 1) : symbol;
  return {
    rows: context.rows,
    axis: context.axis,
    series: id => context.series(id),
    builtinValue(source) {
      if (source.domain !== 'syminfo') {
        return context.builtinValue(source);
      }
      switch (source.field) {
        case 'tickerid':
          return symbol;
        case 'ticker':
          return ticker;
        case 'prefix':
          return prefix ?? context.builtinValue(source);
        default:
          return context.builtinValue(source);
      }
    },
  };
}
