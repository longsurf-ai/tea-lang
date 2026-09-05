// Purpose: Versioned recursive JSModule, binding data, and the generated
// execution RuntimeContext contract.

import type {Schema} from 'apache-arrow';
import type {BuiltinSource} from '../ir/builtin';
import type {NameStorage} from '../ir/node';
import type {Ref} from './js/heap';
import type {OutputSpec} from './output';
import type {ParamSpec} from './schema';
import type {LayoutId, ValueLayout} from './value-layout';
import type {CollectionValue, Scalar, Value} from './value';

export const RUNTIME_ABI_VERSION = 10 as const;

/** True when a value can address or retain committed history. */
export function isHistoryOffset(offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0;
}

export type DepthSpec =
  | {readonly kind: 'none'} // no depth retention
  | {readonly kind: 'const'; readonly bars: number} // depth known at compile time
  | {readonly kind: 'bound'} // depth known at binding time
  | {readonly kind: 'capped'; readonly bars: number}; // depth unknown, capped at compile time

export interface LocalSpec {
  readonly storage: NameStorage;
  readonly depth: DepthSpec;
  readonly layout: LayoutId;
}

export interface FrameLayout {
  readonly locals: readonly LocalSpec[];
  readonly subs: readonly {readonly fid: number}[];
}

export interface SeriesSpec {
  readonly id: string | null;
  readonly depth: DepthSpec;
}

export interface BuiltinSpec {
  /** Whether this source can supply a fixed binding-time scalar. */
  readonly constant: boolean;
  /** Fixed value supplied through module.bind, never per-step state. */
  readonly value?: Scalar;
  readonly source: BuiltinSource;
  readonly layout: LayoutId;
  readonly depth: DepthSpec;
}

export interface RequestSpec {
  /** Executable child beside its context and synchronization requirements. */
  readonly module: JSModule;
  readonly name: string;
  readonly mode: 'sample' | 'collect';
  readonly depth: DepthSpec;
  readonly resultSlot: number;
  readonly resultLayout: LayoutId;
  readonly layout: LayoutId;
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

export interface Frame {
  readonly kind: 'frame';
}

/**
 * One compiled module with mutable configuration. Code and requirements live
 * together; live frames, history and Heap belong to JSRuntime. Binding updates
 * this module and its request children in place, without subscribing to streams.
 *
 * @example
 * ```ts
 * module.bind({length: 20, enabled: false});
 * module.bind({length: 40});
 * // The same module now has length=40 and still has enabled=false.
 * ```
 */
export interface JSModule {
  readonly abi: typeof RUNTIME_ABI_VERSION;
  readonly inputs: {
    readonly schema: Schema;
    readonly series: readonly SeriesSpec[];
    readonly builtins: readonly BuiltinSpec[];
  };
  readonly parameters: readonly (ParamSpec & {
    readonly value?: Scalar;
    readonly active: boolean | null;
  })[];
  /** Static storage descriptions, not live execution state. */
  readonly state: {
    readonly layout: readonly ValueLayout[];
    readonly frames: readonly FrameLayout[];
  };
  /** The schema is the sole owner of output fields, names and write modes. */
  readonly outputs: {
    readonly schema: Schema;
    readonly declarations: readonly OutputSpec[];
  };
  readonly requests: readonly RequestSpec[];
  /**
   * Validate a parameter patch, fill still-unset defaults, and resolve dependent
   * requirements. Fixed context values are private to this module's context;
   * children retain their own values while inheriting parameter changes.
   * Returns this same module. Failure leaves the whole tree unchanged; binding
   * is closed once execution starts. Clone the module for an independent run.
   * @example `module.bind({length: 10})` resolves close[length] retention to 10.
   */
  bind(
    values?: Readonly<Record<string, unknown>>,
    context?: ReadonlyMap<number, Scalar>,
  ): JSModule;
  /** Configuration completeness only; Node checks connected streams separately. */
  ready(): boolean;
  /** Names of parameters without a usable default or supplied value. */
  remaining(): readonly string[];
  readonly funcs: Readonly<
    Record<
      number,
      (ctx: RuntimeContext, fr: Frame, ...args: Value[]) => Value | undefined
    >
  >;
  main(ctx: RuntimeContext, fr: Frame): void;
}

/** Operations available to generated code during one runtime step. */
export interface RuntimeContext {
  series(sid: number, offset: number): number;
  builtin(bid: number, offset: number): Value;
  param(pid: number): Value;
  read(fr: Frame, slot: number, offset: number): Value;
  write(fr: Frame, slot: number, v: Value): void;
  needsInit(fr: Frame, slot: number): boolean;
  initialize(fr: Frame, slot: number, v: Value): void;
  request(rid: number, offset: number): Value;
  frame(fr: Frame, slot: number): Frame;
  root(): Frame;
  emit(oid: number, channel: number, v: Value): void;
  append(outputId: number, payload: Value): void;
  newStruct(layout: LayoutId, fields: readonly Value[]): Ref<unknown>;
  requireStruct(value: Value, layout: LayoutId): Ref<unknown>;
  structField(value: Value, ownerLayout: LayoutId, index: number): Value;
  storeStructField(
    value: Value,
    ownerLayout: LayoutId,
    index: number,
    replacement: Value,
  ): void;
  callCollection(
    operation: CollectionOperation,
    resultLayout: LayoutId,
    args: readonly Value[],
  ): Value;
  mutateCollection(
    operation: CollectionMutationOperation,
    collectionLayout: LayoutId,
    receiver: Value,
    args: readonly Value[],
  ): CollectionMutation;
  collectionEntries(value: Value): CollectionEntries;
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
  readonly result: Value | undefined;
}

export type CollectionEntries =
  | readonly Value[]
  | readonly (readonly [Value, Value])[];
