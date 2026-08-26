// Purpose: Target-driven Observable synchronization with retained targets and
// caller-controlled source-buffer consumption.

import {Observable, type OperatorFunction, Subscription} from 'rxjs';

export function sync<S, T, U = S | readonly S[]>(
  target: Observable<T>,
  project?: (
    target: T,
    buffered: readonly S[],
  ) => readonly [value: U, consume?: number] | undefined,
): OperatorFunction<S, U> {
  return (source: Observable<S>) =>
    new Observable<U>(subscriber => {
      const subscriptions = new Subscription();
      const pending: T[] = [];
      const buffered: S[] = [];
      let sourceComplete = false;
      let targetComplete = false;
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

      const drain = () => {
        if (draining || subscriber.closed) return;
        draining = true;
        let blocked = false;
        try {
          while (pending.length > 0 && !subscriber.closed) {
            const targetValue = pending[0]!;
            const values = buffered.slice();
            let result: readonly [value: U, consume?: number] | undefined;

            try {
              result =
                project === undefined
                  ? values.length === 0
                    ? undefined
                    : [(values.length === 1 ? values[0]! : values) as U]
                  : project(targetValue, values);
            } catch (error) {
              subscriber.error(error);
              return;
            }

            if (result === undefined) {
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
        if (
          sourceComplete &&
          (buffered.length === 0 || (blocked && pending.length > 0))
        ) {
          subscriber.complete();
          return;
        }
        completeIfDone();
      };

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
