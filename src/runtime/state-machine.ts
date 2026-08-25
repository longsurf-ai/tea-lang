// Purpose: Generic Effect state-machine algebra for Tea execution.

import type {Effect} from 'effect';
import type {Value} from './value';

// One synchronized set of external values presented to a state update.
export interface Input {
  readonly series: readonly Value[];
  readonly builtins: readonly Value[];
  readonly requests: readonly Value[];
}

// Committed Tea state. Every time-addressed binding owns an explicit RingState
// whose values are newest-first.
export interface State {
  readonly root: RootState;
}

export interface RingState {
  readonly values: readonly Value[];
}

export interface RootState extends FrameState {
  readonly series: readonly RingState[];
  readonly builtins: readonly RingState[];
  readonly requests: readonly RingState[];
}

export interface FrameState {
  readonly active: boolean;
  readonly locals: readonly LocalState[];
  readonly subs: readonly (FrameState | null)[];
}

export interface LocalState {
  readonly ring: RingState;
  readonly initialized: boolean;
}

// State with exactly one live copy across provisional and committed updates.
export interface Intermediate {
  readonly root: IntermediateFrame;
}

export interface IntermediateFrame {
  readonly active: boolean;
  readonly locals: readonly (IntermediateLocal | null)[];
  readonly subs: readonly (IntermediateFrame | null)[];
}

export interface IntermediateLocal {
  readonly value: Value;
  readonly initialized: boolean;
}

export interface Result<S, I, Y, E> {
  readonly state: S;
  readonly intermediate: I;
  readonly output: Y;
  readonly effects: readonly E[];
}

export type StateUpdate<S, I, X, Y, E, Err = never, R = never> = (
  state: Readonly<S>,
  intermediate: Readonly<I>,
  input: X,
) => Effect.Effect<Result<S, I, Y, E>, Err, R>;

export interface StateMachine<S, I, X, Y, E, Err = never, R = never> {
  readonly initialState: S;
  readonly initialIntermediate: I;
  readonly update: StateUpdate<S, I, X, Y, E, Err, R>;
}
