// Purpose: Versioned recursive Module, binding data, and the generated
// typed Context execution contract.

import type {BuiltinSource} from '../ir/builtin';
import type {Storage} from '../ir/type';
import type {Module} from './module-binding';
import type {CollectionValue, Scalar, Stored} from './value';

export const RUNTIME_ABI_VERSION = 12 as const;

/** True when a value can address or retain committed history. */
export function isHistoryOffset(offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0;
}

export type Depth =
  | {readonly kind: 'none'} // no depth retention
  | {readonly kind: 'const'; readonly bars: number} // depth known at compile time
  | {readonly kind: 'bound'} // depth known at binding time
  | {readonly kind: 'capped'; readonly bars: number}; // depth unknown, capped at compile time

/** Templates describe local storage and written call sites, not live frames. */
export interface FrameLayout {
  readonly locals: readonly {
    readonly name?: string;
    readonly storage: Storage;
    readonly depth: Depth;
    readonly layout: number;
  }[];
  readonly subs: readonly {readonly name?: string; readonly fid: number}[];
}

export interface Builtin {
  /** Whether this source can supply a fixed binding-time scalar. */
  readonly constant: boolean;
  /** Fixed value supplied through module.bind, never per-step state. */
  readonly value?: Scalar;
  readonly source: BuiltinSource;
  readonly layout: number;
  readonly depth: Depth;
}

export interface Request {
  /** Executable child beside its context and synchronization requirements. */
  readonly module: Module;
  readonly name: string;
  readonly mode: 'sample' | 'collect';
  readonly depth: Depth;
  readonly resultSlot: number;
  readonly resultLayout: number;
  readonly layout: number;
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
  readonly result: Stored | undefined;
}

export type CollectionEntries =
  | readonly Stored[]
  | readonly (readonly [Stored, Stored])[];
