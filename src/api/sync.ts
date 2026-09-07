// Purpose: `sync` operator. Emits once per target notification, projecting
// the source values buffered up to that point.

import {Observable, type OperatorFunction, Subscription} from 'rxjs';

const WAIT: unique symbol = Symbol('sync.wait');

/**
 * The projector's "not yet" result. A projector obtains it only by calling
 * the `wait` argument it receives, so returning it is always deliberate.
 */
export type Wait = typeof WAIT;

const wait = (): Wait => WAIT;

/**
 * Emits once per `target` notification, projecting the `source` values that
 * have been buffered up to that point.
 *
 * Like `zip`, but each target notification takes a projector-chosen number of
 * buffered source values instead of exactly one, and a notification that
 * arrives before the source can serve it waits instead of being dropped.
 *
 * ```text
 * source: --1---2-------3--|
 * target: ----x-----x-x----|
 * output: ----1-----2---3--|
 * ```
 *
 * Marble notation: `-` is a time frame, a letter or digit is an emitted value,
 * `x` is a notification, `|` is completion, `(1|)` is an emit and a completion
 * in the same frame.
 *
 * `sync` subscribes to the source Observable first, then to `target`. Source
 * values are buffered in order. Target notifications are queued in order and
 * served FIFO: for the oldest one, the projector receives the notification,
 * the current buffer, and a `wait` function, and returns either a tuple or
 * the result of `wait()`.
 *
 * - `[value, consume]`: `value` has the output type `U` and can be anything
 *   (one source value, an array of them, a computed record); it is emitted on
 *   the output Observable. `consume` is an integer in `0..buffer.length`: how
 *   many buffered source values to drop from the front. Omitted means all of
 *   them, `0` means none. Any other `consume` errors the output with a
 *   `RangeError`.
 * - `wait()`: keeps the notification queued and retries it on the next source
 *   value. In the diagram above the third notification waits for `3`. There
 *   is no other way to wait; a projector that returns `undefined` does not
 *   typecheck.
 *
 * Without a projector, a notification emits the buffer as is: the single value
 * when there is one, an array when several accumulated, nothing while empty.
 *
 * ```text
 * source: -1-2-3-----4----|
 * target: --------x----x--|
 * output: --------a----4--|   a = [1, 2, 3]
 * ```
 *
 * The output completes when:
 *
 * - `target` completes and no notification is still queued. Buffered source
 *   values are discarded and the source is unsubscribed.
 *
 *   ```text
 *   source: -1-2----3-----
 *   target: -----x-|
 *   output: -----a-|          a = [1, 2]; 3 is never emitted
 *   ```
 *
 *   A notification queued before `target` completes still waits for the source:
 *
 *   ```text
 *   source: --------1--
 *   target: ---x-|
 *   output: --------(1|)
 *   ```
 *
 * - `source` completes and the buffer is empty, unless
 *   `continueAfterSourceComplete` is `true`. Buffered leftovers are served to
 *   later notifications first.
 *
 *   ```text
 *   source: -1-2-|
 *   target: -------x---x---
 *   output: -------(a|)       a = [1, 2]
 *   ```
 *
 * - `source` has completed and the projector returns `wait()`. No source
 *   value can arrive to change that, so the queued notification is
 *   unservable. This holds regardless of `continueAfterSourceComplete`.
 *
 * With `continueAfterSourceComplete` set, source completion alone never
 * completes the output; it runs until `target` completes. Pair it with a
 * projector that can serve from what remains, typically by consuming `0`.
 *
 * ```text
 * source: -1---2-|
 * target: ---x----x---x---x-|
 * output: ---1----2---2---2-|   projector keeps the newest source value
 * ```
 *
 * An error from either Observable, a throwing projector, or an invalid
 * `consume` errors the output.
 * Unsubscribing from the output unsubscribes from both.
 *
 * ## Examples
 *
 * Default projection
 *
 * ```ts
 * import {Subject} from 'rxjs';
 * import {sync} from './sync';
 *
 * const source = new Subject<number>();
 * const target = new Subject<void>();
 * source.pipe(sync(target)).subscribe(x => console.log(x));
 *
 * source.next(1);
 * source.next(2);
 * target.next(); // [1, 2]
 * target.next(); // queued
 * source.next(3); // 3
 * ```
 *
 * Consume one buffered value per notification
 *
 * ```ts
 * source
 *   .pipe(
 *     sync(target, (_, buffer, wait) =>
 *       buffer.length === 0 ? wait() : [buffer[0], 1],
 *     ),
 *   )
 *   .subscribe(x => console.log(x));
 *
 * source.next(1);
 * source.next(2);
 * target.next(); // 1
 * target.next(); // 2
 * ```
 *
 * Wait until two values are buffered, then take both
 *
 * ```ts
 * sync(target, (_, buffer, wait) =>
 *   buffer.length < 2 ? wait() : [buffer.slice(0, 2), 2],
 * );
 * ```
 *
 * Carry the newest source value forward past source completion
 *
 * ```ts
 * source
 *   .pipe(
 *     sync(
 *       target,
 *       (_, buffer, wait) =>
 *         buffer.length === 0
 *           ? wait()
 *           : [buffer[buffer.length - 1], buffer.length - 1],
 *       true,
 *     ),
 *   )
 *   .subscribe(x => console.log(x));
 *
 * source.next(1);
 * source.next(2);
 * source.complete();
 * target.next(); // 2
 * target.next(); // 2
 * target.complete(); // output completes
 * ```
 *
 * @see `zip`, `buffer`, `sample` in rxjs
 *
 * @param target The notifier. Each of its values produces one output value,
 * in order, once the projector can serve it.
 * @param project Maps a target value and the buffered source values to
 * `[value: U, consume: integer]`, or returns `wait()` to wait for more
 * source values. `wait` is its third argument.
 * Defaults to emitting the whole buffer.
 * @param continueAfterSourceComplete Keep serving target values after the
 * source completes. Defaults to `false`.
 * @return A function that returns an Observable emitting one projected value
 * per target value.
 */
export function sync<S, T, U = S | readonly S[]>(
  target: Observable<T>,
  project?: (
    target: T,
    buffered: readonly S[],
    wait: () => Wait,
  ) => readonly [value: U, consume?: number] | Wait,
  continueAfterSourceComplete = false,
): OperatorFunction<S, U> {
  return (source: Observable<S>) =>
    new Observable<U>(subscriber => {
      const subscriptions = new Subscription();
      // Queued target notifications, oldest first.
      const pending: T[] = [];
      // Buffered source values not yet consumed, oldest first.
      const buffered: S[] = [];
      let sourceComplete = false;
      let targetComplete = false;
      // `subscriber.next()` may synchronously feed more values into either
      // side; those calls land in the running `drain` loop instead of nesting.
      let draining = false;

      const completeIfDone = () => {
        if (
          targetComplete &&
          (pending.length === 0 || sourceComplete) &&
          !subscriber.closed
        ) {
          subscriber.complete();
        }
      };

      // Serve as many queued notifications as the buffer allows. Runs after
      // every value or completion from either Observable.
      const drain = () => {
        if (draining || subscriber.closed) return;
        draining = true;
        // Set when the projector returned `wait()` for the oldest queued
        // notification.
        let blocked = false;
        try {
          while (pending.length > 0 && !subscriber.closed) {
            const targetValue = pending[0]!;
            const values = buffered.slice();
            let result: readonly [value: U, consume?: number] | Wait;

            try {
              result =
                project === undefined
                  ? values.length === 0
                    ? WAIT
                    : [(values.length === 1 ? values[0]! : values) as U]
                  : project(targetValue, values, wait);
            } catch (error) {
              subscriber.error(error);
              return;
            }

            if (result === WAIT) {
              blocked = true;
              break;
            }
            const [value, requestedConsume] = result;
            const consume = requestedConsume ?? values.length;
            if (
              !Number.isSafeInteger(consume) ||
              consume < 0 ||
              consume > values.length
            ) {
              subscriber.error(
                new RangeError(
                  `sync projector consumed ${consume} values from a buffer of ${values.length}`,
                ),
              );
              return;
            }

            buffered.splice(0, consume);
            pending.shift();
            subscriber.next(value);
          }
        } finally {
          draining = false;
        }
        // After source completion the output completes on its own when the
        // buffer is empty (unless asked to outlive the source) or when the
        // oldest queued notification can never be served.
        if (
          sourceComplete &&
          ((!continueAfterSourceComplete && buffered.length === 0) ||
            (blocked && pending.length > 0))
        ) {
          subscriber.complete();
          return;
        }
        completeIfDone();
      };

      // Source first: a synchronous source emission must already be buffered
      // when a synchronous first target notification needs it.
      subscriptions.add(
        source.subscribe({
          next(value) {
            buffered.push(value);
            drain();
          },
          error(error) {
            subscriber.error(error);
          },
          complete() {
            sourceComplete = true;
            drain();
            completeIfDone();
          },
        }),
      );

      if (!subscriber.closed) {
        subscriptions.add(
          target.subscribe({
            next(value) {
              pending.push(value);
              drain();
            },
            error(error) {
              subscriber.error(error);
            },
            complete() {
              targetComplete = true;
              drain();
              completeIfDone();
            },
          }),
        );
      }

      return subscriptions;
    });
}
