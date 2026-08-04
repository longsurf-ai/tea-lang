// Purpose: CSV DataProvider — one context per file; header names map to ambient series ids, an optional epoch-ms `time` column provides the merge axis. Deterministic and offline, the substrate for golden traces and `tea run`.

import type {
  DataProvider,
  ProviderContext,
  SeriesData,
  TimeAxis,
} from '../../runtime/abi';

export function csvProvider(text: string): DataProvider {
  const context = csvContext(text);
  return {
    // A csv file has exactly one context: the default pair. Requests for a
    // named symbol belong to a registry with network drivers.
    async resolveContext(symbol, timeframe, range) {
      void range;
      if (symbol !== '') {
        return {
          error: 'unknownSymbol' as const,
          detail: `csv provider serves only its own context, not '${symbol}'`,
        };
      }
      if (timeframe !== '') {
        return {
          error: 'unsupportedTimeframe' as const,
          detail: `csv provider cannot resample to '${timeframe}'`,
        };
      }
      return context;
    },
  };
}

// Exported for hosts and drivers that assemble multi-context providers from
// csv-shaped payloads (test fixtures, csv-shaped driver payloads).
export function csvContext(text: string): ProviderContext {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  const columns: number[][] = headers.map(() => []);
  for (const line of lines.slice(1)) {
    if (line.trim() === '') {
      continue;
    }
    const cells = line.split(',');
    headers.forEach((_, i) => {
      const raw = cells[i]?.trim() ?? '';
      columns[i].push(raw === '' ? NaN : Number(raw));
    });
  }
  const rows = columns.length === 0 ? 0 : columns[0].length;
  const byId = new Map<string, SeriesData>();
  headers.forEach((header, i) => {
    byId.set(header, {
      length: columns[i].length,
      at: (index: number) => columns[i][index],
    });
  });

  // Derived ambient series every host is expected to synthesize.
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
    axis: csvAxis(headers.indexOf('time'), columns, rows),
    series: (id: string) => byId.get(id) ?? null,
  };
}

// The axis convention for csv fixtures: a `time` column of epoch-ms bar
// OPEN times; a bar closes when the next one opens, and the last bar spans
// the same interval as its predecessor (a single-bar file spans zero).
// Honest per-bar close times need a source that knows sessions — csv is a
// fixture format, not one.
function csvAxis(
  timeColumn: number,
  columns: readonly (readonly number[])[],
  rows: number,
): TimeAxis | null {
  if (timeColumn < 0) {
    return null;
  }
  const times = columns[timeColumn];
  const lastSpan = rows >= 2 ? times[rows - 1] - times[rows - 2] : 0;
  return {
    time: row => times[row],
    closeTime: row => (row + 1 < rows ? times[row + 1] : times[row] + lastSpan),
  };
}
