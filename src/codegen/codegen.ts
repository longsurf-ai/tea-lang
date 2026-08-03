// Purpose: Code generator — Tea IR to JavaScript source text; no SSA, no optimization passes.

import type {CompileConfig} from '../base/config';
import type {Errors} from '../base/print';
import {unimplemented} from '../base/unimplemented';
import type {IrProgram} from '../ir/node';

export function generate(
  program: IrProgram,
  config: CompileConfig,
  errors: Errors,
): string {
  return unimplemented('codegen: generate', program, config, errors);
}
