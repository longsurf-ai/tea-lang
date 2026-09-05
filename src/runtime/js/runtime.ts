// Purpose: State-owning JavaScript execution facade over the explicit Tea
// StateMachine transition.

import {Effect} from 'effect';
import {fatal} from '../../base/print';
import {initializeModuleTree} from '../module-binding';
import type {JSModule} from '../module-abi';
import type {EffectEmission, DenseEmission} from '../output';
import {ArenaHeap} from './heap';
import type {ExecutionError} from '../errors';
import type {Intermediate, State, StepInput} from './state-machine';
import {stateMachine, type TeaStateMachine} from './state-update';
import type {Value} from '../value';
import {type LayoutId, ValueLayoutRegistry} from '../value-layout';

export type {StepInput} from './state-machine';

/** The externally observable product of one completed runtime step. */
export interface StepResult {
  readonly outputs: readonly DenseEmission[];
  readonly effects: readonly EffectEmission[];
  readonly provisional: boolean;
}

/**
 * Owns all mutable resources and current state for step-based Tea execution.
 * Callers provide only synchronized inputs; State, Intermediate, and Heap
 * never cross this boundary.
 *
 * @example `new JSRuntime(readyModule)` captures its own schemas; changing the
 * caller's module metadata afterwards cannot alter this execution.
 */
export class JSRuntime {
  private readonly heap: ArenaHeap;
  private readonly machine: TeaStateMachine;
  private readonly layouts: ValueLayoutRegistry;
  private state: State;
  private intermediate: Intermediate;
  private rootValues: readonly Value[] | null = null;
  private disposed = false;

  constructor(private readonly module: JSModule) {
    module = initializeModuleTree(module);
    this.module = module;
    if (!module.ready()) {
      fatal('JSRuntime requires a ready JSModule');
    }
    this.layouts = new ValueLayoutRegistry(module.layout);
    this.heap = new ArenaHeap();
    this.machine = stateMachine(module, this.layouts, this.heap);
    this.state = this.machine.initialState;
    this.intermediate = this.machine.initialIntermediate;
  }

  /**
   * Evaluate one update and return detached emissions. Failure keeps the last
   * successful state; successful provisional updates retain the existing Tea
   * same-index and Heap semantics without advancing committed history.
   *
   * @example For a ready `plot(close)` module, running
   * `step({series: [10], builtins: [], requests: [], provisional: false})`
   * with Effect.runSync produces a channel value of 10.
   */
  step(input: StepInput): Effect.Effect<StepResult, ExecutionError> {
    return Effect.suspend(() => {
      this.assertLive();
      return Effect.map(
        this.machine.update(this.state, this.intermediate, input),
        result => {
          this.rootValues = result.rootValues;
          this.intermediate = result.intermediate;
          if (!input.provisional) {
            this.state = result.state;
          }
          return {
            outputs: result.output,
            effects: result.effects,
            provisional: input.provisional,
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
