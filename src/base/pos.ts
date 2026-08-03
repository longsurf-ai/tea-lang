// Purpose: Source positions and spans — 1-based line/column, the shared location vocabulary for every stage.

export interface Pos {
  readonly line: number;
  readonly col: number;
}

export interface Span {
  readonly start: Pos;
  readonly end: Pos;
}

export function formatPos(pos: Pos): string {
  return `${pos.line}:${pos.col}`;
}
