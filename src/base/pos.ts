// Purpose: Source positions — every Pos carries its PosBase so file identity travels with the position; lines and columns are 1-based.

export interface PosBase {
  readonly filename: string;
}

export function newFileBase(filename: string): PosBase {
  return {filename};
}

export interface Pos {
  readonly base: PosBase;
  readonly line: number;
  readonly col: number;
}

export function formatPos(pos: Pos): string {
  return `${pos.base.filename}:${pos.line}:${pos.col}`;
}
