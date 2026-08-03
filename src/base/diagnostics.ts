// Purpose: Diagnostic vocabulary and accumulation — stages report malformed-source failures here and keep going; they never throw on user errors.

import type {Span} from './pos';

export type CompileStage = 'scan' | 'parse' | 'lower' | 'generate';

export interface Diagnostic {
  readonly severity: 'error' | 'warning';
  readonly stage: CompileStage;
  readonly message: string;
  // null = whole-file diagnostic with no specific source location.
  readonly span: Span | null;
}

// @agent invariant: stages accumulate diagnostics through this bag and continue
// where recovery is possible (Go's ErrorHandler model); throwing is reserved for
// TeaUnimplementedError and internal invariant violations.
export class DiagnosticBag {
  private readonly diagnostics: Diagnostic[] = [];

  report(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  get all(): readonly Diagnostic[] {
    return this.diagnostics;
  }

  get hasErrors(): boolean {
    return this.diagnostics.some(d => d.severity === 'error');
  }
}
