// Purpose: Optional Node/Bun host adapter that supplies a standard GPUDevice through Dawn.

/// <reference types="@webgpu/types" />

export interface GpuDeviceLease {
  readonly device: GPUDevice;
  dispose(): Promise<void>;
}

export class GpuDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpuDeviceError';
  }
}

export async function createDawnDevice(): Promise<GpuDeviceLease> {
  if (process.versions.bun !== undefined) {
    throw new GpuDeviceError(
      'Dawn GPU execution requires the Node 22 host; use --cpu or let the tea CLI relay this command to Node',
    );
  }
  let binding: typeof import('webgpu');
  try {
    binding = await import('webgpu');
  } catch (error) {
    throw new GpuDeviceError(
      `GPU execution requires the optional 'webgpu' Dawn binding: ${errorMessage(error)}`,
    );
  }

  Object.assign(globalThis, binding.globals);
  let owner: ReturnType<typeof binding.create> | null = binding.create([]);
  const adapter = await owner.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (adapter === null) {
    throw new GpuDeviceError('Dawn did not expose a WebGPU adapter');
  }
  const device = await adapter.requestDevice();
  let disposed = false;
  return {
    device,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await device.queue.onSubmittedWorkDone();
      device.destroy();
      owner = null;
      // Let Dawn drain destruction callbacks before the CLI process can exit.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
