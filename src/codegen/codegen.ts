// Purpose: Code generator — Tea IR to JavaScript source text; no SSA, no optimization passes.

import type {CompileConfig} from '../base/config';
import type {Errors} from '../base/print';
import {unimplemented} from '../base/unimplemented';
import type {Program} from '../ir/program';

export function generate(
  program: Program,
  config: CompileConfig,
  errors: Errors,
): string {
  return unimplemented('codegen: generate', program, config, errors);
}
