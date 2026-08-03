// Purpose: Noder — lowers the AST to Tea IR; the only place syntax trees and IR meet.

import type {DiagnosticBag} from '../base/diagnostics';
import {unimplemented} from '../base/unimplemented';
import type {IrProgram} from '../ir/node';
import type {SyntaxFile} from '../syntax/nodes';

export function lower(file: SyntaxFile, diagnostics: DiagnosticBag): IrProgram {
  return unimplemented('noder: lower', file, diagnostics);
}
