// Purpose: User-facing compile errors — queued at report time with per-line suppression, sorted and deduped at flush; internal invariant violations abort via fatal() and never queue.

import type {Pos} from './pos';

// Reporting callback injected into the frontend; the scanner and parser call
// this and continue with recovery.
export type ErrorHandler = (pos: Pos, msg: string) => void;

export interface ErrorMsg {
  readonly pos: Pos;
  readonly msg: string;
}

// @agent invariant: one Errors instance per compilation, owned by the driver
// (compile.ts) or the CLI. User-facing errors are never thrown and never
// printed at the report site — they queue here and surface exactly once via
// flushErrors(). Invariant violations use fatal()/unimplemented() instead and
// must never queue.
export class Errors {
  private queued: ErrorMsg[] = [];
  // At most one error per source line survives, no matter how confused a
  // recovering parse gets.
  private last: Pos | null = null;

  errorAt(pos: Pos, msg: string): void {
    if (
      this.last !== null &&
      this.last.base === pos.base &&
      this.last.line === pos.line
    ) {
      return;
    }
    this.last = pos;
    this.queued.push({pos, msg});
  }

  get count(): number {
    return this.queued.length;
  }

  // Stable-sort by position, drop exact duplicates, hand the batch to the
  // caller, and clear the queue.
  flushErrors(): ErrorMsg[] {
    const sorted = [...this.queued].sort(
      (a, b) =>
        a.pos.base.filename.localeCompare(b.pos.base.filename) ||
        a.pos.line - b.pos.line ||
        a.pos.col - b.pos.col,
    );
    this.queued = [];
    return sorted.filter((e, i) => {
      if (i === 0) {
        return true;
      }
      const prev = sorted[i - 1];
      return (
        e.msg !== prev.msg ||
        e.pos.base !== prev.pos.base ||
        e.pos.line !== prev.pos.line ||
        e.pos.col !== prev.pos.col
      );
    });
  }
}

export class InternalError extends Error {
  constructor(msg: string) {
    super(`internal compiler error: ${msg}`);
    this.name = 'InternalError';
  }
}

export function fatal(msg: string): never {
  throw new InternalError(msg);
}
