// Purpose: CSV DataProvider — one context per file; numeric headers map to data-series ids while an optional epoch-ms `time` column exclusively builds the merge/execution axis.

import type {
  DataProvider,
  ProviderContext,
  SeriesData,
  TimeAxis,
} from '../../runtime/abi';
import {projectProviderRange} from './range';

export function csvProvider(text: string): DataProvider {
  const context = csvContext(text);
  return {
    // A csv file has exactly one context: the default pair. Requests for a
    // named symbol belong to a registry with network drivers.
    async resolveContext(symbol, timeframe, range) {
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
      return projectProviderRange(context, range);
    },
  };
}

// Exported for hosts and drivers that assemble multi-context providers from
// csv-shaped payloads (test fixtures, csv-shaped driver payloads).
export function csvContext(text: string): ProviderContext {
  const shape = scanCsvShape(text);
  const headers = parseHeaders(text, shape.headerStart, shape.headerEnd);
  const columns = headers.map(() => new Float64Array(shape.rows));
  fillColumns(text, shape.dataStart, columns);
  const rows = shape.rows;
  const byId = new Map<string, SeriesData>();
  headers.forEach((header, i) => {
    if (header === 'time') {
      return;
    }
    byId.set(header, {
      length: columns[i].length,
      at: (index: number) => columns[i][index],
    });
  });

  // Derived numeric data series every host is expected to synthesize.
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
    builtinValue: () => undefined,
  };
}

// The axis convention for csv fixtures: a `time` column of epoch-ms bar
// OPEN times; a bar closes when the next one opens, and the last bar spans
// the same interval as its predecessor (a single-bar file spans zero).
// Honest per-bar close times need a source that knows sessions — csv is a
// fixture format, not one.
function csvAxis(
  timeColumn: number,
  columns: readonly Float64Array[],
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

interface CsvShape {
  readonly headerStart: number;
  readonly headerEnd: number;
  readonly dataStart: number;
  readonly rows: number;
}

// This provider intentionally accepts only simple, unquoted numeric csv. Scan
// the source string instead of splitting it: a large input therefore retains
// one source string plus fixed-width columns, rather than lines, cells and
// boxed-number arrays proportional to the file size.
function scanCsvShape(text: string): CsvShape {
  let headerStart = -1;
  let headerEnd = -1;
  let dataStart = text.length;
  let rows = 0;
  forEachLine(text, 0, (start, end, next) => {
    if (isBlank(text, start, end)) {
      return;
    }
    if (headerStart < 0) {
      headerStart = start;
      headerEnd = end;
      dataStart = next;
      return;
    }
    rows++;
  });
  if (headerStart < 0) {
    // Preserve the old empty-input shape: one empty header and no rows.
    return {headerStart: 0, headerEnd: 0, dataStart: text.length, rows: 0};
  }
  return {headerStart, headerEnd, dataStart, rows};
}

function parseHeaders(text: string, start: number, end: number): string[] {
  const headers: string[] = [];
  let cellStart = start;
  for (let cursor = start; cursor <= end; cursor++) {
    if (cursor !== end && text.charCodeAt(cursor) !== 44 /* , */) {
      continue;
    }
    headers.push(text.slice(cellStart, cursor).trim());
    cellStart = cursor + 1;
  }
  return headers;
}

function fillColumns(
  text: string,
  dataStart: number,
  columns: readonly Float64Array[],
): void {
  let row = 0;
  forEachLine(text, dataStart, (start, end) => {
    if (isBlank(text, start, end)) {
      return;
    }
    let cellStart = start;
    let cursor = start;
    for (let column = 0; column < columns.length; column++) {
      while (cursor < end && text.charCodeAt(cursor) !== 44 /* , */) {
        cursor++;
      }
      columns[column][row] = parseNumericCell(text, cellStart, cursor);
      if (cursor < end) {
        cursor++;
        cellStart = cursor;
      } else {
        // Missing cells have the same meaning as present-but-blank cells.
        cellStart = end;
      }
    }
    row++;
  });
}

function parseNumericCell(text: string, start: number, end: number): number {
  while (start < end && isSpace(text.charCodeAt(start))) {
    start++;
  }
  while (end > start && isSpace(text.charCodeAt(end - 1))) {
    end--;
  }
  return start === end ? NaN : Number(text.slice(start, end));
}

function forEachLine(
  text: string,
  start: number,
  visit: (start: number, end: number, next: number) => void,
): void {
  let lineStart = start;
  for (let cursor = start; cursor <= text.length; cursor++) {
    if (cursor !== text.length && text.charCodeAt(cursor) !== 10 /* \n */) {
      continue;
    }
    const end =
      cursor > lineStart && text.charCodeAt(cursor - 1) === 13
        ? cursor - 1
        : cursor;
    visit(lineStart, end, cursor < text.length ? cursor + 1 : cursor);
    lineStart = cursor + 1;
  }
}

function isBlank(text: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end; cursor++) {
    if (!isSpace(text.charCodeAt(cursor))) {
      return false;
    }
  }
  return true;
}

// Matches the whitespace stripped by String.prototype.trim without allocating
// a substring for every blank-line check.
function isSpace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}
