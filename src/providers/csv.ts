// Purpose: CSV DataProvider — header names map to ambient series ids; deterministic and offline, the substrate for golden traces and `tea run`.

import type {DataProvider, SeriesData} from '../runtime/abi';

export function csvProvider(text: string): DataProvider {
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

  return {series: (id: string) => byId.get(id) ?? null};
}
