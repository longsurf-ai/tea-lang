// Purpose: Run one finite set of public Node bindings to completion.

import type {Observer} from 'rxjs';
import type {BindingInput, Datum, Node} from '../../api/node';
import type {Recipe} from '../recipe';

/** The summary returned after a Batch Recipe finishes. */
export type BatchResult = Readonly<{
  /** Number of data positions processed by the Node. */
  readonly indices: number;
}>;

/**
 * A common way to run one Node over finite data.
 *
 * The Recipe remembers the Node, the same bindings accepted by `Node.bind()`,
 * and the same observer accepted by `Node.to()`. It adds no execution path of
 * its own: `execute()` performs that public wiring and waits for completion.
 */
class BatchRecipe implements Recipe<BatchResult> {
  /** Stores the public Node wiring without binding or subscribing yet. */
  constructor(
    private readonly node: Node,
    private readonly bindings: readonly BindingInput[],
    private readonly observer: Partial<Observer<Datum>> & {
      readonly completion?: PromiseLike<void>;
    },
  ) {}

  /**
   * Binds the finite inputs, starts the Node, and waits for it to finish.
   *
   * The returned count is derived from the Node-owned indices in its Datums.
   * Any binding, runtime, source, or observer failure rejects this method. If
   * the observer exposes a `completion` Promise, execution also waits for its
   * asynchronous flush or delivery failure. The Node is always disposed before
   * the promise settles.
   */
  async execute(): Promise<BatchResult> {
    let indices = 0;
    let subscribed = false;
    try {
      for (const binding of this.bindings) this.node.bind(binding);
      const nodeCompletion = new Promise<void>((resolve, reject) => {
        try {
          this.node.to({
            next: datum => {
              indices = Math.max(indices, datum.index + 1);
              this.observer.next?.(datum);
            },
            error: error => {
              try {
                this.observer.error?.(error);
              } catch (deliveryError) {
                reject(deliveryError);
                return;
              }
              reject(error);
            },
            complete: () => {
              try {
                this.observer.complete?.();
              } catch (deliveryError) {
                reject(deliveryError);
                return;
              }
              resolve();
            },
          });
          subscribed = true;
        } catch (error) {
          reject(error);
        }
      });
      await Promise.all([
        nodeCompletion,
        this.observer.completion ?? Promise.resolve(),
      ]);
      return {indices};
    } catch (error) {
      if (!subscribed) {
        try {
          this.observer.error?.(error);
        } catch (deliveryError) {
          throw deliveryError;
        }
      }
      throw error;
    } finally {
      this.node.dispose();
    }
  }
}

/**
 * Creates one finite Recipe from ordinary public Node inputs and output.
 *
 * Creating it does not bind data or start execution. Call `execute()` once to
 * perform the same `bind()` and `to()` calls an embedding application would
 * otherwise write directly.
 *
 * @example `await batchRecipe(node, [prices], sink).execute()` binds the
 * finite price stream, observes every Datum, and waits for the sink to finish.
 */
export function batchRecipe(
  node: Node,
  bindings: readonly BindingInput[],
  observer: Partial<Observer<Datum>> & {
    readonly completion?: PromiseLike<void>;
  },
): Recipe<BatchResult> {
  return new BatchRecipe(node, bindings, observer);
}
