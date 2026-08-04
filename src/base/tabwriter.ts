// Purpose: Go-style column aligner — tab-separated cells become padded columns on flush; the single owner of console table layout for CLI dumps.

/**
 * Minimal analogue of Go's `text/tabwriter`: callers write cells (or a
 * tab-joined line); `flush()` pads every column to the max observed width
 * so tables stay readable without each printer inventing spacing rules.
 *
 * Not a full elastic-tabstops port — enough for deterministic CLI tables
 * (run output, future dumpers). Display width is code-unit length.
 */
export class TabWriter {
  private readonly lines: string[][] = [];

  writeCells(cells: readonly string[]): void {
    this.lines.push(cells.map(String));
  }

  // Convenience: a line whose fields are already joined by `\t`.
  writeTabbed(line: string): void {
    this.writeCells(line.split('\t'));
  }

  // A non-aligned note (preamble, blank) — never participates in column widths.
  writeRaw(line: string): void {
    this.lines.push([line]);
  }

  flush(): string {
    if (this.lines.length === 0) {
      return '';
    }
    const widths: number[] = [];
    for (const cells of this.lines) {
      if (cells.length === 1) {
        continue; // raw / single-cell lines do not define columns
      }
      for (let i = 0; i < cells.length; i++) {
        const w = cells[i]!.length;
        widths[i] = Math.max(widths[i] ?? 0, w);
      }
    }
    return this.lines
      .map(cells => {
        if (cells.length === 1) {
          return cells[0]!;
        }
        return cells
          .map((cell, i) => {
            const pad = (widths[i] ?? 0) - cell.length;
            const isLast = i === cells.length - 1;
            return isLast ? cell : cell + ' '.repeat(Math.max(0, pad) + 2);
          })
          .join('');
      })
      .join('\n');
  }
}
