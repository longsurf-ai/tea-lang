// Purpose: Versioned, bind-independent physical contract shared by WGSL codegen and the WebGPU runtime.

import type {ParamSpec} from '../runtime/schema';

export const GPU_ARTIFACT_ABI_VERSION = 6 as const;
export const GPU_WORKGROUP_SIZE_OVERRIDE = 'tea_workgroup_size';

export const GPU_BUFFER_GROUP = 0;
export const GPU_EXTERNAL_BUFFER_BINDINGS = Object.freeze({
  jobs: 0,
  series: 1,
  executionStates: 2,
  results: 3,
  effectStatus: 4,
  effectRecords: 5,
  params: 6,
});

export const GPU_JOB_DESCRIPTOR_BYTE_STRIDE = 40;
export const GPU_JOB_DESCRIPTOR_OFFSETS = Object.freeze({
  seriesOffset: 0,
  rowCount: 4,
  resultOffset: 8,
  resultCount: 12,
  effectOffset: 16,
  effectCapacity: 20,
  chunkRows: 24,
  paramsOffset: 28,
  stateOffset: 32,
  stateWords: 36,
});

export const GPU_SERIES_SCALAR_BYTE_STRIDE = 4;
export const GPU_PARAMETER_BYTE_STRIDE = 4;
export const GPU_EXECUTION_STATE_MIN_BYTE_SIZE = 8;
export const GPU_RESULT_CELL_BYTE_STRIDE = 8;
export const GPU_EFFECT_STATUS_BYTE_STRIDE = 16;

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

export interface WgslBindingModule {
  readonly language: 'javascript-es2015-function-body';
  // The ordinary generated JSModule. GPU preparation loads it and calls the
  // same bind() method available to CPU hosts.
  readonly source: string;
}

export type WgslResultScalar = 'float' | 'int' | 'bool' | 'enum';

export interface WgslResultChannel {
  /** Index in the embedded module's one output declaration list. */
  readonly outputId: number;
  readonly scalar: WgslResultScalar;
  readonly rowCell: number;
}

/**
 * Physical scalar decoding instructions. Logical types and enum identities live
 * only in the Arrow schema; this codec says where WGSL wrote the value and its
 * validity flag. Reference structs remain unsupported by this backend.
 *
 * @example A float codec reads validity at byte 0 and f32 payload bits at byte 4;
 * the corresponding Arrow field is Float64 because Tea publishes JS numbers.
 */
export type WgslCodec =
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
    };

/**
 * Physical encoding of one append output. Its logical payload field belongs to
 * the embedded JavaScript module's Arrow schema, alongside every set output.
 * @example `event.outputId` addresses the same slot passed to runtime.append().
 */
export interface WgslEvent {
  readonly outputId: number;
  readonly payloadLayout: number;
  readonly payloadWordCount: number;
  readonly payload: WgslCodec;
}

export interface WgslStateLocalLayout {
  readonly name: string;
  // Slot in the generated JS frame table. WGSL may elide history-free
  // formals, so this is not necessarily the local's index below.
  readonly slot: number;
  readonly storage: 'perBar' | 'var';
  readonly scratchWordOffset: number;
  readonly valueWordCount: number;
  readonly committedInitWordOffset: number | null;
  readonly tentativeInitWordOffset: number | null;
  // Two fixed words containing the binding-specific history payload offset
  // (relative to the execution state) and capacity. Null means no retained
  // history exists for this local.
  readonly historyDescriptorWordOffset: number | null;
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
  readonly segments: readonly WgslCacheSegment[];
}

export interface CompiledWgslProgram {
  readonly abi: typeof GPU_ARTIFACT_ABI_VERSION;
  readonly target: 'webgpu-wgsl';
  readonly numeric: WgslNumericContract;
  readonly module: WgslModule;
  readonly bindingModule: WgslBindingModule;
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
    readonly paramsOffset: number;
    readonly stateOffset: number;
    readonly stateWords: number;
  };
  readonly parameterLayout: number;
  readonly parameterByteStride: number;
  readonly seriesScalarLayout: number;
  readonly seriesScalarByteStride: number;
  readonly executionStateLayout: number;
  // Header, frame activations, scratch, init flags, and history descriptors.
  // History payloads follow this fixed region and are sized per binding.
  readonly executionStateFixedByteSize: number;
  readonly state: {
    readonly initializedWordOffset: 0;
    readonly nextRowWordOffset: 1;
    readonly rootFrameWordOffset: 2;
    readonly fixedWordCount: number;
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
  readonly params: readonly ParamSpec[];
  readonly paramActive: readonly boolean[];
  readonly requiredSeries: readonly {readonly id: string}[];
  readonly resultChannels: readonly WgslResultChannel[];
  readonly events: readonly WgslEvent[];
}
