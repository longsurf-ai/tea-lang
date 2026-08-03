// Purpose: Parser — token stream to AST; owns grammar decisions and error recovery, never lexical ones.

import type {DiagnosticBag} from '../base/diagnostics';
import {unimplemented} from '../base/unimplemented';
import type {SyntaxFile} from './nodes';
import type {SourceFile} from './source';
import type {Token} from './tokens';

export function parse(
  source: SourceFile,
  tokens: readonly Token[],
  diagnostics: DiagnosticBag,
): SyntaxFile {
  return unimplemented('syntax/parser: parse', source, tokens, diagnostics);
}
