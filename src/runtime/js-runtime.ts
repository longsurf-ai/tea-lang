// Purpose: State-owning JavaScript execution facade over the explicit Tea
// StateMachine transition.

import {Effect} from 'effect';
import {fatal} from '../base/print';
import type {JSModule} from './module-abi';
import type {EffectEmission, DenseEmission} from './output';
import {ArenaHeap, type HeapLimits} from './heap';
import type {ExecutionError} from './errors';
import type {Intermediate, RuntimeContext, State} from './state-machine';
import {stateMachine, type TeaStateMachine} from './state-update';
import type {Value} from './value';
import type {LayoutId, ValueLayoutRegistry} from './value-layout';

export interface JSRuntimeOptions {
  readonly heapLimits?: Partial<HeapLimits>;
  readonly maxCollectionElements?: number;
}

export type {RuntimeContext} from './state-machine';

/** The externally observable product of one completed runtime step. */
export interface StepResult {
  readonly output: readonly DenseEmission[];
  readonly effects: readonly EffectEmission[];
  readonly provisional: boolean;
}

/**
 * Owns all mutable resources and current state for step-based Tea execution.
 * Callers provide only synchronized inputs; State, Intermediate, and Heap
 * never cross this boundary.
 */
export class JSRuntime {
  private readonly heap: ArenaHeap;
  private readonly machine: TeaStateMachine;
  private state: State;
  private intermediate: Intermediate;
  private rootValues: readonly Value[] | null = null;
  private disposed = false;

  constructor(
    private readonly module: JSModule,
    params: readonly Value[],
    private readonly layouts: ValueLayoutRegistry,
    options: JSRuntimeOptions = {},
  ) {
    this.heap = new ArenaHeap(options.heapLimits);
    this.machine = stateMachine(
      module,
      params,
      layouts,
      this.heap,
      options.maxCollectionElements,
    );
    this.state = this.machine.initialState;
    this.intermediate = this.machine.initialIntermediate;
  }

  step(ctx: RuntimeContext): Effect.Effect<StepResult, ExecutionError> {
    return Effect.suspend(() => {
      this.assertLive();
      return Effect.map(
        this.machine.update(this.state, this.intermediate, ctx),
        result => {
          this.rootValues = result.rootValues;
          this.intermediate = result.intermediate;
          if (!ctx.provisional) {
            this.state = result.state;
          }
          return {
            output: result.output,
            effects: result.effects,
            provisional: ctx.provisional,
          };
        },
      );
    });
  }

  /**
   * Read one current root result immediately after a successful step.
   * The returned value is valid only until the next step or disposal.
   */
  readResult(slot: number, layout: LayoutId): Value {
    this.assertLive();
    const spec = this.module.manifest.frames[0]?.locals[slot];
    if (spec === undefined) return fatal(`unknown root result slot ${slot}`);
    if (spec.layout !== layout) {
      return fatal(
        `root result slot ${slot} has layout ${spec.layout}, expected ${layout}`,
      );
    }
    const value = this.rootValues?.[slot];
    if (value === undefined) {
      return fatal(`root result slot ${slot} is unavailable before step`);
    }
    this.layouts.assertValue(layout, value, `root result slot ${slot}`);
    return value;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.heap.dispose();
  }

  private assertLive(): void {
    if (this.disposed) fatal('state-machine runtime is disposed');
  }
}
