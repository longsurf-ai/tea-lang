// Purpose: Typed history reads and transactional writes over Context-owned state.

import {Value} from './value';

/**
 * A read-only series. Each history read captures a value at that exact point.
 * @example `const previous = close.hist(1);` cannot change when close advances.
 */
export class Input<T, K extends string = string> {
  constructor(private readonly read: (offset: number) => Value<T, K>) {}

  /** Read current state at zero or committed history at a positive offset. */
  hist(offset: number | Value<number, 'int'> = 0): Value<T, K> {
    return this.read(offset instanceof Value ? offset.value : offset);
  }
}

/**
 * One writable Tea binding. The execution owner applies persistence and commit;
 * Series neither owns a second history buffer nor commits independently.
 * @example `total.init(() => float(0)); total.set(total.hist(0).add(close.hist(0)));`
 */
export class Series<T, K extends string = string> extends Input<T, K> {
  constructor(
    read: (offset: number) => Value<T, K>,
    private readonly write: (value: Value<T, K>) => void,
    private readonly isUninitialized: () => boolean,
    private readonly initializeValue: (value: Value<T, K>) => void,
  ) {
    super(read);
  }

  /**
   * Stage a value in the current transaction. Reads in the same step see this write.
   * @example `total.set(total.hist(0).add(float(1)))` leaves earlier captures unchanged.
   */
  set(value: Value<T, K>): void {
    this.write(value);
  }

  /** Evaluate a persistent initializer only on its first reached execution. */
  init(initial: () => Value<T, K>): void {
    if (this.needsInit()) this.initialize(initial());
  }

  /** Test the lexical initializer guard without adding a function boundary. */
  needsInit(): boolean {
    return this.isUninitialized();
  }

  /** Stage a first initialization after its guarded expression completes. */
  initialize(value: Value<T, K>): void {
    this.initializeValue(value);
  }
}
