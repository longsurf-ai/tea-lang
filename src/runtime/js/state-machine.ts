// Purpose: Generic Effect state-machine algebra for Tea execution.

import type {Effect} from 'effect';
import type {Value} from '../value';

/** One synchronized external update passed to JSRuntime.step(). */
export interface StepInput {
  readonly series: readonly Value[];
  readonly builtins: readonly Value[];
  readonly requests: readonly Value[];
  readonly provisional: boolean;
}

// Committed Tea state. Every time-addressed binding owns explicit newest-first
// history.
export interface State {
  readonly root: RootState;
}

export interface HistoryState {
  readonly values: readonly Value[];
}

export interface RootState extends FrameState {
  readonly series: readonly HistoryState[];
  readonly builtins: readonly HistoryState[];
  readonly requests: readonly HistoryState[];
}

export interface FrameState {
  readonly active: boolean;
  readonly locals: readonly LocalState[];
  readonly subs: readonly (FrameState | null)[];
}

export interface LocalState {
  readonly history: HistoryState;
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

export interface StateUpdateResult<S, I, Y, E> {
  readonly state: S;
  readonly intermediate: I;
  /** Ephemeral current root-slot values, valid until the owner's next step. */
  readonly rootValues: readonly Value[];
  readonly output: Y;
  readonly effects: readonly E[];
}

export type StateUpdate<S, I, X, Y, E, Err = never, R = never> = (
  state: Readonly<S>,
  intermediate: Readonly<I>,
  input: X,
) => Effect.Effect<StateUpdateResult<S, I, Y, E>, Err, R>;

export interface StateMachine<S, I, X, Y, E, Err = never, R = never> {
  readonly initialState: S;
  readonly initialIntermediate: I;
  readonly update: StateUpdate<S, I, X, Y, E, Err, R>;
}
