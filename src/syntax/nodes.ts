// Purpose: Tea AST node definitions — every node carries its source position; the vocabulary grows with the parser.

import type {Pos} from '../base/pos';

// @agent invariant: nodes are plain immutable data with no methods; every
// node carries the position of its leftmost defining token.
export interface Node {
  readonly pos: Pos;
}

// Placeholder statement shape; real statements form a discriminated union on
// `kind` once the grammar lands.
export interface Stmt extends Node {
  readonly kind: string;
}

// The parse product for one source file.
export interface File extends Node {
  readonly stmtList: readonly Stmt[];
  readonly eof: Pos;
}
