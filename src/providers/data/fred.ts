// Purpose: FRED DataProvider — one context per series id, served at its native frequency; the single observation value normalizes to the standard ambient set (value = close, OHLC collapsed, volume na).

import type {
  ContextError,
  DataProvider,
  ProviderContext,
  SeriesData,
  TimeAxis,
} from '../../runtime/abi';

const API = 'https://api.stlouisfed.org/fred';
const DAY = 86_400_000;

// Native frequency table: FRED's frequency_short → the Pine timeframe it can
// serve, and the nominal span (ms) the last observation covers. Nominal
// because FRED periods are calendar-shaped (a month is not 30 days); interior
// bars close when the next observation opens, so only the final close leans
// on this.
const FREQUENCIES = new Map<
  string,
  {readonly timeframe: string; readonly span: number}
>([
  ['D', {timeframe: 'D', span: DAY}],
  ['W', {timeframe: 'W', span: 7 * DAY}],
  ['M', {timeframe: 'M', span: 30 * DAY}],
  ['Q', {timeframe: '3M', span: 91 * DAY}],
  ['SA', {timeframe: '6M', span: 182 * DAY}],
  ['A', {timeframe: '12M', span: 365 * DAY}],
]);

// The API key is host configuration (CLI config for `tea`, never Tea source
// or process.env read in here); fetchImpl is injectable so tests stay offline.
export function fredProvider(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): DataProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const query = (symbol: string): string =>
    `series_id=${encodeURIComponent(symbol)}&api_key=${encodeURIComponent(options.apiKey)}&file_type=json`;
  return {
    async resolveContext(symbol, timeframe, range) {
      // A FRED series fits in one response (the API caps a page at 100k
      // observations, beyond any FRED series), so range never forces paging.
      void range;
      if (symbol === '') {
        return {
          error: 'unknownSymbol' as const,
          detail: 'FRED has no default context; a series id is required',
        };
      }
      const meta = await fredJson(fetchImpl, `${API}/series?${query(symbol)}`);
      if ('error' in meta) {
        return meta;
      }
      const frequency = parseFrequency(meta.body);
      if (frequency === null) {
        return {
          error: 'fetchFailed' as const,
          detail: `malformed FRED series metadata for '${symbol}'`,
        };
      }
      // Native-frequency serving only: '' means source-native, and an
      // explicit timeframe must match the native one exactly. Resampling
      // (a monthly series onto a weekly axis, aggregation the other way)
      // is a later refinement.
      if (timeframe !== '' && timeframe !== frequency.timeframe) {
        return {
          error: 'unsupportedTimeframe' as const,
          detail: `FRED series '${symbol}' has native frequency '${frequency.short}' (timeframe '${frequency.timeframe}'); cannot serve '${timeframe}'`,
        };
      }
      const obs = await fredJson(
        fetchImpl,
        `${API}/series/observations?${query(symbol)}`,
      );
      if ('error' in obs) {
        return obs;
      }
      const observations = parseObservations(obs.body);
      if (observations === null) {
        return {
          error: 'fetchFailed' as const,
          detail: `malformed FRED observations for '${symbol}'`,
        };
      }
      return fredContext(observations, frequency.span);
    },
  };
}

// One GET against the FRED API. The only broad catch in the driver lives
// here, at the fetch boundary: network rejection and non-JSON bodies map to
// typed fetchFailed, never escape as throws.
async function fredJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{readonly body: unknown} | ContextError> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl(url);
    body = await response.json();
  } catch (cause) {
    return {
      error: 'fetchFailed' as const,
      detail: `FRED request failed: ${String(cause)}`,
    };
  }
  if (!response.ok) {
    // FRED reports both an unknown series id and a missing/invalid API key
    // as HTTP 400 with an error_message; forwarding the upstream message
    // verbatim lets the user tell the two apart.
    const message = errorMessage(body);
    if (response.status === 400 && message !== null) {
      return {error: 'unknownSymbol' as const, detail: message};
    }
    return {
      error: 'fetchFailed' as const,
      detail: `FRED responded ${response.status}${message === null ? '' : `: ${message}`}`,
    };
  }
  return {body};
}

function errorMessage(body: unknown): string | null {
  return isRecord(body) && typeof body.error_message === 'string'
    ? body.error_message
    : null;
}

function parseFrequency(body: unknown): {
  readonly short: string;
  readonly timeframe: string;
  readonly span: number;
} | null {
  if (!isRecord(body) || !Array.isArray(body.seriess)) {
    return null;
  }
  const first: unknown = body.seriess[0];
  if (!isRecord(first) || typeof first.frequency_short !== 'string') {
    return null;
  }
  const entry = FREQUENCIES.get(first.frequency_short);
  return entry === undefined ? null : {short: first.frequency_short, ...entry};
}

interface FredObservation {
  readonly time: number; // epoch ms UTC of the period OPEN
  readonly value: number; // NaN = missing (FRED serves '.')
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseObservations(body: unknown): readonly FredObservation[] | null {
  if (!isRecord(body) || !Array.isArray(body.observations)) {
    return null;
  }
  const out: FredObservation[] = [];
  for (const entry of body.observations) {
    if (
      !isRecord(entry) ||
      typeof entry.date !== 'string' ||
      typeof entry.value !== 'string'
    ) {
      return null;
    }
    const match = DATE_PATTERN.exec(entry.date);
    if (match === null) {
      return null;
    }
    out.push({
      time: Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
      value: entry.value === '.' ? NaN : Number(entry.value),
    });
  }
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function fredContext(
  observations: readonly FredObservation[],
  span: number,
): ProviderContext {
  const rows = observations.length;
  const times = observations.map(o => o.time);
  const values = observations.map(o => o.value);
  const series = (at: (index: number) => number): SeriesData => ({
    length: rows,
    at,
  });

  // Single-valued normalization (docs/requests.md, driver obligations): the
  // observation value serves as close, open/high/low collapse to the same
  // column, and volume is all-na.
  const value = series(index => values[index]);
  const open = value;
  const high = value;
  const low = value;
  const close = value;
  const byId = new Map<string, SeriesData>([
    ['time', series(index => times[index])],
    ['open', open],
    ['high', high],
    ['low', low],
    ['close', close],
    ['volume', series(() => NaN)],
    // The derived ambients all equal close here, but deriving them from the
    // standard set keeps normalization uniform across drivers (csv.ts is
    // the pattern).
    ['hl2', series(i => (high.at(i) + low.at(i)) / 2)],
    ['hlc3', series(i => (high.at(i) + low.at(i) + close.at(i)) / 3)],
    [
      'ohlc4',
      series(i => (open.at(i) + high.at(i) + low.at(i) + close.at(i)) / 4),
    ],
    [
      'hlcc4',
      series(i => (high.at(i) + low.at(i) + close.at(i) + close.at(i)) / 4),
    ],
  ]);
  return {
    rows,
    axis: fredAxis(times, span),
    series: id => byId.get(id) ?? null,
  };
}

// The axis convention: a FRED observation date marks the period OPEN (the
// start of the period the value covers). A bar closes when the next
// observation opens; the last bar spans its native frequency nominally
// (see FREQUENCIES).
function fredAxis(times: readonly number[], span: number): TimeAxis {
  const rows = times.length;
  return {
    time: row => times[row],
    closeTime: row =>
      row + 1 < rows ? times[row + 1] : times[rows - 1] + span,
  };
}
