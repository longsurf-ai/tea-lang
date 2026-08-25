// Purpose: Shared validation for source-level history offsets and retention.

/** True when an offset can name committed history. */
export function isHistoryOffset(offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0;
}
