// Purpose: Ring — one history buffer class for value and reference slots alike: committed cells plus the scratch head the provisional protocol executes against.

import type {Value} from './abi';

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

  // keep = committed cells retained (0 for perBar depth-none slots — their
  // history never materializes and commit is a no-op).
  constructor(
    readonly keep: number,
    readonly naValue: Value,
  ) {
    this.buf = new Array<Value>(keep);
    this.scratch = naValue;
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

  // Execution-start reset: the kernel chooses the seed per storage class
  // (var/varip seed from the last committed value, perBar from na).
  resetScratch(seed: Value): void {
    this.scratch = seed;
    this.written = false;
  }

  lastCommitted(): Value {
    if (this.count === 0) {
      return this.naValue;
    }
    return this.buf[this.head];
  }

  hasCommitted(): boolean {
    return this.count > 0;
  }

  at(offset: number): Value {
    if (offset === 0) {
      return this.scratch;
    }
    const back = offset - 1; // 0 = most recent committed
    if (back >= this.count || back >= this.keep) {
      return this.naValue;
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
