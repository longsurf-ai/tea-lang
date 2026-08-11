// Purpose: Own Dawn device creation and lifetime for the Node-only experiment boundary.

import {create, globals} from 'webgpu';

// Dawn's owner must outlive every native wrapper created from its device. Keep
// retired owners strongly reachable until process teardown after device.destroy().
const retiredGpuOwners = new Set<GPU>();

export interface NodeGpuProvider {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly gpu: GPU;
  destroy(): void;
}

export interface NodeGpuProviderOptions {
  // Largest single storage binding (bytes) the caller's sweep needs — in
  // practice the event journal. Device limits are raised above the WebGPU
  // defaults only when this requires it.
  readonly minStorageBindingBytes?: number;
}

// WebGPU portable defaults; requestDevice grants these without requiredLimits.
const DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE = 134_217_728;
const DEFAULT_MAX_BUFFER_SIZE = 268_435_456;

export async function createNodeGpuProvider(
  options: NodeGpuProviderOptions = {},
): Promise<NodeGpuProvider> {
  const nodeMajorVersion = Number(process.versions.node.split('.')[0]);
  if (nodeMajorVersion !== 22) {
    throw new Error(
      `This experiment requires Node 22 because TypeGPU 0.11.9 readback is unstable with Dawn on Node 24/25; received Node ${process.versions.node}`,
    );
  }

  Object.assign(globalThis, globals);

  const gpu = create([]);
  const adapter = await gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    throw new Error('Dawn did not expose a WebGPU adapter');
  }

  const neededBytes = options.minStorageBindingBytes ?? 0;
  if (
    neededBytes > adapter.limits.maxStorageBufferBindingSize ||
    neededBytes > adapter.limits.maxBufferSize
  ) {
    throw new Error(
      `Sweep needs a ${neededBytes}-byte storage binding, but the adapter caps ` +
        `maxStorageBufferBindingSize at ${adapter.limits.maxStorageBufferBindingSize} ` +
        `and maxBufferSize at ${adapter.limits.maxBufferSize}. Shrink the grid ` +
        `or pass an explicit --event-capacity below the derived worst case; ` +
        `the journal still hard-fails on overflow instead of truncating.`,
    );
  }
  const requiredLimits: Record<string, number> = {};
  if (neededBytes > DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE) {
    requiredLimits.maxStorageBufferBindingSize = neededBytes;
  }
  if (neededBytes > DEFAULT_MAX_BUFFER_SIZE) {
    requiredLimits.maxBufferSize = neededBytes;
  }
  const device = await adapter.requestDevice(
    Object.keys(requiredLimits).length > 0 ? {requiredLimits} : undefined,
  );
  let destroyed = false;

  return {
    adapter,
    device,
    gpu,
    destroy() {
      if (destroyed) {
        throw new Error('Node GPU provider was destroyed more than once');
      }
      destroyed = true;
      device.destroy();
      retiredGpuOwners.add(gpu);
    },
  };
}
