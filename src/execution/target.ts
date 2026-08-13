// Purpose: Acquire one host-owned execution target from a validated runtime configuration.

import type {ExecutionTarget} from '../execute';
import {createDawnDevice, type GpuDeviceLease} from '../providers/gpu/dawn';
import type {RuntimeConfig, WebGpuRuntimeConfig} from './config';

export interface ExecutionTargetLease {
  readonly target: ExecutionTarget;
  readonly device?: string;
  dispose(): Promise<void>;
}

export interface ExecutionTargetDependencies {
  readonly createDawnDevice?: () => Promise<GpuDeviceLease>;
}

// Runtime selection is a host-resource concern. The Program and its bindings
// stay outside this seam; the returned lease owns only resources it acquired.
export async function acquireExecutionTarget(
  runtime: RuntimeConfig,
  dependencies: ExecutionTargetDependencies = {},
): Promise<ExecutionTargetLease> {
  switch (runtime.kind) {
    case 'javascript':
      return {
        target: {kind: 'cpu'},
        dispose: async () => {},
      };
    case 'webgpu':
      return acquireWebGpuTarget(runtime, dependencies);
  }
}

async function acquireWebGpuTarget(
  runtime: WebGpuRuntimeConfig,
  dependencies: ExecutionTargetDependencies,
): Promise<ExecutionTargetLease> {
  const lease = await (dependencies.createDawnDevice ?? createDawnDevice)();
  const options = {
    ...(runtime.maxRowsPerChunk === undefined
      ? {}
      : {maxRowsPerChunk: runtime.maxRowsPerChunk}),
    ...(runtime.effectRecordsPerExecution === undefined
      ? {}
      : {effectRecordsPerExecution: runtime.effectRecordsPerExecution}),
    ...(runtime.maxGpuBytes === undefined
      ? {}
      : {maxGpuBytes: runtime.maxGpuBytes}),
    ...(runtime.maxCacheBytesPerWorkgroup === undefined
      ? {}
      : {maxCacheBytesPerWorkgroup: runtime.maxCacheBytesPerWorkgroup}),
  };
  return {
    target: {
      kind: 'gpu',
      device: lease.device,
      ...(Object.keys(options).length === 0 ? {} : {options}),
    },
    device: lease.device.label || 'Dawn WebGPU',
    dispose: () => lease.dispose(),
  };
}
