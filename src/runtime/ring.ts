// Purpose: Ring — one history buffer class for value and reference slots alike: committed cells plus the scratch head the provisional protocol executes against.

import {fatal} from '../base/print';
import {ValueClass, type Value, type ValueClass as ValueClassType} from './abi';

// History is strictly backward-looking. Non-integer, non-finite, negative,
// and imprecise offsets cannot name a committed cell and therefore read as
// the place's typed empty value.
export function isHistoryOffset(offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0;
}

export function emptyValue(valueClass: ValueClassType): Value {
  switch (valueClass) {
    case ValueClass.Numeric:
      return NaN;
    case ValueClass.Reference:
      return null;
    case ValueClass.Boolean:
      return false;
  }
}

// Offsets: at(0) is the row being executed (the scratch head); at(k >= 1)
// is committed history k rows back. Reads past what is kept or committed
// answer na (the slot's na value) — exceeding a declared cap is a ledger
// item, not a crash.
export class Ring {
  private readonly buf: Value[];
  private head = -1; // buf index of the most recent committed cell
  private count = 0; // committed cells filled, <= keep
  private scratch: Value;
  private written = false;
  readonly emptyValue: Value;

  // keep = committed cells retained (0 for perBar depth-none slots — their
  // history never materializes and commit is a no-op).
  constructor(
    readonly keep: number,
    readonly valueClass: ValueClassType,
  ) {
    if (!isHistoryOffset(keep) || keep > 0xffff_ffff) {
      fatal(`invalid ring retention depth ${keep}`);
    }
    this.buf = new Array<Value>(keep);
    this.emptyValue = emptyValue(valueClass);
    this.scratch = this.emptyValue;
  }

  // The value the current execution sees at offset 0 and the value commit
  // persists: this execution's write, or the seed resetScratch installed.
  peek(): Value {
    return this.scratch;
  }

  wasWritten(): boolean {
    return this.written;
  }

  setScratch(v: Value): void {
    this.scratch = v;
    this.written = true;
  }

  // Execution-start reset: the runtime chooses the seed per storage class
  // (var/varip seed from the last committed value, perBar from na).
  resetScratch(seed: Value): void {
    this.scratch = seed;
    this.written = false;
  }

  lastCommitted(): Value {
    if (this.count === 0) {
      return this.emptyValue;
    }
    return this.buf[this.head];
  }

  hasCommitted(): boolean {
    return this.count > 0;
  }

  at(offset: number): Value {
    if (!isHistoryOffset(offset)) {
      return this.emptyValue;
    }
    if (offset === 0) {
      return this.scratch;
    }
    const back = offset - 1; // 0 = most recent committed
    if (back >= this.count || back >= this.keep) {
      return this.emptyValue;
    }
    const index = (this.head - back + this.keep) % this.keep;
    return this.buf[index];
  }

  // Seals the executed value into history and invalidates the scratch head
  // until the next resetScratch.
  commit(): void {
    if (this.keep > 0) {
      this.head = (this.head + 1) % this.keep;
      this.buf[this.head] = this.scratch;
      if (this.count < this.keep) {
        this.count += 1;
      }
    }
    this.written = false;
  }
}
