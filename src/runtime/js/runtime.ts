// Purpose: State-owning JavaScript execution facade over the explicit Tea
// StateMachine transition.

import {Effect} from 'effect';
import {fatal} from '../../base/print';
import type {JSModule} from '../module-abi';
import type {EffectEmission, DenseEmission} from '../output';
import {ArenaHeap, isRef, type HeapLimits} from './heap';
import type {ExecutionError} from '../errors';
import type {Intermediate, State, StepInput} from './state-machine';
import {stateMachine, type TeaStateMachine} from './state-update';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  isResourceHandle,
  isTupleValue,
  type EffectValue,
  type Value,
} from '../value';
import {type LayoutId, ValueLayoutRegistry} from '../value-layout';

export interface JSRuntimeOptions {
  readonly heapLimits?: Partial<HeapLimits>;
  readonly maxCollectionElements?: number;
}

export type {StepInput} from './state-machine';

/** The externally observable product of one completed runtime step. */
export interface StepResult {
  readonly output: readonly DenseEmission[];
  readonly effects: readonly EffectEmission[];
  readonly provisional: boolean;
  toDatum(): Readonly<Record<string, unknown>>;
}

function datumValue(value: Value | EffectValue): unknown {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if ('kind' in value && value.kind === 'struct') {
    return Object.freeze({
      kind: 'struct',
      fields: Object.freeze(value.fields.map(datumValue)),
    });
  }
  if (isTupleValue(value)) {
    return Object.freeze(value.map(datumValue));
  }
  if (
    isRef(value) ||
    isArrayValue(value) ||
    isMatrixValue(value) ||
    isMapValue(value)
  ) {
    throw new TypeError(
      'StepResult.toDatum cannot serialize Heap-backed values',
    );
  }
  if (isResourceHandle(value)) return Object.freeze({...value});
  return fatal('unknown StepResult datum value');
}

function createStepResult(
  outputs: readonly DenseEmission[],
  effects: readonly EffectEmission[],
  provisional: boolean,
  declarations: JSModule['manifest']['outputs'],
): StepResult {
  let datum: Readonly<Record<string, unknown>> | null = null;
  return {
    output: outputs,
    effects,
    provisional,
    toDatum() {
      if (datum !== null) return datum;
      const emitted = new Map(outputs.map(output => [output.outputId, output]));
      const columns: Record<string, unknown> = {};
      declarations.forEach((declaration, outputId) => {
        const channels = declaration.channels;
        if (channels.length === 0) return;
        const output = emitted.get(outputId);
        if (output === undefined) {
          columns[`output_${outputId}`] = null;
          return;
        }
        if (output.channels.length !== channels.length) {
          return fatal(
            `output ${outputId} channel count disagrees with manifest`,
          );
        }
        columns[`output_${outputId}`] =
          channels.length === 1
            ? datumValue(output.channels[0]!)
            : Object.freeze(
                Object.fromEntries(
                  channels.map((channel, index) => [
                    channel.name,
                    datumValue(output.channels[index]!),
                  ]),
                ),
              );
      });
      columns.effects = Object.freeze(
        effects.map(effect =>
          Object.freeze({
            effectId: effect.effectId,
            payload: datumValue(effect.payload),
          }),
        ),
      );
      columns.provisional = provisional;
      datum = Object.freeze(columns);
      return datum;
    },
  };
}

/**
 * Owns all mutable resources and current state for step-based Tea execution.
 * Callers provide only synchronized inputs; State, Intermediate, and Heap
 * never cross this boundary.
 */
export class JSRuntime {
  private readonly heap: ArenaHeap;
  private readonly machine: TeaStateMachine;
  private readonly layouts: ValueLayoutRegistry;
  private state: State;
  private intermediate: Intermediate;
  private rootValues: readonly Value[] | null = null;
  private disposed = false;

  constructor(
    private readonly module: JSModule,
    options: JSRuntimeOptions = {},
  ) {
    if (!module.ready()) {
      fatal('JSRuntime requires a ready JSModule');
    }
    this.layouts = new ValueLayoutRegistry(module.layout);
    this.heap = new ArenaHeap(options.heapLimits);
    this.machine = stateMachine(
      module,
      this.layouts,
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
          this.rootValues = result.rootValues;
          this.intermediate = result.intermediate;
          if (!input.provisional) {
            this.state = result.state;
          }
          return createStepResult(
            result.output,
            result.effects,
            input.provisional,
            this.module.manifest.outputs,
          );
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
