// Purpose: Yahoo Finance DataProvider — keyless intraday-capable bars from the unofficial v8 chart API; owns numeric series, exact time axis, and typed builtin metadata normalization.

import type {
  ContextError,
  DataProvider,
  ProviderContext,
  SeriesData,
  TimeAxis,
} from '../../runtime/abi';
import {
  providerBuiltinValue,
  type ProviderSymbolValues,
} from './builtin-values';
import {projectProviderRange} from './range';

// Pine timeframe -> yahoo interval, paired with the widest range yahoo
// serves at that interval (yahoo caps intraday history: ~7 days of 1m,
// ~60 days of other minute bars, ~730 days of hourly). spanMs is the exact
// bar span for intraday intervals and the nominal LAST-bar span for
// calendar ones (see yahooAxis).
interface IntervalSpec {
  readonly period: string;
  readonly interval: string;
  readonly range: string;
  readonly spanMs: number;
  readonly intraday: boolean;
}

const DAY_MS = 86_400_000;

const TIMEFRAMES: Readonly<Record<string, IntervalSpec>> = {
  // NOT range=max: yahoo silently downgrades granularity for it (probed
  // 2026-08-04: max&1d and even max&1wk both answer MONTHLY bars). 10y is
  // the widest span yahoo serves honestly at these intervals; the
  // granularity guard below refuses the downgrade if yahoo changes again.
  // RangeDemand-driven period1/period2 windows are the later refinement.
  '': {
    period: 'D',
    interval: '1d',
    range: '10y',
    spanMs: DAY_MS,
    intraday: false,
  },
  D: {
    period: 'D',
    interval: '1d',
    range: '10y',
    spanMs: DAY_MS,
    intraday: false,
  },
  W: {
    period: 'W',
    interval: '1wk',
    range: '10y',
    spanMs: 7 * DAY_MS,
    intraday: false,
  },
  M: {
    period: 'M',
    interval: '1mo',
    range: '10y',
    spanMs: 30 * DAY_MS,
    intraday: false,
  },
  '1': {
    period: '1',
    interval: '1m',
    range: '7d',
    spanMs: 60_000,
    intraday: true,
  },
  '5': {
    period: '5',
    interval: '5m',
    range: '60d',
    spanMs: 300_000,
    intraday: true,
  },
  '15': {
    period: '15',
    interval: '15m',
    range: '60d',
    spanMs: 900_000,
    intraday: true,
  },
  '30': {
    period: '30',
    interval: '30m',
    range: '60d',
    spanMs: 1_800_000,
    intraday: true,
  },
  '60': {
    period: '60',
    interval: '1h',
    range: '730d',
    spanMs: 3_600_000,
    intraday: true,
  },
};

// The quote arrays every chart result carries; destructured in this order.
const QUOTE_FIELDS = ['open', 'high', 'low', 'close', 'volume'] as const;

export function yahooProvider(
  options: {fetchImpl?: typeof fetch} = {},
): DataProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async resolveContext(symbol, timeframe, range) {
      // The driver currently fetches the widest extent Yahoo serves at the
      // interval, then projects the exact demanded tail before returning.
      // Narrower network windows are a later optimization.
      if (symbol === '') {
        return {
          error: 'unknownSymbol' as const,
          detail: 'yahoo needs a ticker symbol',
        };
      }
      const spec = TIMEFRAMES[timeframe];
      if (spec === undefined) {
        return {
          error: 'unsupportedTimeframe' as const,
          detail: `yahoo serves no interval for timeframe '${timeframe}'`,
        };
      }
      const url =
        'https://query1.finance.yahoo.com/v8/finance/chart/' +
        encodeURIComponent(symbol) +
        `?interval=${spec.interval}&range=${spec.range}`;
      // The one legal catch: network and JSON-decode failures at the fetch
      // boundary map to fetchFailed. The shape checks below never throw.
      let status: number;
      let payload: unknown;
      try {
        const response = await fetchImpl(url);
        status = response.status;
        payload = await response.json();
      } catch (cause) {
        return {
          error: 'fetchFailed' as const,
          detail: `yahoo fetch failed for ${url}: ${String(cause)}`,
        };
      }
      const context = yahooContext(symbol, spec, status, payload);
      return 'error' in context
        ? context
        : projectProviderRange(context, range);
    },
  };
}

function yahooContext(
  symbol: string,
  spec: IntervalSpec,
  status: number,
  payload: unknown,
): ProviderContext | ContextError {
  if (!isRecord(payload)) {
    return malformed(symbol, 'response is not an object');
  }
  const chart = payload.chart;
  if (!isRecord(chart)) {
    return malformed(symbol, 'chart is not an object');
  }
  // Yahoo reports an unknown ticker as chart.error inside a 404 body; the
  // error description is the useful detail, so check it before the status.
  const chartError = chart.error;
  if (chartError !== null && chartError !== undefined) {
    const description = isRecord(chartError) ? chartError.description : null;
    return {
      error: 'unknownSymbol' as const,
      detail:
        typeof description === 'string'
          ? description
          : `yahoo rejected symbol '${symbol}'`,
    };
  }
  if (status === 404) {
    return {
      error: 'unknownSymbol' as const,
      detail: `yahoo has no symbol '${symbol}' (HTTP 404)`,
    };
  }
  if (status !== 200) {
    return {
      error: 'fetchFailed' as const,
      detail: `yahoo answered HTTP ${status} for '${symbol}'`,
    };
  }
  const result = chart.result;
  if (result === null) {
    return {
      error: 'unknownSymbol' as const,
      detail: `yahoo returned no chart result for '${symbol}'`,
    };
  }
  if (!isUnknownArray(result)) {
    return malformed(symbol, 'chart.result is neither an array nor null');
  }
  if (result.length === 0) {
    return {
      error: 'unknownSymbol' as const,
      detail: `yahoo returned an empty chart result for '${symbol}'`,
    };
  }
  const first = result[0];
  if (!isRecord(first)) {
    return malformed(symbol, 'chart.result[0] is not an object');
  }
  // Honest axes: yahoo silently serves a COARSER granularity when the
  // requested range exceeds what the interval supports. A mislabeled axis
  // corrupts merges, so a granularity mismatch is refused outright.
  const meta = first.meta;
  const granularity = isRecord(meta) ? meta.dataGranularity : null;
  if (typeof granularity === 'string' && granularity !== spec.interval) {
    return {
      error: 'fetchFailed' as const,
      detail:
        `yahoo answered '${granularity}' bars for a '${spec.interval}' ` +
        `request on '${symbol}' — refusing the mislabeled axis`,
    };
  }
  const timestamp = secondsColumn(first.timestamp);
  if (timestamp === null) {
    return malformed(symbol, 'result[0].timestamp is not an array of numbers');
  }
  const indicators = first.indicators;
  if (!isRecord(indicators)) {
    return malformed(symbol, 'result[0].indicators is not an object');
  }
  const quotes = indicators.quote;
  if (!isUnknownArray(quotes)) {
    return malformed(symbol, 'indicators.quote is not an array');
  }
  const quote = quotes[0];
  if (!isRecord(quote)) {
    return malformed(symbol, 'indicators.quote[0] is not an object');
  }

  const rows = timestamp.length;
  const columns: (readonly number[])[] = [];
  for (const field of QUOTE_FIELDS) {
    const column = numericColumn(quote[field], rows);
    if (column === null) {
      return malformed(
        symbol,
        `indicators.quote[0].${field} is not a length-${rows} array of numbers and nulls`,
      );
    }
    columns.push(column);
  }
  // QUOTE_FIELDS order.
  const [open, high, low, close] = columns;

  const byId = new Map<string, SeriesData>();
  QUOTE_FIELDS.forEach((field, i) => {
    byId.set(field, columnSeries(columns[i]));
  });
  // Yahoo timestamps are epoch seconds; the execution axis owns their
  // epoch-ms projection. There is deliberately no duplicate `series('time')`.
  const timesMs = timestamp.map(t => t * 1000);
  // Derived numeric data series every host is expected to synthesize (csv.ts
  // convention); na inputs propagate as NaN.
  const derive = (id: string, at: (index: number) => number): void => {
    byId.set(id, {length: rows, at});
  };
  derive('hl2', i => (high[i] + low[i]) / 2);
  derive('hlc3', i => (high[i] + low[i] + close[i]) / 3);
  derive('ohlc4', i => (open[i] + high[i] + low[i] + close[i]) / 4);
  derive('hlcc4', i => (high[i] + low[i] + close[i] + close[i]) / 4);

  const syminfo: ProviderSymbolValues = {
    tickerid: symbol,
    ticker: symbol.includes(':')
      ? symbol.slice(symbol.lastIndexOf(':') + 1)
      : symbol,
    prefix:
      isRecord(meta) && typeof meta.exchangeName === 'string'
        ? meta.exchangeName
        : undefined,
    currency:
      isRecord(meta) && typeof meta.currency === 'string'
        ? meta.currency
        : undefined,
    type:
      isRecord(meta) && typeof meta.instrumentType === 'string'
        ? meta.instrumentType.toLowerCase()
        : undefined,
    timezone:
      isRecord(meta) && typeof meta.exchangeTimezoneName === 'string'
        ? meta.exchangeTimezoneName
        : undefined,
  };

  return {
    rows,
    axis: yahooAxis(timesMs, spec),
    series: (id: string) => byId.get(id) ?? null,
    builtinValue: source => providerBuiltinValue(source, syminfo, spec.period),
  };
}

// Unexpected shapes are typed fetchFailed errors naming the deviation —
// never silent defaults, never a zero fill.
function malformed(symbol: string, what: string): ContextError {
  return {
    error: 'fetchFailed',
    detail: `yahoo response for '${symbol}' has unexpected shape: ${what}`,
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

// Array.isArray narrows unknown to any[]; this predicate keeps elements
// unknown so every cell is checked before use.
function isUnknownArray(x: unknown): x is readonly unknown[] {
  return Array.isArray(x);
}

// Bar OPEN times in epoch seconds; a non-number entry is a shape error,
// never a guessed time.
function secondsColumn(x: unknown): readonly number[] | null {
  if (!isUnknownArray(x)) {
    return null;
  }
  const column: number[] = [];
  for (const cell of x) {
    if (typeof cell !== 'number') {
      return null;
    }
    column.push(cell);
  }
  return column;
}

// One quote column with null as na (NaN). Yahoo emits rows whose quote
// values are all null (halts, sparse sessions); they are KEPT as na rows —
// dropping them would misalign every column against the timestamp axis.
function numericColumn(x: unknown, rows: number): readonly number[] | null {
  if (!isUnknownArray(x) || x.length !== rows) {
    return null;
  }
  const column: number[] = [];
  for (const cell of x) {
    if (cell === null) {
      column.push(NaN);
      continue;
    }
    if (typeof cell !== 'number') {
      return null;
    }
    column.push(cell);
  }
  return column;
}

function columnSeries(values: readonly number[]): SeriesData {
  return {length: values.length, at: (index: number) => values[index]};
}

// Intraday bars have exact spans: a bar closes exactly spanMs after it
// opens. Calendar bars (1d/1wk/1mo) follow the csv convention — a bar
// closes when the next opens, and the LAST bar spans a nominal interval
// (1d = 24h, 1wk = 7d, 1mo = 30d). Deviation ledger: TradingView closes a
// daily bar at the session end (16:00 ET for US equities), not 24h after
// the open; honest session closes need a calendar the chart payload does
// not carry.
function yahooAxis(timesMs: readonly number[], spec: IntervalSpec): TimeAxis {
  const rows = timesMs.length;
  if (spec.intraday) {
    return {
      time: row => timesMs[row],
      closeTime: row => timesMs[row] + spec.spanMs,
    };
  }
  return {
    time: row => timesMs[row],
    closeTime: row =>
      row + 1 < rows ? timesMs[row + 1] : timesMs[row] + spec.spanMs,
  };
}
