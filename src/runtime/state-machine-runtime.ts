// Purpose: State-owning execution facade over the explicit Tea StateMachine
// transition. This is the migration target that will replace the legacy
// JSRuntime once its callers have moved to step-based execution.

import {Effect} from 'effect';
import {fatal} from '../base/print';
import type {ModuleCode} from './module-abi';
import type {EffectEmission, DenseEmission} from './output';
import {HeapArena, type HeapLimits} from './heap';
import type {ExecutionError} from './errors';
import type {Input, Intermediate, State} from './state-machine';
import {stateMachine, type TeaStateMachine} from './state-update';
import type {Value} from './value';
import type {ValueLayoutRegistry} from './value-layout';

export interface StateMachineRuntimeOptions {
  readonly heapLimits?: Partial<HeapLimits>;
  readonly maxCollectionElements?: number;
}

/**
 * One synchronized input update and its finality.
 *
 * Provisional steps replace only the runtime's Intermediate value. Final
 * steps replace both State and Intermediate.
 */
export interface StepInput extends Input {
  readonly provisional: boolean;
}

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
export class StateMachineRuntime {
  private readonly heap: HeapArena;
  private readonly machine: TeaStateMachine;
  private state: State;
  private intermediate: Intermediate;
  private disposed = false;

  constructor(
    module: ModuleCode,
    params: readonly Value[],
    layouts: ValueLayoutRegistry,
    options: StateMachineRuntimeOptions = {},
  ) {
    this.heap = new HeapArena(options.heapLimits);
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

  step(input: StepInput): Effect.Effect<StepResult, ExecutionError> {
    return Effect.suspend(() => {
      this.assertLive();
      return Effect.map(
        this.machine.update(this.state, this.intermediate, input),
        result => {
          this.intermediate = result.intermediate;
          if (!input.provisional) {
            this.state = result.state;
          }
          return {
            output: result.output,
            effects: result.effects,
            provisional: input.provisional,
          };
        },
      );
    });
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
