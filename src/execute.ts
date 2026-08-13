// Purpose: Public target-neutral orchestration from one checked Program to ordered CPU or GPU bindings.

/// <reference types="@webgpu/types" />

import {generate} from './codegen/codegen';
import {compileProgramToWgsl, type WgslEligibilityIssue} from './codegen/wgsl';
import type {Program} from './ir/program';
import type {BindInputs, BoundInput} from './runtime/abi';
import {runCpuBatch} from './runtime/batch';
import {
  createGpuExecution,
  type GpuCachePlacement,
  type GpuExecutionOptions,
  type GpuRunTiming,
} from './runtime/gpu';
import {loadModule} from './runtime/load';

export interface CpuExecutionTarget {
  readonly kind: 'cpu';
}

export interface GpuExecutionTarget {
  readonly kind: 'gpu';
  // Device creation is a host concern. executeProgram owns and disposes only
  // the execution session it creates; the caller retains ownership here.
  readonly device: GPUDevice;
  readonly options?: GpuExecutionOptions;
}

export type ExecutionTarget = CpuExecutionTarget | GpuExecutionTarget;

export interface ExecutionBindingSummary {
  readonly bindingIndex: number;
  readonly rows: number;
  // Canonical, validated parameter values after defaults and active-state
  // evaluation. CPU and GPU expose the same runtime-owned representation.
  readonly inputs: readonly BoundInput[];
}

export interface ExecutionTiming {
  readonly loweringMs: number;
  readonly executionMs: number;
  readonly totalMs: number;
}

export interface GpuExecutionTiming extends ExecutionTiming, GpuRunTiming {
  // Provider resolution, input packing, resource allocation, shader
  // compilation, and pipeline/bind-group creation owned by the GPU session.
  readonly preparationMs: number;
}

interface ExecutionSummaryBase {
  readonly bindings: readonly ExecutionBindingSummary[];
  readonly timing: ExecutionTiming;
}

export interface CpuExecutionSummary extends ExecutionSummaryBase {
  readonly backend: 'cpu';
}

export interface GpuExecutionSummary extends ExecutionSummaryBase {
  readonly backend: 'gpu';
  readonly timing: GpuExecutionTiming;
  readonly chunks: number;
  readonly dispatches: number;
  readonly cache: GpuCachePlacement;
}

export type ExecutionSummary = CpuExecutionSummary | GpuExecutionSummary;

export class UnsupportedExecutionTargetError extends Error {
  readonly backend = 'gpu' as const;

  constructor(readonly issues: readonly WgslEligibilityIssue[]) {
    super(
      issues.length === 0
        ? 'Program cannot be lowered to GPU'
        : `Program cannot be lowered to GPU: ${issues
            .map(issue => issue.message)
            .join('; ')}`,
    );
    this.name = 'UnsupportedExecutionTargetError';
  }
}

// Lower one already-compiled Program exactly once for the selected target,
// then execute every binding in caller order. This layer has no knowledge of
// indicator, strategy, or any other source-library convention.
export async function executeProgram(
  program: Program,
  bindings: readonly BindInputs[],
  target: ExecutionTarget,
): Promise<ExecutionSummary> {
  const totalStarted = now();
  const loweringStarted = totalStarted;

  if (target.kind === 'cpu') {
    const module = loadModule(generate(program));
    const loweringFinished = now();
    const results = await runCpuBatch(module, bindings);
    const executionFinished = now();
    return {
      backend: 'cpu',
      bindings: results.map((result, bindingIndex) => ({
        bindingIndex,
        rows: result.rows,
        inputs: result.inputs,
      })),
      timing: timing(
        totalStarted,
        loweringStarted,
        loweringFinished,
        executionFinished,
      ),
    };
  }

  const compiled = compileProgramToWgsl(program);
  if (compiled.status !== 'compiled') {
    throw new UnsupportedExecutionTargetError(compiled.eligibility.issues);
  }
  const loweringFinished = now();
  const preparationStarted = loweringFinished;
  const session = await createGpuExecution(
    target.device,
    compiled.artifact,
    bindings,
    target.options,
  );
  const preparationFinished = now();
  try {
    const result = await session.runAll();
    const executionFinished = now();
    return {
      backend: 'gpu',
      bindings: result.bindings,
      chunks: result.chunks,
      dispatches: result.dispatches,
      cache: result.cache,
      timing: {
        ...timing(
          totalStarted,
          loweringStarted,
          loweringFinished,
          executionFinished,
        ),
        preparationMs: preparationFinished - preparationStarted,
        ...result.timing,
      },
    };
  } finally {
    session.dispose();
  }
}

function now(): number {
  return globalThis.performance.now();
}

function timing(
  totalStarted: number,
  loweringStarted: number,
  loweringFinished: number,
  executionFinished: number,
): ExecutionTiming {
  return {
    loweringMs: loweringFinished - loweringStarted,
    executionMs: executionFinished - loweringFinished,
    totalMs: executionFinished - totalStarted,
  };
}
