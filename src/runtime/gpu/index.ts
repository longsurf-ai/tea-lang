// Purpose: Public provider-bound, resumable GPU execution surface.

export {
  createGpuExecution,
  prepareGpuExecutionInputs,
  GpuBindingError,
  GpuExecutionError,
  type GpuBindingProgress,
  type GpuBindingSummary,
  type GpuChunkResult,
  type GpuExecution,
  type GpuExecutionOptions,
  type GpuResourceSizes,
  type GpuRunSummary,
  type PreparedGpuExecution,
  type PreparedGpuLane,
} from './session';
