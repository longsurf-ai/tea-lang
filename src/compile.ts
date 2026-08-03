// Purpose: Pipeline driver — sole owner of stage order: scan → parse → [typecheck reserved] → lower → generate.

import type {CompileConfig} from './base/config';
import {DiagnosticBag, type Diagnostic} from './base/diagnostics';
import {generate, type EmitResult} from './codegen/codegen';
import type {IrProgram} from './ir/node';
import {lower} from './noder/noder';
import type {SyntaxFile} from './syntax/nodes';
import {parse} from './syntax/parser';
import {scan} from './syntax/scanner';
import type {SourceFile} from './syntax/source';
import type {Token} from './syntax/tokens';

export interface CompileResult {
  readonly emit: EmitResult;
  readonly diagnostics: readonly Diagnostic[];
}

// Each compileTo* entry point runs the pipeline through the named stage; the
// CLI picks the deepest stage a subcommand needs. compile() is the full
// pipeline and owns its own diagnostic bag.

export function compileToTokens(
  source: SourceFile,
  diagnostics: DiagnosticBag,
): Token[] {
  return scan(source, diagnostics);
}

export function compileToSyntax(
  source: SourceFile,
  diagnostics: DiagnosticBag,
): SyntaxFile {
  return parse(source, compileToTokens(source, diagnostics), diagnostics);
}

export function compileToIr(
  source: SourceFile,
  diagnostics: DiagnosticBag,
): IrProgram {
  return lower(compileToSyntax(source, diagnostics), diagnostics);
}

export function compile(
  source: SourceFile,
  config: CompileConfig,
): CompileResult {
  const diagnostics = new DiagnosticBag();
  const emit = generate(compileToIr(source, diagnostics), config, diagnostics);
  return {emit, diagnostics: diagnostics.all};
}
