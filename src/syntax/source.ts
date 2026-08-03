// Purpose: Buffered character cursor over one source file — position tracking and segment recording for the scanner; no token knowledge.

import type {Pos, PosBase} from '../base/pos';
import {unimplemented} from '../base/unimplemented';

// Reads one character at a time, tracks line/col, and records the current
// segment so literal/name lexemes are sliced exactly once.
export class Source {
  // Current character, valid after nextch(); '' means end of input.
  ch = '';
  line = 1;
  col = 0;

  private offset = 0;
  private segmentStart = -1;

  constructor(
    readonly base: PosBase,
    readonly text: string,
  ) {}

  pos(): Pos {
    return {base: this.base, line: this.line, col: this.col};
  }

  // Advance to the next character, updating ch/line/col.
  nextch(): void {
    unimplemented('syntax/source: nextch', this.text, this.offset);
  }

  // Begin recording a segment at the current character.
  startSegment(): void {
    unimplemented('syntax/source: startSegment', this.segmentStart);
  }

  // The recorded segment text, from startSegment() up to (excluding) ch.
  segment(): string {
    return unimplemented('syntax/source: segment', this.segmentStart);
  }
}
