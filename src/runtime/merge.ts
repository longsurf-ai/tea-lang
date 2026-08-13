// Purpose: Sample-merge alignment — a pure function from two time axes and a merge policy to a parent→child row mapping; never copies child data (docs/requests.md: merge is alignment, not data movement).

import {BindError} from './errors';
import type {TimeAxis} from './provider';

// A merge axis must be finite and strictly time-ordered: NaN comparisons
// are silently false and a shuffled axis would corrupt the mapping without
// any error, so the bind path refuses instead (assert-and-fail).
export function assertMergeAxis(
  axis: TimeAxis,
  rows: number,
  what: string,
): void {
  let previousOpen = -Infinity;
  for (let row = 0; row < rows; row += 1) {
    const open = axis.time(row);
    const close = axis.closeTime(row);
    if (!Number.isFinite(open) || !Number.isFinite(close) || close < open) {
      throw new BindError(
        `${what}: invalid time axis at row ${row} (open ${open}, close ${close})`,
      );
    }
    if (open <= previousOpen) {
      throw new BindError(
        `${what}: time axis is not strictly increasing at row ${row}`,
      );
    }
    previousOpen = open;
  }
}

// The parent-row-indexed mapping: entry p is the child row whose result
// serves parent row p, or -1 for na. Merge semantics are runtime-owned and
// source-independent; a FRED monthly series under a daily axis obeys the
// same rules as an equity HTF request.
export function sampleMergeMap(
  parentAxis: TimeAxis,
  parentRows: number,
  childAxis: TimeAxis,
  childRows: number,
  merge: {readonly gaps: boolean; readonly lookahead: boolean},
): Int32Array {
  const map = new Int32Array(parentRows);
  let child = -1;
  for (let p = 0; p < parentRows; p += 1) {
    const before = child;
    if (merge.lookahead) {
      // lookahead_on: the child bar containing the parent bar's open —
      // reads a value not yet final on historical data (Pine's documented
      // repaint footgun, implemented for compliance).
      const openTime = parentAxis.time(p);
      while (child + 1 < childRows && childAxis.time(child + 1) <= openTime) {
        child += 1;
      }
    } else {
      // lookahead_off: the most recent child bar that has CLOSED by this
      // parent bar's close. A still-forming child bar contributes nothing.
      const closeTime = parentAxis.closeTime(p);
      while (
        child + 1 < childRows &&
        childAxis.closeTime(child + 1) <= closeTime
      ) {
        child += 1;
      }
    }
    // gaps_on: only rows where a NEW child bar arrived carry a value.
    const gapped = merge.gaps && child === before;
    map[p] = child < 0 || gapped ? -1 : child;
  }
  return map;
}
