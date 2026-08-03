// Purpose: Incremental scanner — a stateful cursor advanced one token at a time by next(); owns all lexical decisions including indent/dedent synthesis.

import type {Pos, PosBase} from '../base/pos';
import type {ErrorHandler} from '../base/print';
import {Source, type SourceState} from './source';
import {
  KEYWORDS,
  PRECEDENCE,
  Tok,
  type KeywordKind,
  type LitKind,
  type Op,
  type TokenKind,
} from './tokens';

// Full scanner snapshot for parser-directed speculation. Opaque to callers.
export interface ScannerState {
  readonly source: SourceState;
  readonly tok: TokenKind;
  readonly pos: Pos;
  readonly lit: string;
  readonly kind: LitKind | null;
  readonly op: Op | null;
  readonly prec: number;
  readonly indents: readonly number[];
  readonly pendingDedents: number;
  readonly pendingIndent: boolean;
  readonly pendingNewline: boolean;
  readonly newlinePos: Pos;
  readonly breakPending: boolean;
  readonly breakPos: Pos;
  readonly tokensOnStatement: boolean;
  readonly atLineStart: boolean;
  readonly eofDrained: boolean;
  readonly groupDepth: number;
}

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);
const INDENT_UNIT = 4; // one block level; a tab counts as one unit

// Line-structure rules (Pine's; Tea is a syntax superset of Pine):
// - Inside an unclosed ( or [ group, line breaks are insignificant and the
//   indent machinery is bypassed entirely (bracket-aware joining — corpus
//   scripts close wrapped calls at column 1).
// - A line indented by a multiple of 4 starts a statement; its width is
//   compared against the indent stack to synthesize indent/dedent tokens.
// - A line indented by a NON-multiple of 4 continues the previous statement:
//   no newline/indent/dedent is emitted for it.
// - Blank and comment-only lines emit nothing and leave the stack untouched.
// - A tab counts as 4 columns; mixing tabs and spaces in one line's leading
//   whitespace is an error.
// - A block comment containing a line break terminates the open statement,
//   like a newline.
//
// @agent invariant: the scanner never allocates Token objects. next() mutates
// the public token fields in place; they are valid only until the following
// next() call. The parser reads them directly.
export class Scanner {
  // Current token, valid after next():
  tok: TokenKind = Tok.Eof;
  // Token start position.
  pos: Pos;
  // Valid if tok is 'name' or 'literal'.
  lit = '';
  // Valid if tok is 'literal'.
  kind: LitKind | null = null;
  // Valid if tok is 'operator' or 'assignop'.
  op: Op | null = null;
  prec = 0;

  // Declared Tea language version, from the first //@version= annotation.
  version: string | null = null;

  private readonly source: Source;

  // Indentation stack of block widths (multiples of 4), innermost last.
  private readonly indents: number[] = [0];
  private pendingDedents = 0;
  private pendingIndent = false;
  // Confirmed statement terminator, emitted by the next next() call.
  private pendingNewline = false;
  private newlinePos: Pos;
  // A line break was seen while a statement was open, but the 'newline'
  // token stays unconfirmed until the following statement line (or EOF)
  // proves the break was not followed by a continuation line.
  private breakPending = false;
  private breakPos: Pos;
  private tokensOnStatement = false;
  private atLineStart = true;
  private eofDrained = false;
  // Open ( and [ groups. While positive, line breaks are insignificant
  // (bracket-aware joining); the indent machinery is bypassed entirely.
  private groupDepth = 0;

  constructor(
    base: PosBase,
    src: string,
    private readonly errh: ErrorHandler,
  ) {
    this.source = new Source(base, src);
    this.pos = this.source.pos();
    this.newlinePos = this.pos;
    this.breakPos = this.pos;
  }

  // Snapshot/restore the complete scanner state, enabling the parser's
  // tryParse speculation. version is deliberately not restored: it is
  // monotone first-wins metadata.
  checkpoint(): ScannerState {
    return {
      source: this.source.checkpoint(),
      tok: this.tok,
      pos: this.pos,
      lit: this.lit,
      kind: this.kind,
      op: this.op,
      prec: this.prec,
      indents: [...this.indents],
      pendingDedents: this.pendingDedents,
      pendingIndent: this.pendingIndent,
      pendingNewline: this.pendingNewline,
      newlinePos: this.newlinePos,
      breakPending: this.breakPending,
      breakPos: this.breakPos,
      tokensOnStatement: this.tokensOnStatement,
      atLineStart: this.atLineStart,
      eofDrained: this.eofDrained,
      groupDepth: this.groupDepth,
    };
  }

  restore(state: ScannerState): void {
    this.source.restore(state.source);
    this.tok = state.tok;
    this.pos = state.pos;
    this.lit = state.lit;
    this.kind = state.kind;
    this.op = state.op;
    this.prec = state.prec;
    this.indents.length = 0;
    this.indents.push(...state.indents);
    this.pendingDedents = state.pendingDedents;
    this.pendingIndent = state.pendingIndent;
    this.pendingNewline = state.pendingNewline;
    this.newlinePos = state.newlinePos;
    this.breakPending = state.breakPending;
    this.breakPos = state.breakPos;
    this.tokensOnStatement = state.tokensOnStatement;
    this.atLineStart = state.atLineStart;
    this.eofDrained = state.eofDrained;
    this.groupDepth = state.groupDepth;
  }

  // Parser-directed rescan for `import owner/name/version`: extends the
  // current Name token in place into one atomic path literal (litKind
  // 'path'). Segments must be adjacent — the cursor sits immediately after
  // the name, so any whitespace before '/' simply ends the path.
  rescanImportPath(): void {
    let path = this.lit;
    while (this.source.ch === '/') {
      this.source.nextch();
      if (!isNamePart(this.source.ch)) {
        this.errh(this.source.pos(), 'malformed import path');
        break;
      }
      this.source.startSegment();
      while (isNamePart(this.source.ch)) {
        this.source.nextch();
      }
      path = `${path}/${this.source.segment()}`;
    }
    this.tok = Tok.Literal;
    this.kind = 'path';
    this.lit = path;
  }

  // Advance the scanner by one token, mutating the fields above. Lexical
  // errors are reported through errh and scanning continues.
  next(): void {
    for (;;) {
      if (this.emitPending()) {
        return;
      }
      if (this.atLineStart) {
        this.handleLineStart();
        continue;
      }

      this.skipInlineTrivia();
      // A multi-line block comment inside the trivia may have queued a
      // statement-terminating newline; it must precede the next token.
      if (this.emitPending()) {
        return;
      }
      if (this.source.ch === '\n') {
        this.endLine();
        continue;
      }
      if (this.source.ch === '') {
        if (!this.eofDrained) {
          this.prepareEofDrain();
          continue;
        }
        this.clearRefinements();
        this.setTok(Tok.Eof, this.source.pos());
        return;
      }
      if (this.scanToken()) {
        return;
      }
    }
  }

  // ---- pending synthetic tokens ---------------------------------------------

  private emitPending(): boolean {
    if (this.pendingNewline) {
      this.pendingNewline = false;
      this.clearRefinements();
      this.setTok(Tok.Newline, this.newlinePos);
      return true;
    }
    if (this.pendingDedents > 0) {
      this.pendingDedents -= 1;
      this.clearRefinements();
      this.setTok(Tok.Dedent, this.lineStartPos());
      return true;
    }
    if (this.pendingIndent) {
      this.pendingIndent = false;
      this.clearRefinements();
      this.setTok(Tok.Indent, this.lineStartPos());
      return true;
    }
    return false;
  }

  private setTok(tok: TokenKind, pos: Pos): void {
    this.tok = tok;
    this.pos = pos;
  }

  private lineStartPos(): Pos {
    return {base: this.source.base, line: this.source.line, col: 1};
  }

  // ---- line structure ---------------------------------------------------------

  private handleLineStart(): void {
    const width = this.measureIndent();

    if (this.source.ch === '') {
      this.atLineStart = false;
      return;
    }
    // Blank and comment-only lines emit nothing and do not touch the stack.
    if (this.source.ch === '\n') {
      this.source.nextch();
      return;
    }
    if (this.source.ch === '/' && this.source.peek() === '/') {
      this.scanLineComment();
      return; // still atLineStart; the terminating '\n' is handled next pass
    }
    if (this.source.ch === '/' && this.source.peek() === '*') {
      // A block comment at line start is trivia only. Code after it on its
      // closing line is treated as a continuation (no indent effects).
      this.scanBlockComment();
      this.atLineStart = false;
      return;
    }

    if (this.groupDepth > 0) {
      this.atLineStart = false;
      return;
    }
    if (width % INDENT_UNIT !== 0) {
      // Continuation line: the previous statement keeps going.
      if (!this.breakPending && !this.tokensOnStatement) {
        this.errh(this.lineStartPos(), 'unexpected indentation');
      }
      this.breakPending = false;
      this.atLineStart = false;
      return;
    }

    // Statement line: the pending break is confirmed as a statement
    // terminator, then the stack is adjusted.
    if (this.breakPending) {
      this.breakPending = false;
      this.pendingNewline = true;
      this.newlinePos = this.breakPos;
    }
    const top = this.indents[this.indents.length - 1];
    if (width > top) {
      this.indents.push(width);
      this.pendingIndent = true;
    } else if (width < top) {
      while (
        this.indents.length > 1 &&
        this.indents[this.indents.length - 1] > width
      ) {
        this.indents.pop();
        this.pendingDedents += 1;
      }
      if (this.indents[this.indents.length - 1] !== width) {
        this.errh(
          this.lineStartPos(),
          'unindent does not match any outer indentation level',
        );
        this.indents.push(width);
      }
    }
    this.tokensOnStatement = false;
    this.atLineStart = false;
  }

  // Measures leading whitespace in columns (tab = 4). Reports mixed tabs and
  // spaces once per line.
  private measureIndent(): number {
    let width = 0;
    let sawTab = false;
    let sawSpace = false;
    let reported = false;
    for (;;) {
      const ch = this.source.ch;
      if (ch === ' ') {
        sawSpace = true;
        width += 1;
      } else if (ch === '\t') {
        sawTab = true;
        width += INDENT_UNIT;
      } else if (ch === '\r') {
        // stripped; CRLF is handled at the '\n'
      } else {
        return width;
      }
      if (sawTab && sawSpace && !reported) {
        this.errh(this.source.pos(), 'mixed tabs and spaces in indentation');
        reported = true;
      }
      this.source.nextch();
    }
  }

  private endLine(): void {
    if (this.groupDepth > 0) {
      this.source.nextch();
      this.atLineStart = true;
      return;
    }
    if (this.tokensOnStatement) {
      this.breakPending = true;
      this.breakPos = this.source.pos();
      this.tokensOnStatement = false;
    }
    this.source.nextch();
    this.atLineStart = true;
  }

  // At end of input: terminate the open statement and close open blocks. The
  // queued tokens are emitted one per next() call.
  private prepareEofDrain(): void {
    this.eofDrained = true;
    if (this.tokensOnStatement) {
      this.pendingNewline = true;
      this.newlinePos = this.source.pos();
      this.tokensOnStatement = false;
    } else if (this.breakPending) {
      this.breakPending = false;
      this.pendingNewline = true;
      this.newlinePos = this.breakPos;
    }
    while (this.indents.length > 1) {
      this.indents.pop();
      this.pendingDedents += 1;
    }
  }

  // ---- trivia -------------------------------------------------------------------

  private skipInlineTrivia(): void {
    for (;;) {
      const ch = this.source.ch;
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.source.nextch();
        continue;
      }
      if (ch === '/' && this.source.peek() === '/') {
        this.scanLineComment();
        continue;
      }
      if (ch === '/' && this.source.peek() === '*') {
        this.scanBlockComment();
        continue;
      }
      return;
    }
  }

  private scanLineComment(): void {
    this.source.startSegment();
    while (this.source.ch !== '\n' && this.source.ch !== '') {
      this.source.nextch();
    }
    const text = this.source.segment();
    const version = /^\/\/@version\s*=\s*(\S+)/.exec(text);
    if (version !== null && this.version === null) {
      this.version = version[1];
    }
  }

  private scanBlockComment(): void {
    const start = this.source.pos();
    this.source.nextch(); // '/'
    this.source.nextch(); // '*'
    let sawLineBreak = false;
    for (;;) {
      const ch = this.source.ch;
      if (ch === '') {
        this.errh(start, 'block comment not terminated');
        break;
      }
      if (ch === '\n') {
        sawLineBreak = true;
      }
      if (ch === '*' && this.source.peek() === '/') {
        this.source.nextch();
        this.source.nextch();
        break;
      }
      this.source.nextch();
    }
    // A block comment spanning lines terminates the open statement, exactly
    // like a line break.
    if (sawLineBreak && this.tokensOnStatement) {
      this.pendingNewline = true;
      this.newlinePos = start;
      this.tokensOnStatement = false;
    }
  }

  // ---- tokens -------------------------------------------------------------------

  // Returns false only when the character was invalid and consumed without
  // producing a token; the caller keeps scanning.
  private scanToken(): boolean {
    const pos = this.source.pos();
    const ch = this.source.ch;

    if (isNameStart(ch)) {
      this.scanName(pos);
      return true;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(this.source.peek()))) {
      this.scanNumber(pos);
      return true;
    }
    if (ch === '"' || ch === "'") {
      this.scanString(pos);
      return true;
    }
    if (ch === '#') {
      this.scanColor(pos);
      return true;
    }
    return this.scanOperator(pos);
  }

  private token(tok: TokenKind, pos: Pos): void {
    this.setTok(tok, pos);
    this.tokensOnStatement = true;
  }

  private clearRefinements(): void {
    this.lit = '';
    this.kind = null;
    this.op = null;
    this.prec = 0;
  }

  private operator(op: Op, pos: Pos): void {
    this.clearRefinements();
    this.op = op;
    this.prec = PRECEDENCE[op];
    this.token(Tok.Operator, pos);
  }

  private punct(tok: TokenKind, pos: Pos): void {
    this.clearRefinements();
    this.token(tok, pos);
  }

  private literal(kind: LitKind, lit: string, pos: Pos): void {
    this.clearRefinements();
    this.kind = kind;
    this.lit = lit;
    this.token(Tok.Literal, pos);
  }

  private scanName(pos: Pos): void {
    this.source.startSegment();
    while (isNamePart(this.source.ch)) {
      this.source.nextch();
    }
    const text = this.source.segment();
    if (text === 'and' || text === 'or' || text === 'not') {
      this.operator(text, pos);
      return;
    }
    this.clearRefinements();
    if (KEYWORD_SET.has(text)) {
      this.token(text as KeywordKind, pos);
      return;
    }
    this.lit = text;
    this.token(Tok.Name, pos);
  }

  private scanNumber(pos: Pos): void {
    this.source.startSegment();
    let kind: LitKind = 'int';
    while (isDigit(this.source.ch)) {
      this.source.nextch();
    }
    if (this.source.ch === '.') {
      kind = 'float';
      this.source.nextch();
      while (isDigit(this.source.ch)) {
        this.source.nextch();
      }
    }
    const expo = this.source.ch;
    if (expo === 'e' || expo === 'E') {
      kind = 'float';
      this.source.nextch();
      const sign = this.source.ch;
      if (sign === '+' || sign === '-') {
        this.source.nextch();
      }
      if (!isDigit(this.source.ch)) {
        this.errh(this.source.pos(), 'exponent has no digits');
      }
      while (isDigit(this.source.ch)) {
        this.source.nextch();
      }
    }
    this.literal(kind, this.source.segment(), pos);
  }

  private scanString(pos: Pos): void {
    const quote = this.source.ch;
    this.source.startSegment();
    this.source.nextch();
    for (;;) {
      const ch = this.source.ch;
      if (ch === quote) {
        this.source.nextch();
        break;
      }
      if (ch === '\n' || ch === '') {
        this.errh(pos, 'string literal not terminated');
        break;
      }
      if (ch === '\\') {
        this.source.nextch();
        const escaped = this.source.ch;
        if (escaped === '\n' || escaped === '') {
          this.errh(pos, 'string literal not terminated');
          break;
        }
      }
      this.source.nextch();
    }
    this.literal('string', this.source.segment(), pos);
  }

  private scanColor(pos: Pos): void {
    this.source.startSegment();
    this.source.nextch(); // '#'
    let digits = 0;
    while (isHexDigit(this.source.ch)) {
      this.source.nextch();
      digits += 1;
    }
    if (digits !== 6 && digits !== 8) {
      this.errh(pos, 'color literal must have 6 or 8 hexadecimal digits');
    }
    this.literal('color', this.source.segment(), pos);
  }

  // Returns false only for an invalid character, which is reported and
  // consumed; the caller keeps scanning.
  private scanOperator(pos: Pos): boolean {
    const ch = this.source.ch;
    switch (ch) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
        this.source.nextch();
        if (this.source.ch === '=') {
          this.source.nextch();
          this.clearRefinements();
          this.op = ch;
          this.token(Tok.AssignOp, pos);
          return true;
        }
        this.operator(ch, pos);
        return true;
      case '=':
        this.source.nextch();
        if (this.source.ch === '=') {
          this.source.nextch();
          this.operator('==', pos);
          return true;
        }
        if (this.source.ch === '>') {
          this.source.nextch();
          this.punct(Tok.Arrow, pos);
          return true;
        }
        this.punct(Tok.Assign, pos);
        return true;
      case '!':
        this.source.nextch();
        if (this.source.ch === '=') {
          this.source.nextch();
          this.operator('!=', pos);
          return true;
        }
        this.errh(pos, "unexpected character '!'");
        return false;
      case '<':
        this.source.nextch();
        if (this.source.ch === '=') {
          this.source.nextch();
          this.operator('<=', pos);
          return true;
        }
        this.operator('<', pos);
        return true;
      case '>':
        this.source.nextch();
        if (this.source.ch === '=') {
          this.source.nextch();
          this.operator('>=', pos);
          return true;
        }
        this.operator('>', pos);
        return true;
      case ':':
        this.source.nextch();
        if (this.source.ch === '=') {
          this.source.nextch();
          this.punct(Tok.Define, pos);
          return true;
        }
        this.punct(Tok.Colon, pos);
        return true;
      case '?':
        this.source.nextch();
        this.punct(Tok.Question, pos);
        return true;
      case '(':
        this.source.nextch();
        this.groupDepth += 1;
        this.punct(Tok.Lparen, pos);
        return true;
      case ')':
        this.source.nextch();
        this.groupDepth = Math.max(0, this.groupDepth - 1);
        this.punct(Tok.Rparen, pos);
        return true;
      case '[':
        this.source.nextch();
        this.groupDepth += 1;
        this.punct(Tok.Lbrack, pos);
        return true;
      case ']':
        this.source.nextch();
        this.groupDepth = Math.max(0, this.groupDepth - 1);
        this.punct(Tok.Rbrack, pos);
        return true;
      case ',':
        this.source.nextch();
        this.punct(Tok.Comma, pos);
        return true;
      case '.':
        this.source.nextch();
        this.punct(Tok.Dot, pos);
        return true;
      default:
        this.errh(pos, `unexpected character ${JSON.stringify(ch)}`);
        this.source.nextch();
        return false;
    }
  }
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNamePart(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}
