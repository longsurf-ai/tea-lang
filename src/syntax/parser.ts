// Purpose: Recursive-descent parser — drives the incremental scanner via this.scanner with one token of lookahead; owns grammar and error recovery.

import type {Pos, PosBase} from '../base/pos';
import type {ErrorHandler} from '../base/print';
import type {
  Arg,
  AssignOp,
  BadExpr,
  BadStmt,
  DeclMode,
  Expr,
  File,
  Name,
  SelectorExpr,
  Stmt,
  TuplePattern,
  TypeAnnotation,
  TypeName,
} from './nodes';
import {Scanner} from './scanner';
import type {Op, TokenKind} from './tokens';

const COMPOUND_ASSIGN: Readonly<Partial<Record<Op, AssignOp>>> = {
  '+': '+=',
  '-': '-=',
  '*': '*=',
  '/': '/=',
  '%': '%=',
};

// @agent invariant: the parser holds the only reference to its Scanner and is
// the only module that calls scanner.next(). Lookahead is exactly the
// scanner's current token fields — no token buffering, no rescanning except
// the scanner-provided rescan entry points. Speculative productions run
// silent and return null instead of reporting; only committed parses report.
// Token state is read through tok()/op() methods (not getters) so TypeScript
// never carries stale narrowing across scanner mutations.
export class Parser {
  private readonly scanner: Scanner;
  private silent = 0;

  constructor(
    base: PosBase,
    src: string,
    private readonly errh: ErrorHandler,
  ) {
    this.scanner = new Scanner(base, src, errh);
  }

  // ---- token plumbing -------------------------------------------------------

  private tok(): TokenKind {
    return this.scanner.tok;
  }

  private op(): Op | null {
    return this.scanner.op;
  }

  private pos(): Pos {
    return this.scanner.pos;
  }

  private next(): void {
    this.scanner.next();
  }

  private got(tok: TokenKind): boolean {
    if (this.tok() === tok) {
      this.next();
      return true;
    }
    return false;
  }

  private want(tok: TokenKind): boolean {
    if (this.got(tok)) {
      return true;
    }
    this.error(`expected '${tok}', found '${this.tok()}'`);
    return false;
  }

  private error(msg: string, pos: Pos = this.pos()): void {
    if (this.silent === 0) {
      this.errh(pos, msg);
    }
  }

  // Skip tokens until one of follow (or EOF). Never reports.
  private advance(...follow: readonly TokenKind[]): void {
    while (this.tok() !== 'eof' && !follow.includes(this.tok())) {
      this.next();
    }
  }

  // Run a speculative production: errors are suppressed and the scanner is
  // restored when the production returns null.
  private tryParse<T>(production: () => T | null): T | null {
    const state = this.scanner.checkpoint();
    this.silent += 1;
    let result: T | null = null;
    try {
      result = production();
    } finally {
      this.silent -= 1;
    }
    if (result === null) {
      this.scanner.restore(state);
    }
    return result;
  }

  // ---- file -----------------------------------------------------------------

  parseFile(): File {
    this.next();
    const pos = this.pos();
    const stmtList: Stmt[] = [];
    while (this.tok() !== 'eof') {
      if (this.got('newline')) {
        continue;
      }
      if (this.got('dedent')) {
        continue; // imbalance already reported by the scanner
      }
      if (this.tok() === 'indent') {
        this.error('unexpected indentation');
        this.skipBlock();
        continue;
      }
      stmtList.push(this.stmt());
      this.stmtEnd();
    }
    return {
      kind: 'File',
      pos,
      version: this.scanner.version,
      stmtList,
      eof: this.pos(),
    };
  }

  private stmtEnd(): void {
    if (this.got('newline')) {
      return;
    }
    if (this.tok() === 'eof' || this.tok() === 'dedent') {
      return;
    }
    this.error(`expected end of statement, found '${this.tok()}'`);
    this.advance('newline', 'dedent');
    this.got('newline');
  }

  // Consume a balanced indent…dedent region (recovery only).
  private skipBlock(): void {
    let depth = 0;
    do {
      if (this.tok() === 'indent') {
        depth += 1;
      } else if (this.tok() === 'dedent') {
        depth -= 1;
      }
      this.next();
    } while (depth > 0 && this.tok() !== 'eof');
  }

  private badStmt(pos: Pos): BadStmt {
    return {kind: 'BadStmt', pos};
  }

  private badExpr(pos: Pos): BadExpr {
    return {kind: 'BadExpr', pos};
  }

  // ---- statements -----------------------------------------------------------

  private stmt(): Stmt {
    const pos = this.pos();
    switch (this.tok()) {
      case 'var':
      case 'varip':
      case 'const': {
        const mode = this.tok() as DeclMode;
        this.next();
        return this.declRest(pos, mode);
      }
      case 'break':
        this.next();
        return {kind: 'BreakStmt', pos};
      case 'continue':
        this.next();
        return {kind: 'ContinueStmt', pos};
      case 'lbrack':
        return this.tupleDecl(pos, 'none');
      case 'if':
      case 'for':
      case 'while':
      case 'switch':
      case 'import':
      case 'type':
      case 'enum':
      case 'export':
      case 'method':
        this.error(`'${this.tok()}' statements are not implemented yet`);
        this.advance('newline', 'dedent');
        return this.badStmt(pos);
      default:
        break;
    }

    // `float x = …`, `array<float> xs = …`, `m.Type v = …` — commit to a
    // typed declaration only when the full head shape (type, name, '=') is
    // present; otherwise this is an expression-led statement.
    if (this.tok() === 'name') {
      const typed = this.tryParse(() => this.typedDeclHead());
      if (typed !== null) {
        const init = this.expr();
        return {
          kind: 'DeclStmt',
          pos,
          mode: 'none',
          declType: typed.declType,
          target: typed.target,
          init,
        };
      }
    }

    const x = this.expr();
    if (this.got('assign')) {
      const init = this.expr();
      if (x.kind !== 'Name') {
        this.error('cannot declare this expression as a variable', x.pos);
        return this.badStmt(pos);
      }
      return {
        kind: 'DeclStmt',
        pos,
        mode: 'none',
        declType: null,
        target: x,
        init,
      };
    }
    if (this.tok() === 'define' || this.tok() === 'assignop') {
      const op = this.assignOp();
      const value = this.expr();
      return {kind: 'AssignStmt', pos, op, target: x, value};
    }
    return {kind: 'ExprStmt', pos, x};
  }

  private assignOp(): AssignOp {
    if (this.got('define')) {
      return ':=';
    }
    const base = this.op();
    this.next();
    const op = base === null ? undefined : COMPOUND_ASSIGN[base];
    if (op === undefined) {
      this.error('malformed compound assignment');
      return ':=';
    }
    return op;
  }

  // After var/varip/const.
  private declRest(pos: Pos, mode: DeclMode): Stmt {
    if (this.tok() === 'lbrack') {
      return this.tupleDecl(pos, mode);
    }
    const typed = this.tryParse(() => this.typedDeclHead());
    if (typed !== null) {
      const init = this.expr();
      return {
        kind: 'DeclStmt',
        pos,
        mode,
        declType: typed.declType,
        target: typed.target,
        init,
      };
    }
    const target = this.name();
    this.want('assign');
    const init = this.expr();
    return {kind: 'DeclStmt', pos, mode, declType: null, target, init};
  }

  // Speculative: type name '=' — consumes through the '='.
  private typedDeclHead(): {
    declType: TypeAnnotation;
    target: Name;
  } | null {
    const pos = this.pos();
    const typeName = this.typeName();
    if (typeName === null || this.tok() !== 'name') {
      return null;
    }
    const target = this.name();
    if (this.tok() !== 'assign') {
      return null;
    }
    this.next();
    return {
      declType: {kind: 'TypeAnnotation', pos, qualifier: null, name: typeName},
      target,
    };
  }

  private tupleDecl(pos: Pos, mode: DeclMode): Stmt {
    const target = this.tuplePattern();
    this.want('assign');
    const init = this.expr();
    return {kind: 'DeclStmt', pos, mode, declType: null, target, init};
  }

  private tuplePattern(): TuplePattern {
    const pos = this.pos();
    this.want('lbrack');
    const elems: Name[] = [];
    do {
      elems.push(this.name());
    } while (this.got('comma'));
    this.want('rbrack');
    return {kind: 'TuplePattern', pos, elems};
  }

  // ---- types ----------------------------------------------------------------

  // Speculation-friendly: returns null on any mismatch, reports nothing.
  private typeName(): TypeName | null {
    if (this.tok() !== 'name') {
      return null;
    }
    let t: TypeName = this.name();
    if (this.got('dot')) {
      if (this.tok() !== 'name') {
        return null;
      }
      const sel: SelectorExpr = {
        kind: 'SelectorExpr',
        pos: t.pos,
        x: t,
        sel: this.name(),
      };
      t = sel;
    }
    if (this.tok() === 'operator' && this.op() === '<') {
      const head = t;
      if (head.kind !== 'Name' && head.kind !== 'SelectorExpr') {
        return null;
      }
      this.next();
      const args: TypeName[] = [];
      do {
        const arg = this.typeName();
        if (arg === null) {
          return null;
        }
        args.push(arg);
      } while (this.got('comma'));
      if (this.tok() !== 'operator' || this.op() !== '>') {
        return null;
      }
      this.next();
      t = {kind: 'GenericType', pos: head.pos, name: head, args};
    }
    while (this.tok() === 'lbrack') {
      this.next();
      if (this.tok() !== 'rbrack') {
        return null;
      }
      this.next();
      t = {kind: 'ArrayType', pos: t.pos, elem: t};
    }
    return t;
  }

  // ---- expressions ----------------------------------------------------------

  private expr(): Expr {
    const cond = this.binary(1);
    if (!this.got('question')) {
      return cond;
    }
    const then = this.expr();
    this.want('colon');
    const orelse = this.expr();
    return {kind: 'CondExpr', pos: cond.pos, cond, then, else: orelse};
  }

  private binary(minPrec: number): Expr {
    let x = this.unary();
    for (;;) {
      if (this.tok() !== 'operator') {
        break;
      }
      const op = this.op();
      const prec = this.scanner.prec;
      if (op === null || prec < minPrec || prec <= 0) {
        break;
      }
      this.next();
      const y = this.binary(prec + 1);
      x = {kind: 'BinaryExpr', pos: x.pos, op, x, y};
    }
    return x;
  }

  private unary(): Expr {
    if (this.tok() === 'operator') {
      const op = this.op();
      if (op === '-' || op === '+' || op === 'not') {
        const pos = this.pos();
        this.next();
        return {kind: 'UnaryExpr', pos, op, x: this.unary()};
      }
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let x = this.primary();
    for (;;) {
      if (this.got('dot')) {
        x = {kind: 'SelectorExpr', pos: x.pos, x, sel: this.name()};
        continue;
      }
      if (this.tok() === 'lparen') {
        x = this.callExpr(x, null);
        continue;
      }
      if (this.tok() === 'lbrack') {
        this.next();
        const offset = this.expr();
        this.want('rbrack');
        x = {kind: 'HistoryExpr', pos: x.pos, x, offset};
        continue;
      }
      if (this.tok() === 'operator' && this.op() === '<') {
        const typeArgs = this.tryParse(() => this.typeArgsThenLparen());
        if (typeArgs !== null) {
          x = this.callExpr(x, typeArgs);
          continue;
        }
      }
      break;
    }
    return x;
  }

  // Speculative: '<' type {',' type} '>' immediately followed by '(' — the
  // follow set that disambiguates array.new<float>(…) from a < b (tsc's
  // strategy with a stricter follow set).
  private typeArgsThenLparen(): TypeName[] | null {
    this.next(); // '<'
    const args: TypeName[] = [];
    do {
      const arg = this.typeName();
      if (arg === null) {
        return null;
      }
      args.push(arg);
    } while (this.got('comma'));
    if (this.tok() !== 'operator' || this.op() !== '>') {
      return null;
    }
    this.next();
    if (this.tok() !== 'lparen') {
      return null;
    }
    return args;
  }

  private callExpr(fun: Expr, typeArgs: readonly TypeName[] | null): Expr {
    this.want('lparen');
    const args: Arg[] = [];
    if (this.tok() !== 'rparen') {
      do {
        args.push(this.arg());
      } while (this.got('comma'));
    }
    this.want('rparen');
    return {kind: 'CallExpr', pos: fun.pos, fun, typeArgs, args};
  }

  private arg(): Arg {
    const pos = this.pos();
    const value = this.expr();
    if (value.kind === 'Name' && this.got('assign')) {
      return {kind: 'Arg', pos, name: value, value: this.expr()};
    }
    return {kind: 'Arg', pos, name: null, value};
  }

  private primary(): Expr {
    const pos = this.pos();
    switch (this.tok()) {
      case 'name':
        return this.name();
      case 'literal': {
        const lit: Expr = {
          kind: 'BasicLit',
          pos,
          litKind: this.scanner.kind ?? 'int',
          value: this.scanner.lit,
          bad: false,
        };
        this.next();
        return lit;
      }
      case 'lparen': {
        this.next();
        const x = this.expr();
        this.want('rparen');
        return {kind: 'ParenExpr', pos, x};
      }
      case 'lbrack': {
        this.next();
        const elems: Expr[] = [];
        do {
          elems.push(this.expr());
        } while (this.got('comma'));
        this.want('rbrack');
        return {kind: 'TupleExpr', pos, elems};
      }
      default:
        this.error(`expected expression, found '${this.tok()}'`);
        return this.badExpr(pos);
    }
  }

  private name(): Name {
    if (this.tok() === 'name') {
      const name: Name = {
        kind: 'Name',
        pos: this.pos(),
        value: this.scanner.lit,
      };
      this.next();
      return name;
    }
    this.error(`expected name, found '${this.tok()}'`);
    return {kind: 'Name', pos: this.pos(), value: ''};
  }
}
