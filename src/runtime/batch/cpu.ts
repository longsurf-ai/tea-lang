// Purpose: Sequential CPU execution of one loaded Tea module across independent bindings.

import type {BindInputs, BoundInput, TeaModule} from '../abi';
import {bind} from '../js-runtime';

export interface CpuBatchResult {
  readonly rows: number;
  readonly inputs: readonly BoundInput[];
}

// Bindings run in caller order. Every bind creates a fresh runtime/frame tree
// and owns its own OutputSink, so state and captured output remain isolated.
export async function runCpuBatch(
  module: TeaModule,
  bindings: readonly BindInputs[],
): Promise<readonly CpuBatchResult[]> {
  const results: CpuBatchResult[] = [];

  for (const inputs of bindings) {
    let execution: Awaited<ReturnType<typeof bind>> | null = null;
    try {
      execution = await bind(module, inputs);
      const rows = execution.rows;
      const boundInputs = execution.inputs.map(input => ({...input}));
      await execution.runAll();
      results.push({rows, inputs: boundInputs});
    } finally {
      execution?.dispose();
    }
  }

  return results;
}
