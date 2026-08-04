// Purpose: Yahoo Finance DataProvider — keyless intraday-capable bars from the unofficial v8 chart API (no contractual stability, an accepted tradeoff for a dev tool); this file owns the normalization from chart-API quote arrays to the ambient series set.

import type {
  ContextError,
  DataProvider,
  ProviderContext,
  SeriesData,
  TimeAxis,
} from '../../runtime/abi';

// Pine timeframe -> yahoo interval, paired with the widest range yahoo
// serves at that interval (yahoo caps intraday history: ~7 days of 1m,
// ~60 days of other minute bars, ~730 days of hourly). spanMs is the exact
// bar span for intraday intervals and the nominal LAST-bar span for
// calendar ones (see yahooAxis).
interface IntervalSpec {
  readonly interval: string;
  readonly range: string;
  readonly spanMs: number;
  readonly intraday: boolean;
}

const DAY_MS = 86_400_000;

const TIMEFRAMES: Readonly<Record<string, IntervalSpec>> = {
  '': {interval: '1d', range: 'max', spanMs: DAY_MS, intraday: false},
  D: {interval: '1d', range: 'max', spanMs: DAY_MS, intraday: false},
  W: {interval: '1wk', range: 'max', spanMs: 7 * DAY_MS, intraday: false},
  M: {interval: '1mo', range: 'max', spanMs: 30 * DAY_MS, intraday: false},
  '1': {interval: '1m', range: '7d', spanMs: 60_000, intraday: true},
  '5': {interval: '5m', range: '60d', spanMs: 300_000, intraday: true},
  '15': {interval: '15m', range: '60d', spanMs: 900_000, intraday: true},
  '30': {interval: '30m', range: '60d', spanMs: 1_800_000, intraday: true},
  '60': {interval: '1h', range: '730d', spanMs: 3_600_000, intraday: true},
};

// The quote arrays every chart result carries; destructured in this order.
const QUOTE_FIELDS = ['open', 'high', 'low', 'close', 'volume'] as const;

export function yahooProvider(
  options: {fetchImpl?: typeof fetch} = {},
): DataProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async resolveContext(symbol, timeframe, range) {
      // Range narrowing is a later refinement: the driver fetches the
      // widest extent yahoo serves at the interval and answers over all
      // of it (full-extent slice).
      void range;
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
      return yahooContext(symbol, spec, status, payload);
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
  // Pine exposes `time` as an ambient series: bar OPEN in epoch ms (yahoo
  // timestamps are epoch seconds).
  const timesMs = timestamp.map(t => t * 1000);
  byId.set('time', columnSeries(timesMs));
  // Derived ambient series every host is expected to synthesize (csv.ts
  // convention); na inputs propagate as NaN.
  const derive = (id: string, at: (index: number) => number): void => {
    byId.set(id, {length: rows, at});
  };
  derive('hl2', i => (high[i] + low[i]) / 2);
  derive('hlc3', i => (high[i] + low[i] + close[i]) / 3);
  derive('ohlc4', i => (open[i] + high[i] + low[i] + close[i]) / 4);
  derive('hlcc4', i => (high[i] + low[i] + close[i] + close[i]) / 4);

  return {
    rows,
    axis: yahooAxis(timesMs, spec),
    series: (id: string) => byId.get(id) ?? null,
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
