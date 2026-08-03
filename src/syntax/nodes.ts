// Purpose: Tea AST node definitions; the node vocabulary is intentionally minimal and grows with the parser.

import type {Span} from '../base/pos';
import type {SourceFile} from './source';

// @agent invariant: every AST node carries the span of the source text it was
// parsed from; nodes are plain immutable data with no methods.
export interface SyntaxNodeBase<K extends string = string> {
  readonly kind: K;
  readonly span: Span;
}

// Placeholder: real node kinds (VarDecl, If, Call, ...) land with the parser.
export type SyntaxNode = SyntaxNodeBase;

export interface SyntaxFile {
  readonly source: SourceFile;
  readonly statements: readonly SyntaxNode[];
}
