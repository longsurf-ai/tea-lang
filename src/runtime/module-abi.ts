// Purpose: Versioned recursive JSModule, pure binding data, and execution-only Runtime contracts.

import type {BuiltinSource} from '../ir/builtin';
import type {NameStorage} from '../ir/node';
import type {Ref} from './heap';
import type {OutputSpec} from './output';
import type {EffectSpec, ParamSpec} from './schema';
import type {AggregateLayoutManifest, LayoutId} from './value-layout';
import type {CollectionValue, ExecutionResult, Value} from './value';

export const RUNTIME_ABI_VERSION = 3 as const;

export type DepthSpec =
  | {readonly kind: 'none'}
  | {readonly kind: 'const'; readonly bars: number}
  | {readonly kind: 'bound'}
  | {readonly kind: 'capped'; readonly bars: number};

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
  readonly source: BuiltinSource;
  readonly layout: LayoutId;
  readonly depth: DepthSpec;
}

export interface EffectManifestSpec {
  readonly layout: LayoutId;
  readonly declaration: EffectSpec;
}

export interface RequestSpec {
  readonly merge: {readonly mode: 'sample'};
  readonly depth: DepthSpec;
  readonly resultSlot: number;
  readonly layout: LayoutId;
  readonly dynamic: boolean;
}

export interface ModuleManifest {
  readonly series: readonly SeriesSpec[];
  readonly builtin: readonly BuiltinSpec[];
  readonly params: readonly ParamSpec[];
  readonly outputs: readonly OutputSpec[];
  readonly effects: readonly EffectManifestSpec[];
  readonly frames: readonly FrameLayout[];
  readonly requests: readonly RequestSpec[];
}

export interface Frame {
  readonly kind: 'frame';
}

/** One self-describing generated JavaScript module in the request tree. */
export interface JSModule {
  readonly abi: typeof RUNTIME_ABI_VERSION;
  /** Shared by every module in one generated request tree. */
  readonly aggregateLayouts: AggregateLayoutManifest;
  readonly manifest: ModuleManifest;
  readonly requests: readonly JSModule[];
  /** Evaluate this module's bind-time values without acquiring runtime state. */
  bind(values: {
    /** The compilation-global parameter vector, including for request children. */
    readonly params: readonly Value[];
    /** Sparse context-constant builtins visible to provider-aware binding. */
    readonly builtins?: ReadonlyMap<number, Value>;
  }): JSModuleBinding;
  readonly funcs: Readonly<
    Record<
      number,
      (rt: Runtime, fr: Frame, ...args: Value[]) => ExecutionResult
    >
  >;
  main(rt: Runtime, fr: Frame): void;
}

/** Immutable data produced by one generated module's pure binding function. */
export interface JSModuleBinding {
  readonly retention: {
    readonly frames: readonly (readonly number[])[];
    readonly series: readonly number[];
    readonly builtins: readonly number[];
    readonly requests: readonly number[];
  };
  readonly activeParams: readonly boolean[];
  readonly outputs: readonly (readonly {
    readonly name: string;
    readonly value: Value;
  }[])[];
  readonly requests: readonly {
    readonly symbol: string;
    readonly timeframe: string;
    readonly gaps: boolean;
    readonly lookahead: boolean;
    readonly ignoreInvalidSymbol: boolean;
    readonly calcBarsCount: number;
  }[];
}

/** Generated per-row execution operations. Runtime always means execution. */
export interface Runtime {
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
  emitEffect(effectId: number, payload: Value): void;
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
  readonly result: ExecutionResult;
}

export type CollectionEntries =
  | readonly Value[]
  | readonly (readonly [Value, Value])[];
