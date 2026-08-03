// Purpose: Typed compiler configuration — main.ts translates CLI flags into this; Commander types never cross into the pipeline.

export interface CompileConfig {
  // JavaScript is the only lowering target today.
  readonly target: 'js';
}

export const DEFAULT_COMPILE_CONFIG: CompileConfig = {target: 'js'};
