// Purpose: Key-based Observable combination with explicit inner/full-outer
// output modes and a shared unmatched-row side channel.

import {
  filter,
  from,
  Observable,
  type ObservableInput,
  type ObservedValueOf,
  share,
  Subscription,
} from 'rxjs';

const EMPTY_SLOT = Symbol('join empty slot');

export type JoinMode = 'inner' | 'outer';

export interface JoinOptions<Mode extends JoinMode = JoinMode> {
  readonly mode: Mode;
}

export type JoinValues<Sources extends readonly ObservableInput<unknown>[]> =
  Readonly<{
    [Index in keyof Sources]: ObservedValueOf<Sources[Index]>;
  }>;

export type JoinSlot<Value> =
  | {readonly present: true; readonly value: Value}
  | {readonly present: false};

export type JoinSlots<Values extends readonly unknown[]> = Readonly<{
  [Index in keyof Values]: JoinSlot<Values[Index]>;
}>;

export interface MatchedJoinRow<Key, Values extends readonly unknown[]> {
  readonly kind: 'matched';
  readonly key: Key;
  readonly values: Values;
}

export interface UnmatchedJoinRow<Key, Values extends readonly unknown[]> {
  readonly kind: 'unmatched';
  readonly key: Key;
  readonly slots: JoinSlots<Values>;
}

export interface InnerJoinResult<Key, Values extends readonly unknown[]> {
  readonly output$: Observable<MatchedJoinRow<Key, Values>>;
  readonly unmatched$: Observable<UnmatchedJoinRow<Key, Values>>;
}

export interface OuterJoinResult<Key, Values extends readonly unknown[]> {
  readonly output$: Observable<
    MatchedJoinRow<Key, Values> | UnmatchedJoinRow<Key, Values>
  >;
  readonly unmatched$: Observable<UnmatchedJoinRow<Key, Values>>;
}

export type JoinResult<
  Mode extends JoinMode,
  Key,
  Values extends readonly unknown[],
> = Mode extends 'inner'
  ? InnerJoinResult<Key, Values>
  : OuterJoinResult<Key, Values>;

export class DuplicateJoinKeyError<Key = unknown> extends Error {
  constructor(
    readonly sourceIndex: number,
    readonly key: Key,
  ) {
    super(`join source ${sourceIndex} emitted duplicate key ${String(key)}`);
    this.name = 'DuplicateJoinKeyError';
  }
}

type JoinEvent<Key, Values extends readonly unknown[]> =
  | MatchedJoinRow<Key, Values>
  | UnmatchedJoinRow<Key, Values>;

/**
 * Join one value from every source by key.
 *
 * Keys must be unique within each source. Complete rows are emitted as soon as
 * all sources have supplied the key. Because arbitrary Observable inputs do not
 * provide ordering or watermarks, partial rows are finalized only after every
 * source completes.
 *
 * In inner mode output$ contains complete rows only. In outer mode output$
 * also contains every partial row. unmatched$ contains those same partial rows
 * in both modes. The two returned Observables are hot views of one lazily
 * started, shared join execution; subscribe to every desired view before the
 * inputs begin producing values.
 */
export function join<
  Sources extends readonly ObservableInput<unknown>[],
  Key,
  Mode extends JoinMode,
>(
  sources: Sources,
  keySelector: (value: ObservedValueOf<Sources[number]>) => Key,
  options: JoinOptions<Mode>,
): JoinResult<Mode, Key, JoinValues<Sources>>;
export function join<Sources extends readonly ObservableInput<unknown>[], Key>(
  sources: Sources,
  keySelector: (value: ObservedValueOf<Sources[number]>) => Key,
  options: JoinOptions,
):
  | InnerJoinResult<Key, JoinValues<Sources>>
  | OuterJoinResult<Key, JoinValues<Sources>> {
  if (options.mode !== 'inner' && options.mode !== 'outer') {
    throw new TypeError(`unsupported join mode: ${String(options.mode)}`);
  }

  type Values = JoinValues<Sources>;
  type Event = JoinEvent<Key, Values>;
  type PendingSlots = Array<unknown | typeof EMPTY_SLOT>;

  const events$ = new Observable<Event>(subscriber => {
    const sourceCount = sources.length;
    const pending = new Map<Key, PendingSlots>();
    const seen = Array.from({length: sourceCount}, () => new Set<Key>());
    const subscriptions = new Subscription();
    let completedSources = 0;

    const finish = () => {
      for (const [key, values] of pending) {
        const slots = values.map(value =>
          value === EMPTY_SLOT
            ? ({present: false} as const)
            : ({present: true, value} as const),
        ) as JoinSlots<Values>;
        subscriber.next({kind: 'unmatched', key, slots});
      }
      pending.clear();
      subscriber.complete();
    };

    if (sourceCount === 0) {
      subscriber.complete();
      return;
    }

    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex++) {
      if (subscriber.closed) {
        break;
      }

      const source = sources[sourceIndex]!;
      const sourceSeen = seen[sourceIndex]!;
      const sourceSubscription = from(source).subscribe({
        next: value => {
          let key: Key;
          try {
            key = keySelector(value as ObservedValueOf<Sources[number]>);
          } catch (error) {
            subscriber.error(error);
            return;
          }

          if (sourceSeen.has(key)) {
            subscriber.error(new DuplicateJoinKeyError(sourceIndex, key));
            return;
          }
          sourceSeen.add(key);

          let values = pending.get(key);
          if (values === undefined) {
            values = Array.from({length: sourceCount}, () => EMPTY_SLOT);
            pending.set(key, values);
          }
          values[sourceIndex] = value;

          if (values.every(candidate => candidate !== EMPTY_SLOT)) {
            pending.delete(key);
            subscriber.next({
              kind: 'matched',
              key,
              values: values.slice() as unknown as Values,
            });
          }
        },
        error: error => subscriber.error(error),
        complete: () => {
          completedSources++;
          if (completedSources === sourceCount) {
            finish();
          }
        },
      });
      subscriptions.add(sourceSubscription);
    }

    return subscriptions;
  }).pipe(
    share({
      resetOnComplete: false,
      resetOnError: false,
      resetOnRefCountZero: true,
    }),
  );

  const unmatched$ = events$.pipe(
    filter(
      (event): event is UnmatchedJoinRow<Key, Values> =>
        event.kind === 'unmatched',
    ),
  );
  const output$ =
    options.mode === 'inner'
      ? events$.pipe(
          filter(
            (event): event is MatchedJoinRow<Key, Values> =>
              event.kind === 'matched',
          ),
        )
      : events$;

  return {output$, unmatched$};
}
