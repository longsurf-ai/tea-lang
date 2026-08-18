// Purpose: Acquire one host-owned execution backend from a validated runtime configuration.

import type {ExecutionBackend} from '../execute';
import {createDawnDevice, type GpuDeviceLease} from '../providers/gpu/dawn';
import type {RuntimeConfig, WebGpuRuntimeConfig} from './config';

export interface BackendLease {
  readonly backend: ExecutionBackend;
  readonly device?: string;
  dispose(): Promise<void>;
}

// Backend selection is a host-resource concern. The Program and its bindings
// stay outside this seam; the returned lease owns only resources it acquired.
export async function acquireBackend(
  runtime: RuntimeConfig,
  createDevice: () => Promise<GpuDeviceLease> = createDawnDevice,
): Promise<BackendLease> {
  switch (runtime.kind) {
    case 'javascript':
      return {
        backend: {kind: 'cpu'},
        dispose: async () => {},
      };
    case 'webgpu':
      return acquireWebGpuBackend(runtime, createDevice);
  }
}

async function acquireWebGpuBackend(
  runtime: WebGpuRuntimeConfig,
  createDevice: () => Promise<GpuDeviceLease>,
): Promise<BackendLease> {
  const lease = await createDevice();
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
    backend: {
      kind: 'gpu',
      device: lease.device,
      ...(Object.keys(options).length === 0 ? {} : {options}),
    },
    device: lease.device.label || 'Dawn WebGPU',
    dispose: () => lease.dispose(),
  };
}
