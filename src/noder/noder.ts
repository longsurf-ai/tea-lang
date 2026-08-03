// Purpose: Noder — loadPackage() reads and parses the package's source files and wires their errors into the compilation's error list; buildProgram() turns checked syntax into the Tea Program.

import {readFileSync} from 'node:fs';
import {newFileBase} from '../base/pos';
import type {Errors} from '../base/print';
import {unimplemented} from '../base/unimplemented';
import type {Program} from '../ir/program';
import type {File} from '../syntax/nodes';
import {parse} from '../syntax/syntax';

// Frontend orchestrator: one parse per file.
export function loadPackage(
  filenames: readonly string[],
  errors: Errors,
): File[] {
  return filenames.map(filename =>
    parse(newFileBase(filename), readFileSync(filename, 'utf8'), (pos, msg) =>
      errors.errorAt(pos, msg),
    ),
  );
}

// Build the Program from checked syntax ("noding").
export function buildProgram(files: readonly File[], errors: Errors): Program {
  return unimplemented('noder: buildProgram', files, errors);
}
