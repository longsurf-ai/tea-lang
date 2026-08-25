// Purpose: Versioned recursive JSModule, pure binding data, and the generated
// execution RuntimeContext contract.

import type {BuiltinSource} from '../ir/builtin';
import type {NameStorage} from '../ir/node';
import type {Ref} from './heap';
import type {OutputSpec} from './output';
import type {EffectSpec, ParamSpec} from './schema';
import type {LayoutId, ValueLayout} from './value-layout';
import type {
  CollectionValue,
  ExecutionResult,
  ManifestValue,
  Value,
} from './value';

export const RUNTIME_ABI_VERSION = 6 as const;

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
  /** Whether the host has supplied this execution context's source series. */
  readonly supplied?: boolean;
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
  /** Concrete static request configuration, or null until concretization. */
  readonly context?: {
    readonly symbol: string;
    readonly timeframe: string;
    readonly gaps: boolean;
    readonly lookahead: boolean;
    readonly ignoreInvalidSymbol: boolean;
    readonly calcBarsCount: number;
  } | null;
}

export interface ModuleManifest {
  readonly series: readonly SeriesSpec[];
  readonly builtin: readonly BuiltinSpec[];
  readonly params: readonly (ParamSpec & {
    /** True only where the host binds this compilation-global parameter. */
    readonly bindable?: boolean;
    /** Current host-bound value; absent on an incomplete module snapshot. */
    readonly value?: ManifestValue;
    /** Null until a parameter-dependent activity expression resolves. */
    readonly active?: boolean | null;
  })[];
  readonly outputs: readonly (OutputSpec & {
    /** Concrete declaration arguments, or null until concretization. */
    readonly boundArgs?:
      | readonly {
          readonly name: string;
          readonly value: Value;
        }[]
      | null;
  })[];
  readonly effects: readonly EffectManifestSpec[];
  readonly frames: readonly FrameLayout[];
  readonly requests: readonly RequestSpec[];
}

export interface Frame {
  readonly kind: 'frame';
}

/** One binding state derived from the concrete manifest. */
export type ModuleBinding =
  | {
      readonly kind: 'series';
      readonly name: string;
      readonly supplied: boolean;
    }
  | {
      readonly kind: 'parameter';
      readonly name: string;
      readonly value?: ManifestValue;
    };

/** One self-describing generated JavaScript module in the request tree. */
export interface JSModule {
  readonly abi: typeof RUNTIME_ABI_VERSION;
  /** Shared value-layout table for every module in one generated request tree. */
  readonly layout: readonly ValueLayout[];
  readonly manifest: ModuleManifest;
  readonly requests: readonly JSModule[];
  /** True when this module context's manifest is concrete and fully supplied. */
  ready(): boolean;
  /** Missing bindings derived from this module context's manifest. */
  remaining(): readonly ModuleBinding[];
  /** Mutate only the caller-owned fresh manifest copy with late concrete facts. */
  concretize(
    manifest: ModuleManifest,
    contextConstants?: ReadonlyMap<number, Value>,
  ): void;
  readonly funcs: Readonly<
    Record<
      number,
      (ctx: RuntimeContext, fr: Frame, ...args: Value[]) => ExecutionResult
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
