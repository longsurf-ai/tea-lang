// Purpose: Runtime configurations acquire exactly one matching disposable execution target.

import {describe, expect, test} from 'bun:test';
import type {GpuDeviceLease} from '../providers/gpu/dawn';
import type {RuntimeConfig} from './config';
import {acquireExecutionTarget} from './target';

describe('execution target host', () => {
  test('JavaScript needs no host resource', async () => {
    let dawnCalls = 0;
    const lease = await acquireExecutionTarget(
      {kind: 'javascript'},
      {
        createDawnDevice: async () => {
          dawnCalls++;
          return gpuLease({label: 'unused'} as GPUDevice, () => {});
        },
      },
    );

    expect(lease.target).toEqual({kind: 'cpu'});
    expect(lease.device).toBeUndefined();
    expect(dawnCalls).toBe(0);
    await lease.dispose();
  });

  test('WebGPU maps every validated option and delegates disposal', async () => {
    const device = {label: 'Injected Dawn'} as GPUDevice;
    let dawnCalls = 0;
    let disposeCalls = 0;
    const runtime: RuntimeConfig = {
      kind: 'webgpu',
      maxRowsPerChunk: 7,
      effectRecordsPerExecution: 0,
      maxGpuBytes: 4096,
      maxCacheBytesPerWorkgroup: 0,
    };
    const lease = await acquireExecutionTarget(runtime, {
      createDawnDevice: async () => {
        dawnCalls++;
        return gpuLease(device, () => disposeCalls++);
      },
    });

    expect(dawnCalls).toBe(1);
    expect(lease.device).toBe('Injected Dawn');
    expect(lease.target).toEqual({
      kind: 'gpu',
      device,
      options: {
        maxRowsPerChunk: 7,
        effectRecordsPerExecution: 0,
        maxGpuBytes: 4096,
        maxCacheBytesPerWorkgroup: 0,
      },
    });
    await lease.dispose();
    expect(disposeCalls).toBe(1);
  });

  test('WebGPU omits an empty options object', async () => {
    const device = {label: ''} as GPUDevice;
    const lease = await acquireExecutionTarget(
      {kind: 'webgpu'},
      {createDawnDevice: async () => gpuLease(device, () => {})},
    );

    expect(lease.device).toBe('Dawn WebGPU');
    expect(lease.target).toEqual({kind: 'gpu', device});
  });
});

function gpuLease(device: GPUDevice, dispose: () => void): GpuDeviceLease {
  return {
    device,
    async dispose() {
      dispose();
    },
  };
}
