// Purpose: Bind-independent artifacts and diagnostics produced by the Tea Program to WGSL backend.

import type {EffectSpec, ParamSpec} from '../../runtime/abi';

export type WgslScalarType = 'i32' | 'u32' | 'f32';

export interface WgslNumericContract {
  readonly float: 'f32';
  readonly integer: 'i32';
  readonly boolean: 'u32-zero-or-one';
  readonly nullable: 'tagged-u32';
  readonly integerOverflow: 'wrap';
  readonly divideByZero: 'tea-na';
  readonly nonFiniteFloat: 'tea-na';
  readonly cpuTolerance: {
    readonly absolute: number;
    readonly relative: number;
  };
}

export interface WgslPhysicalField {
  readonly path: string;
  readonly scalar: WgslScalarType;
  readonly byteOffset: number;
}

export interface WgslPhysicalLayout {
  readonly id: number;
  readonly name: string;
  readonly byteSize: number;
  readonly byteAlignment: number;
  readonly fields: readonly WgslPhysicalField[];
}

export interface WgslModule {
  readonly language: 'wgsl';
  readonly source: string;
  readonly entryPoint: string;
}

export type WgslResultScalar = 'float' | 'int' | 'bool' | 'enum';

export type WgslManifestValue = number | string | boolean | null;

// Generic Program output metadata. `rowCell` is the fixed physical result
// slot; no application-specific execution identity enters this artifact.
export interface WgslResultChannel {
  readonly outputId: number;
  readonly effect: string;
  readonly channelName: string;
  readonly scalar: WgslResultScalar;
  readonly enumMembers: readonly string[] | null;
  readonly rowCell: number;
}

// Host-facing declaration metadata. `rowCell` is null for declaration-only
// outputs (for example, the strategy header); otherwise it points at the same
// physical cell published through `resultChannels`.
export interface WgslOutputChannelSchema {
  readonly name: string;
  readonly type: string;
  readonly transport:
    | {readonly kind: 'int' | 'float' | 'bool'}
    | {
        readonly kind: 'enum';
        readonly name: string;
        readonly members: readonly string[];
      };
  readonly rowCell: number | null;
}

export interface WgslOutputSchema {
  readonly outputId: number;
  readonly effect: string;
  readonly staticArgs: readonly {
    readonly name: string;
    readonly value: WgslManifestValue;
  }[];
  readonly channels: readonly WgslOutputChannelSchema[];
}

// Recursive logical shape paired with exact physical layout ids and offsets.
// The runtime can decode effect payloads without knowing Tea types or
// reproducing the WGSL layout algorithm.
export type WgslValueSchema =
  | {
      readonly kind: 'bool';
      readonly physicalLayout: number;
      readonly valueByteOffset: number;
    }
  | {
      readonly kind: 'int' | 'float' | 'string' | 'color';
      readonly physicalLayout: number;
      readonly validByteOffset: number;
      readonly valueByteOffset: number;
    }
  | {
      readonly kind: 'enum';
      readonly physicalLayout: number;
      readonly validByteOffset: number;
      readonly ordinalByteOffset: number;
      readonly name: string;
      readonly typeId: string;
      readonly members: readonly string[];
    }
  | {
      readonly kind: 'user-type';
      readonly physicalLayout: number;
      readonly validByteOffset: number;
      readonly name: string;
      readonly typeId: string;
      readonly fields: readonly {
        readonly name: string;
        readonly byteOffset: number;
        readonly value: WgslValueSchema;
      }[];
    };

export interface WgslEffectSchema {
  readonly effectId: number;
  readonly payloadLayout: number;
  readonly payloadWordCount: number;
  readonly payload: WgslValueSchema;
  readonly declaration: EffectSpec;
}

export interface WgslStateLocalLayout {
  readonly name: string;
  readonly storage: 'perBar' | 'var';
  readonly scratchWordOffset: number;
  readonly valueWordCount: number;
  readonly committedInitWordOffset: number | null;
  readonly tentativeInitWordOffset: number | null;
  readonly historyWordOffset: number | null;
  readonly historyCapacity: number;
}

export interface WgslStateFrameLayout {
  readonly id: number;
  readonly owner: string;
  readonly committedActivationWordOffset: number;
  readonly tentativeActivationWordOffset: number;
  readonly activationEncoding: 'absolute-row-plus-one';
  readonly wordCount: number;
  readonly locals: readonly WgslStateLocalLayout[];
  readonly children: readonly {
    readonly slot: number;
    readonly templateId: number;
    readonly wordOffset: number;
  }[];
}

export interface WgslOverrideSpec {
  readonly numericId: number;
  readonly id: string;
  readonly defaultValue: number;
}

export interface WgslCacheSegment {
  readonly id: string;
  readonly rank: number;
  readonly owner: string;
  readonly kind: 'header' | 'activation' | 'local';
  readonly storageWordOffset: number;
  readonly cacheWordOffset: number;
  readonly wordCount: number;
  readonly cacheEnd: number;
  readonly estimatedReadsPerRow: number;
  readonly estimatedWritesPerRow: number;
}

export interface WgslCacheContract {
  readonly storageEntryPoint: string;
  readonly cachedEntryPoint: string;
  readonly overrides: {
    readonly workgroupSize: WgslOverrideSpec;
    readonly cacheWordsPerExecution: WgslOverrideSpec;
    readonly cacheAllocationWords: WgslOverrideSpec;
  };
  // Runtime selects only a complete ranked prefix. Physical storage offsets
  // may be discontiguous; scratch/init/history for one local move together.
  readonly segments: readonly WgslCacheSegment[];
}

export interface CompiledWgslProgram {
  readonly target: 'webgpu-wgsl';
  readonly numeric: WgslNumericContract;
  readonly module: WgslModule;
  readonly layouts: readonly WgslPhysicalLayout[];
  readonly workgroupSize: readonly [number, number, number];
  readonly externalBuffers: {
    readonly group: number;
    readonly jobsBinding: number;
    readonly seriesBinding: number;
    readonly executionStatesBinding: number;
    readonly resultsBinding: number;
    readonly effectStatusBinding: number;
    readonly effectRecordsBinding: number;
    readonly paramsBinding: number;
  };
  readonly jobDescriptorLayout: number;
  readonly jobDescriptorByteStride: number;
  readonly jobDescriptorOffsets: {
    readonly seriesOffset: number;
    readonly rowCount: number;
    readonly resultOffset: number;
    readonly resultCount: number;
    readonly effectOffset: number;
    readonly effectCapacity: number;
    readonly chunkRows: number;
    // Param-slot offset into the external per-binding parameter buffer.
    readonly paramsOffset: number;
  };
  readonly parameterLayout: number;
  readonly parameterByteStride: number;
  readonly seriesScalarLayout: number;
  readonly seriesScalarByteStride: number;
  readonly executionStateLayout: number;
  readonly executionStateByteStride: number;
  readonly state: {
    readonly initializedWordOffset: 0;
    readonly nextRowWordOffset: 1;
    readonly rootFrameWordOffset: 2;
    readonly wordsPerExecution: number;
    readonly frames: readonly WgslStateFrameLayout[];
  };
  readonly cache: WgslCacheContract;
  readonly resultCellLayout: number;
  readonly resultCellByteStride: number;
  readonly effectStatusLayout: number;
  readonly effectStatusByteStride: number;
  readonly effectRecordLayout: number;
  readonly effectRecordByteStride: number;
  readonly effectPayloadWordCapacity: number;
  readonly maxEffectsPerRow: number;
  readonly literalStrings: readonly string[];
  // The backend-neutral binding schema, in pid order. Each execution
  // carries one fixed-width slot for every entry.
  readonly params: readonly ParamSpec[];
  readonly paramActive: readonly boolean[];
  readonly requiredSeries: readonly {readonly id: string}[];
  readonly resultChannels: readonly WgslResultChannel[];
  readonly outputSchemas: readonly WgslOutputSchema[];
  readonly effectSchemas: readonly WgslEffectSchema[];
}

export type WgslEligibilityPhase =
  | 'semantic-contract'
  | 'physical-layout'
  | 'host-plan'
  | 'wgsl-emission';

export type WgslEligibilityIssueCode =
  | 'numeric-contract-unresolved'
  | 'nullable-value-layout-unimplemented'
  | 'user-value-layout-unimplemented'
  | 'enum-layout-unimplemented'
  | 'tuple-layout-unimplemented'
  | 'collection-layout-unimplemented'
  | 'host-value-type-unsupported'
  | 'series-row-count-unavailable'
  | 'parameter-packing-unimplemented'
  | 'request-execution-unimplemented'
  | 'bind-stage-unimplemented'
  | 'history-layout-unimplemented'
  | 'execution-input-mapping-unimplemented'
  | 'persistent-state-initialization-unimplemented'
  | 'function-frame-lowering-unimplemented'
  | 'method-frame-lowering-unimplemented'
  | 'mutable-method-copyout-unimplemented'
  | 'native-call-lowering-unimplemented'
  | 'aggregate-operation-lowering-unimplemented'
  | 'tuple-operation-lowering-unimplemented'
  | 'collection-operation-lowering-unimplemented'
  | 'loop-lowering-unimplemented'
  | 'result-transport-lowering-unimplemented'
  | 'effect-transport-lowering-unimplemented'
  | 'wgsl-emitter-unimplemented';

export interface WgslSourceLocation {
  readonly filename: string;
  readonly line: number;
  readonly column: number;
}

export interface WgslEligibilityIssue {
  readonly code: WgslEligibilityIssueCode;
  readonly phase: WgslEligibilityPhase;
  readonly message: string;
  readonly occurrences: number;
  readonly firstLocation: WgslSourceLocation | null;
}

export interface WgslProgramInventory {
  readonly parameterCount: number;
  readonly requestCount: number;
  readonly seriesInputCount: number;
  readonly executionInputCount: number;
  readonly persistentRootCount: number;
  readonly functionCount: number;
  readonly mutableMethodCount: number;
  readonly callSiteSlotCount: number;
  readonly outputCount: number;
  readonly resultChannelCount: number;
}

export interface WgslEligibilityReport {
  readonly eligible: boolean;
  readonly inventory: WgslProgramInventory;
  readonly issues: readonly WgslEligibilityIssue[];
}

export type WgslCompilationResult =
  | {
      readonly status: 'staged-unsupported';
      readonly eligibility: WgslEligibilityReport;
      readonly artifact: null;
    }
  | {
      readonly status: 'compiled';
      readonly eligibility: WgslEligibilityReport & {readonly eligible: true};
      readonly artifact: CompiledWgslProgram;
    };
