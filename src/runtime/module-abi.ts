// Purpose: Versioned recursive Module, binding data, and the generated
// typed Context execution contract.

import type {BuiltinSource} from '../ir/builtin';
import type {Storage} from '../ir/type';
import type {Module} from './module-binding';
import type {CollectionValue, Scalar} from './value';
import type {Value} from './js/value';

export const RUNTIME_ABI_VERSION = 13 as const;

/** True when a value can address or retain committed history. */
export function isHistoryOffset(offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0;
}

/**
 * Required history for one binding. A bound depth is unresolved until bind()
 * evaluates parameters; a capped depth limits a dynamic history expression.
 * @example `{kind: 'const', bars: 2}` retains the previous two accepted rows.
 */
export type Depth =
  | {readonly kind: 'none'} // no depth retention
  | {readonly kind: 'const'; readonly bars: number} // depth known at compile time
  | {readonly kind: 'bound'} // depth known at binding time
  | {readonly kind: 'capped'; readonly bars: number}; // depth unknown, capped at compile time

/**
 * Static bindings and written calls for the root or one function. Array indices
 * are local slots and call slots; a child's fid indexes Module.state.frames.
 * Context gives separate written calls independent state and histories, even
 * when both use the same Frame definition.
 * @example Two entries `{name: 'left', fid: 1}` and `{name: 'right', fid: 1}`
 * invoke the same accumulator with independent totals. Frame 0 is the root.
 */
export interface Frame {
  readonly locals: readonly {
    readonly name?: string;
    readonly storage: Storage;
    readonly depth: Depth;
    /** Captured missing value; supplies the binding's semantics without a type ID. */
    readonly empty: Value<unknown>;
  }[];
  readonly subs: readonly {readonly name?: string; readonly fid: number}[];
}

/**
 * A language-provided input and its retention requirement. Node supplies row
 * values; bind() may supply constant contextual values. Missing history uses
 * empty, preserving false, null and numeric NaN as different value domains.
 * @example `timeframe.multiplier` can be fixed during binding; `barstate.islast`
 * changes with the row and is delivered by Node.
 */
export interface Builtin {
  /** Whether this source can supply a fixed binding-time scalar. */
  readonly constant: boolean;
  /** Fixed value supplied through module.bind, never per-step state. */
  readonly value?: Scalar;
  readonly source: BuiltinSource;
  readonly empty: Value<unknown>;
  readonly depth: Depth;
}

/**
 * One independently executed child and the parent's synchronization contract.
 * Binding configures its child Module; Node owns the child Context and delivers
 * copied results before the parent runs. Heap references never cross this edge.
 * @example A collect request has a float resultEmpty and an array<float> empty;
 * the child returns floats and the parent reads a materialized array.
 */
export interface Request {
  /** Executable child beside its context and synchronization requirements. */
  readonly module: Module;
  readonly name: string;
  readonly mode: 'sample' | 'collect';
  readonly depth: Depth;
  readonly resultSlot: number;
  /** Missing value of the expression evaluated by the child. */
  readonly resultEmpty: Value<unknown>;
  /** Missing value seen by the parent; a collection for collect requests. */
  readonly empty: Value<unknown>;
  /** Concrete static request configuration, or null until binding. */
  readonly context?: {
    readonly symbol: string;
    readonly timeframe: string;
    readonly availability: 'start' | 'end';
    readonly fill: 'carry' | 'sparse';
    readonly ignoreInvalidSymbol: boolean;
    readonly calcBarsCount: number;
  } | null;
}

export type CollectionOperation =
  | 'array.new'
  | 'array.from'
  | 'array.size'
  | 'array.is_empty'
  | 'array.get'
  | 'array.first'
  | 'array.last'
  | 'array.copy'
  | 'matrix.new'
  | 'matrix.rows'
  | 'matrix.columns'
  | 'matrix.elements_count'
  | 'matrix.get'
  | 'matrix.row'
  | 'matrix.column'
  | 'matrix.copy'
  | 'map.new'
  | 'map.size'
  | 'map.is_empty'
  | 'map.contains'
  | 'map.get'
  | 'map.keys'
  | 'map.values'
  | 'map.copy';

export type CollectionMutationOperation =
  | 'array.set'
  | 'array.push'
  | 'array.pop'
  | 'array.clear'
  | 'matrix.set'
  | 'matrix.fill'
  | 'map.put'
  | 'map.remove'
  | 'map.clear';

export interface CollectionMutation {
  readonly replacement: CollectionValue;
  readonly result: Value<unknown> | undefined;
}

export type CollectionEntries =
  | readonly Value<unknown>[]
  | readonly (readonly [Value<unknown>, Value<unknown>])[];
