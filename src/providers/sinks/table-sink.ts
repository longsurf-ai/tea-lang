// Purpose: Human-readable OutputSink — pivoted per-row table with column headers; presentation only (TraceSink remains the machine/golden format).

import {TabWriter} from '../../base/tabwriter';
import type {OutputSink, OutputSpec, Value} from '../../runtime/abi';

function formatValue(v: Value): string {
  if (typeof v === 'number') {
    return Number.isNaN(v) ? 'na' : String(v);
  }
  // Reference na is null — print it as the language value.
  return v === null ? 'na' : String(v);
}

function outputLabel(spec: OutputSpec, oid: number): string {
  const title = spec.staticArgs.find(a => a.name === 'title')?.value;
  if (typeof title === 'string' && title.length > 0) {
    return title;
  }
  return `${spec.effect}[${oid}]`;
}

function headerForChannel(
  spec: OutputSpec,
  oid: number,
  channel: {readonly name: string},
  channelCount: number,
): string {
  const label = outputLabel(spec, oid);
  // Primary series channel takes the plot title alone; extra channels
  // (color, condition, …) keep their name so the header stays scannable.
  if (channelCount === 1 || channel.name === 'series') {
    return label;
  }
  return `${label}.${channel.name}`;
}

interface Column {
  readonly oid: number;
  readonly channel: number;
  readonly header: string;
}

/**
 * Buffers emissions and flushes one aligned table: preamble for
 * channel-less outputs (indicator, hline, …), then `row` + one column per
 * emitted channel. Call `flush()` after `runAll()`.
 */
export class TableSink implements OutputSink {
  private declared: Parameters<OutputSink['declare']>[0] = [];
  // row -> oid -> channels (last write wins within a row)
  private readonly byRow = new Map<
    number,
    {provisional: boolean; values: Map<number, readonly Value[]>}
  >();

  constructor(private readonly write: (text: string) => void) {}

  declare(outputs: Parameters<OutputSink['declare']>[0]): void {
    this.declared = outputs;
  }

  emit(
    row: number,
    oid: number,
    channels: readonly Value[],
    provisional: boolean,
  ): void {
    let entry = this.byRow.get(row);
    if (entry === undefined) {
      entry = {provisional, values: new Map()};
      this.byRow.set(row, entry);
    }
    entry.provisional = entry.provisional || provisional;
    entry.values.set(oid, channels);
  }

  flush(): void {
    const tw = new TabWriter();

    for (const [oid, output] of this.declared.entries()) {
      if (output.spec.channels.length > 0) {
        continue;
      }
      const statics = output.spec.staticArgs
        .map(a => `${a.name}=${formatValue(a.value)}`)
        .join(' ');
      const bounds = output.boundArgs
        .map(a => `${a.name}=${formatValue(a.value)}`)
        .join(' ');
      tw.writeRaw(
        `# ${output.spec.effect}[${oid}]` +
          (statics.length > 0 ? `  ${statics}` : '') +
          (bounds.length > 0 ? `  bound{${bounds}}` : ''),
      );
    }

    const columns: Column[] = [];
    for (const [oid, output] of this.declared.entries()) {
      const n = output.spec.channels.length;
      for (let c = 0; c < n; c++) {
        columns.push({
          oid,
          channel: c,
          header: headerForChannel(
            output.spec,
            oid,
            output.spec.channels[c]!,
            n,
          ),
        });
      }
    }

    if (columns.length === 0) {
      const text = tw.flush();
      if (text.length > 0) {
        this.write(text);
      }
      return;
    }

    tw.writeCells(['row', ...columns.map(c => c.header)]);

    const rows = [...this.byRow.keys()].sort((a, b) => a - b);
    for (const row of rows) {
      const entry = this.byRow.get(row)!;
      const rowLabel = entry.provisional ? `${row}?` : String(row);
      const cells = [rowLabel];
      for (const col of columns) {
        const channels = entry.values.get(col.oid);
        const v = channels?.[col.channel];
        cells.push(v === undefined ? '' : formatValue(v));
      }
      tw.writeCells(cells);
    }

    this.write(tw.flush());
  }
}
