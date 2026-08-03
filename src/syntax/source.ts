// Purpose: Immutable source-file container — the scanner's only view of input text.

export interface SourceFile {
  // Display name for diagnostics, e.g. "my_indicator.tea".
  readonly name: string;
  readonly text: string;
}

export function sourceFile(name: string, text: string): SourceFile {
  return {name, text};
}
