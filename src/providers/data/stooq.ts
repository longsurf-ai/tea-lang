// Purpose: Stooq EOD DataProvider — keyless daily/weekly/monthly bars from stooq.com's CSV endpoint; this file owns the normalization from Stooq's `Date,Open,High,Low,Close,Volume` shape to the ambient series set.

import type {
  ContextError,
  DataProvider,
  ProviderContext,
  SeriesData,
  TimeAxis,
} from '../../runtime/abi';

// Stooq is EOD-only and the driver never resamples: '' means the source's
// native timeframe (daily); anything finer is unsupportedTimeframe.
type StooqInterval = 'd' | 'w' | 'm';
const INTERVALS: Readonly<Record<string, StooqInterval>> = {
  '': 'd',
  D: 'd',
  W: 'w',
  M: 'm',
};

// Nominal last-bar spans. Deviation ledger: every bar closes when the next
// opens, and the LAST bar spans a nominal calendar interval — real session
// closes differ (holidays, short weeks, month lengths), but stooq publishes
// calendar dates, not session calendars.
const NOMINAL_SPAN_MS: Readonly<Record<StooqInterval, number>> = {
  d: 86_400_000,
  w: 7 * 86_400_000,
  m: 30 * 86_400_000,
};

export function stooqProvider(
  options: {fetchImpl?: typeof fetch} = {},
): DataProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async resolveContext(symbol, timeframe, range) {
      // The endpoint serves its full EOD extent in one response; there is
      // nothing to page, so the demand needs no narrowing.
      void range;
      const interval = INTERVALS[timeframe];
      if (interval === undefined) {
        return {
          error: 'unsupportedTimeframe' as const,
          detail: `stooq serves EOD bars only ('' | 'D' | 'W' | 'M'), not '${timeframe}'`,
        };
      }
      if (symbol === '') {
        return {
          error: 'unknownSymbol' as const,
          detail:
            'stooq has no default context; name a symbol with its market suffix (aapl.us)',
        };
      }
      // Stooq symbols carry their market suffix as the user wrote it
      // (aapl.us) and are case-insensitive; lowercase whatever arrives.
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}&i=${interval}`;
      let body: string;
      try {
        const response = await fetchImpl(url);
        if (!response.ok) {
          return {
            error: 'fetchFailed' as const,
            detail: `stooq answered HTTP ${response.status} for ${url}`,
          };
        }
        body = await response.text();
      } catch (cause) {
        return {
          error: 'fetchFailed' as const,
          detail: `stooq fetch failed for ${url}: ${String(cause)}`,
        };
      }
      return stooqContext(body, symbol, interval);
    },
  };
}

// Stooq answers unknown tickers with HTTP 200 and a `No data` body (or an
// empty/headers-only CSV), so the body shape — never the status — is what
// distinguishes unknownSymbol from a served context.
function stooqContext(
  body: string,
  symbol: string,
  interval: StooqInterval,
): ProviderContext | ContextError {
  const lines = body.trim().split(/\r?\n/);
  const dataLines = lines.slice(1).filter(line => line.trim() !== '');
  if (
    /^no data/i.test(lines[0]) ||
    lines[0].trim() === '' ||
    dataLines.length === 0
  ) {
    return {
      error: 'unknownSymbol' as const,
      detail: `stooq has no data for '${symbol}' — check the market suffix (aapl.us, spy.us)`,
    };
  }
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const dateColumn = headers.indexOf('date');
  if (dateColumn < 0) {
    return {
      error: 'fetchFailed' as const,
      detail: `stooq answered an unexpected payload for '${symbol}': '${lines[0]}'`,
    };
  }

  // Column-major parse: the date column becomes epoch-ms bar OPEN times,
  // every other column a numeric series under its lowercased header
  // (open/high/low/close/volume). Missing or invalid cells are NaN.
  const rows = dataLines.length;
  const columns: number[][] = headers.map(() => []);
  for (const line of dataLines) {
    const cells = line.split(',');
    headers.forEach((_, i) => {
      const raw = cells[i]?.trim() ?? '';
      columns[i].push(
        i === dateColumn ? parseIsoDateMs(raw) : raw === '' ? NaN : Number(raw),
      );
    });
  }
  const times = columns[dateColumn];
  const byId = new Map<string, SeriesData>();
  headers.forEach((header, i) => {
    byId.set(i === dateColumn ? 'time' : header, {
      length: columns[i].length,
      at: (index: number) => columns[i][index],
    });
  });

  // Derived ambient series every host is expected to synthesize (csv.ts
  // convention).
  const col = (id: string): SeriesData | undefined => byId.get(id);
  const derive = (
    id: string,
    inputs: readonly string[],
    combine: (...xs: number[]) => number,
  ): void => {
    if (byId.has(id)) {
      return;
    }
    const sources = inputs.map(col);
    if (sources.some(s => s === undefined)) {
      return;
    }
    const data = sources as SeriesData[];
    byId.set(id, {
      length: Math.min(...data.map(s => s.length)),
      at: (index: number) => combine(...data.map(s => s.at(index))),
    });
  };
  derive('hl2', ['high', 'low'], (h, l) => (h + l) / 2);
  derive('hlc3', ['high', 'low', 'close'], (h, l, c) => (h + l + c) / 3);
  derive(
    'ohlc4',
    ['open', 'high', 'low', 'close'],
    (o, h, l, c) => (o + h + l + c) / 4,
  );
  derive('hlcc4', ['high', 'low', 'close'], (h, l, c) => (h + l + c + c) / 4);

  return {
    rows,
    axis: stooqAxis(times, rows, interval),
    series: (id: string) => byId.get(id) ?? null,
  };
}

// Stooq dates are ISO calendar days (YYYY-MM-DD); the bar OPEN is that
// day's UTC midnight. Anything else parses to NaN — never a guessed date.
function parseIsoDateMs(raw: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) {
    return NaN;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// A bar closes when the next one opens; the last bar spans the nominal
// interval for the timeframe (see NOMINAL_SPAN_MS's deviation-ledger note).
function stooqAxis(
  times: readonly number[],
  rows: number,
  interval: StooqInterval,
): TimeAxis {
  const span = NOMINAL_SPAN_MS[interval];
  return {
    time: row => times[row],
    closeTime: row => (row + 1 < rows ? times[row + 1] : times[row] + span),
  };
}
