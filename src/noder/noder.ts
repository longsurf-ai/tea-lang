// Purpose: Noder — loadPackage() reads and parses the package's source files and wires their errors into the compilation's error list; lowering to unified Tea IR follows.

import {readFileSync} from 'node:fs';
import {newFileBase} from '../base/pos';
import type {Errors} from '../base/print';
import {unimplemented} from '../base/unimplemented';
import type {IrProgram} from '../ir/node';
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

// Lower parsed files to the unified IR; lands after the parser produces real
// Files.
export function lower(files: readonly File[], errors: Errors): IrProgram {
  return unimplemented('noder: lower', files, errors);
}
