// Purpose: WGSL compiler diagnostics. The versioned physical artifact contract
// is neutral and shared with the runtime through gpu/contract.

export * from '../../gpu/contract';
import type {CompiledWgslProgram} from '../../gpu/contract';

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
