// Purpose: Scanner — source text to token stream; owns all lexical decisions (indentation, literals, operators).

import type {DiagnosticBag} from '../base/diagnostics';
import {unimplemented} from '../base/unimplemented';
import type {SourceFile} from './source';
import type {Token} from './tokens';

export function scan(source: SourceFile, diagnostics: DiagnosticBag): Token[] {
  return unimplemented('syntax/scanner: scan', source, diagnostics);
}
