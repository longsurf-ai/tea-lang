// Purpose: Code generator — Tea IR to JavaScript source text; no SSA, no optimization passes.

import type {CompileConfig} from '../base/config';
import type {DiagnosticBag} from '../base/diagnostics';
import {unimplemented} from '../base/unimplemented';
import type {IrProgram} from '../ir/node';

export interface EmitResult {
  readonly js: string;
}

export function generate(
  program: IrProgram,
  config: CompileConfig,
  diagnostics: DiagnosticBag,
): EmitResult {
  return unimplemented('codegen: generate', program, config, diagnostics);
}
