// Purpose: Buffered character cursor over one source file — position tracking and segment recording for the scanner; no token knowledge.

import type {Pos, PosBase} from '../base/pos';

// Reads one character at a time, tracks line/col, and records the current
// segment so literal/name lexemes are sliced exactly once. Iteration is by
// UTF-16 code unit; columns count code units.
export class Source {
  // Current character; '' means end of input.
  ch: string;
  line = 1;
  col = 1;

  private offset = 0;
  private segmentStart = -1;

  constructor(
    readonly base: PosBase,
    readonly text: string,
  ) {
    this.ch = text.length > 0 ? text[0] : '';
  }

  // Position of the current character.
  pos(): Pos {
    return {base: this.base, line: this.line, col: this.col};
  }

  // Character after ch, '' at end of input. One code unit of lookahead is
  // all the scanner ever needs.
  peek(): string {
    const next = this.offset + 1;
    return next < this.text.length ? this.text[next] : '';
  }

  // Advance to the next character, updating ch/line/col.
  nextch(): void {
    if (this.ch === '') {
      return;
    }
    if (this.ch === '\n') {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    this.offset += 1;
    this.ch = this.offset < this.text.length ? this.text[this.offset] : '';
  }

  // Begin recording a segment at the current character.
  startSegment(): void {
    this.segmentStart = this.offset;
  }

  // The recorded segment text, from startSegment() up to (excluding) ch.
  segment(): string {
    return this.text.slice(this.segmentStart, this.offset);
  }
}
