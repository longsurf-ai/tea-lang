// Purpose: Recursive-descent parser — drives the incremental scanner via this.scanner with one token of lookahead; owns grammar and error recovery.

import type {PosBase} from '../base/pos';
import type {ErrorHandler} from '../base/print';
import {unimplemented} from '../base/unimplemented';
import type {File} from './nodes';
import {Scanner} from './scanner';

// @agent invariant: the parser holds the only reference to its Scanner and is
// the only module that calls scanner.next(). Lookahead is exactly the
// scanner's current token fields — no token buffering, no rescanning.
export class Parser {
  private readonly scanner: Scanner;

  constructor(
    base: PosBase,
    src: string,
    private readonly errh: ErrorHandler,
  ) {
    this.scanner = new Scanner(base, src, errh);
  }

  // Parse one source file to a (possibly partial) File. Syntax errors are
  // reported through errh and parsing continues with recovery.
  parseFile(): File {
    return unimplemented('syntax/parser: parseFile', this.scanner, this.errh);
  }
}
