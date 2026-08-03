// Purpose: Recursive-descent parser — drives the incremental scanner via this.scanner with one token of lookahead; owns grammar and error recovery.

import type {Pos, PosBase} from '../base/pos';
import type {ErrorHandler} from '../base/print';
import type {
  Arg,
  AssignOp,
  BadExpr,
  BadStmt,
  Block,
  DeclMode,
  Expr,
  File,
  FuncDecl,
  IfExpr,
  Name,
  Param,
  SelectorExpr,
  Stmt,
  SwitchArm,
  TuplePattern,
  TypeAnnotation,
  TypeName,
} from './nodes';
import {Scanner} from './scanner';
import {Tok, type Op, type TokenKind} from './tokens';

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
  // Set when the construct just parsed ended by closing an indented block;
  // such statements are already terminated and need no trailing newline.
  private blockEnded = false;

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
    while (this.tok() !== Tok.Eof && !follow.includes(this.tok())) {
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

  // Pure lookahead: runs silent and ALWAYS restores, regardless of result.
  private lookAhead<T>(production: () => T): T {
    const state = this.scanner.checkpoint();
    this.silent += 1;
    try {
      return production();
    } finally {
      this.silent -= 1;
      this.scanner.restore(state);
    }
  }

  // ---- file -----------------------------------------------------------------

  parseFile(): File {
    this.next();
    const pos = this.pos();
    const stmtList: Stmt[] = [];
    while (this.tok() !== Tok.Eof) {
      if (this.got(Tok.Newline)) {
        continue;
      }
      if (this.got(Tok.Dedent)) {
        continue; // imbalance already reported by the scanner
      }
      if (this.tok() === Tok.Indent) {
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
    if (this.blockEnded) {
      return;
    }
    if (this.got(Tok.Newline)) {
      return;
    }
    if (this.tok() === Tok.Eof || this.tok() === Tok.Dedent) {
      return;
    }
    this.error(`expected end of statement, found '${this.tok()}'`);
    this.advance(Tok.Newline, Tok.Dedent);
    this.got(Tok.Newline);
  }

  // Consume a balanced indent…dedent region (recovery only).
  private skipBlock(): void {
    let depth = 0;
    do {
      if (this.tok() === Tok.Indent) {
        depth += 1;
      } else if (this.tok() === Tok.Dedent) {
        depth -= 1;
      }
      this.next();
    } while (depth > 0 && this.tok() !== Tok.Eof);
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
    this.blockEnded = false;
    switch (this.tok()) {
      case Tok.Var:
      case Tok.Varip:
      case Tok.Const: {
        const mode = this.tok() as DeclMode;
        this.next();
        return this.declRest(pos, mode);
      }
      case Tok.Break:
        this.next();
        return {kind: 'BreakStmt', pos};
      case Tok.Continue:
        this.next();
        return {kind: 'ContinueStmt', pos};
      case Tok.Lbrack:
        return this.tupleDecl(pos, 'none');
      case Tok.If:
      case Tok.For:
      case Tok.While:
      case Tok.Switch:
        return {kind: 'ExprStmt', pos, x: this.controlExpr()};
      case Tok.Import:
      case Tok.Type:
      case Tok.Enum:
      case Tok.Export:
      case Tok.Method:
        this.error(`'${this.tok()}' statements are not implemented yet`);
        this.advance(Tok.Newline, Tok.Dedent);
        return this.badStmt(pos);
      default:
        break;
    }

    // `float x = …`, `array<float> xs = …`, `m.Type v = …` — commit to a
    // typed declaration only when the full head shape (type, name, '=') is
    // present; otherwise this is an expression-led statement.
    if (this.tok() === Tok.Name) {
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
      // `f(x, y = 0) => …` — a function declaration looks like a call until
      // the arrow; peek across the balanced parens for it.
      if (this.arrowFollowsParens()) {
        return this.funcDeclRest(pos, false, false);
      }
    }

    const x = this.expr();
    if (this.got(Tok.Assign)) {
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
    if (this.tok() === Tok.Define || this.tok() === Tok.AssignOp) {
      const op = this.assignOp();
      const value = this.expr();
      return {kind: 'AssignStmt', pos, op, target: x, value};
    }
    return {kind: 'ExprStmt', pos, x};
  }

  private assignOp(): AssignOp {
    if (this.got(Tok.Define)) {
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
    if (this.tok() === Tok.Lbrack) {
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
    this.want(Tok.Assign);
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
    if (typeName === null || this.tok() !== Tok.Name) {
      return null;
    }
    const target = this.name();
    if (this.tok() !== Tok.Assign) {
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
    this.want(Tok.Assign);
    const init = this.expr();
    return {kind: 'DeclStmt', pos, mode, declType: null, target, init};
  }

  private tuplePattern(): TuplePattern {
    const pos = this.pos();
    this.want(Tok.Lbrack);
    const elems: Name[] = [];
    do {
      elems.push(this.name());
    } while (this.got(Tok.Comma));
    this.want(Tok.Rbrack);
    return {kind: 'TuplePattern', pos, elems};
  }

  // ---- types ----------------------------------------------------------------

  // Speculation-friendly: returns null on any mismatch, reports nothing.
  private typeName(): TypeName | null {
    if (this.tok() !== Tok.Name) {
      return null;
    }
    let t: TypeName = this.name();
    if (this.got(Tok.Dot)) {
      if (this.tok() !== Tok.Name) {
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
    if (this.tok() === Tok.Operator && this.op() === '<') {
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
      } while (this.got(Tok.Comma));
      if (this.tok() !== Tok.Operator || this.op() !== '>') {
        return null;
      }
      this.next();
      t = {kind: 'GenericType', pos: head.pos, name: head, args};
    }
    while (this.tok() === Tok.Lbrack) {
      this.next();
      if (this.tok() !== Tok.Rbrack) {
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
    if (!this.got(Tok.Question)) {
      return cond;
    }
    const then = this.expr();
    this.want(Tok.Colon);
    const orelse = this.expr();
    return {kind: 'CondExpr', pos: cond.pos, cond, then, else: orelse};
  }

  private binary(minPrec: number): Expr {
    let x = this.unary();
    for (;;) {
      if (this.tok() !== Tok.Operator) {
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
    if (this.tok() === Tok.Operator) {
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
      if (this.got(Tok.Dot)) {
        x = {kind: 'SelectorExpr', pos: x.pos, x, sel: this.name()};
        continue;
      }
      if (this.tok() === Tok.Lparen) {
        x = this.callExpr(x, null);
        continue;
      }
      if (this.tok() === Tok.Lbrack) {
        this.next();
        const offset = this.expr();
        this.want(Tok.Rbrack);
        x = {kind: 'HistoryExpr', pos: x.pos, x, offset};
        continue;
      }
      if (this.tok() === Tok.Operator && this.op() === '<') {
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
    } while (this.got(Tok.Comma));
    if (this.tok() !== Tok.Operator || this.op() !== '>') {
      return null;
    }
    this.next();
    if (this.tok() !== Tok.Lparen) {
      return null;
    }
    return args;
  }

  private callExpr(fun: Expr, typeArgs: readonly TypeName[] | null): Expr {
    this.want(Tok.Lparen);
    const args: Arg[] = [];
    if (this.tok() !== Tok.Rparen) {
      do {
        args.push(this.arg());
      } while (this.got(Tok.Comma));
    }
    this.want(Tok.Rparen);
    return {kind: 'CallExpr', pos: fun.pos, fun, typeArgs, args};
  }

  private arg(): Arg {
    const pos = this.pos();
    const value = this.expr();
    if (value.kind === 'Name' && this.got(Tok.Assign)) {
      return {kind: 'Arg', pos, name: value, value: this.expr()};
    }
    return {kind: 'Arg', pos, name: null, value};
  }

  private primary(): Expr {
    const pos = this.pos();
    switch (this.tok()) {
      case Tok.If:
      case Tok.For:
      case Tok.While:
      case Tok.Switch:
        return this.controlExpr();
      case Tok.Name:
        return this.name();
      case Tok.Literal: {
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
      case Tok.Lparen: {
        this.next();
        const x = this.expr();
        this.want(Tok.Rparen);
        return {kind: 'ParenExpr', pos, x};
      }
      case Tok.Lbrack: {
        this.next();
        const elems: Expr[] = [];
        do {
          elems.push(this.expr());
        } while (this.got(Tok.Comma));
        this.want(Tok.Rbrack);
        return {kind: 'TupleExpr', pos, elems};
      }
      default:
        this.error(`expected expression, found '${this.tok()}'`);
        return this.badExpr(pos);
    }
  }

  // ---- blocks and control structures ---------------------------------------

  // NEWLINE INDENT stmts DEDENT. Sets blockEnded so the enclosing statement
  // needs no trailing newline of its own.
  private block(): Block {
    this.want(Tok.Newline);
    this.want(Tok.Indent);
    const pos = this.pos();
    const stmtList: Stmt[] = [];
    while (this.tok() !== Tok.Dedent && this.tok() !== Tok.Eof) {
      if (this.got(Tok.Newline)) {
        continue;
      }
      if (this.tok() === Tok.Indent) {
        this.error('unexpected indentation');
        this.skipBlock();
        continue;
      }
      stmtList.push(this.stmt());
      this.stmtEnd();
    }
    this.want(Tok.Dedent);
    this.blockEnded = true;
    return {kind: 'Block', pos, stmtList};
  }

  // Control structures are expressions; at statement position they ride in
  // an ExprStmt.
  private controlExpr(): Expr {
    switch (this.tok()) {
      case Tok.If:
        return this.ifExpr();
      case Tok.For:
        return this.forExpr();
      case Tok.While:
        return this.whileExpr();
      case Tok.Switch:
        return this.switchExpr();
      default:
        this.error(`expected control structure, found '${this.tok()}'`);
        return this.badExpr(this.pos());
    }
  }

  private ifExpr(): IfExpr {
    const pos = this.pos();
    this.next(); // 'if'
    const cond = this.expr();
    const then = this.block();
    let orelse: IfExpr | Block | null = null;
    if (this.got(Tok.Else)) {
      orelse = this.tok() === Tok.If ? this.ifExpr() : this.block();
    }
    return {kind: 'IfExpr', pos, cond, then, else: orelse};
  }

  private whileExpr(): Expr {
    const pos = this.pos();
    this.next(); // 'while'
    const cond = this.expr();
    const body = this.block();
    return {kind: 'WhileExpr', pos, cond, body};
  }

  // `for i = a to b [by s]` | `for x in xs` | `for [i, v] in xs`.
  private forExpr(): Expr {
    const pos = this.pos();
    this.next(); // 'for'
    if (this.tok() === Tok.Lbrack) {
      const target = this.tuplePattern();
      this.want(Tok.In);
      const x = this.expr();
      return {kind: 'ForInExpr', pos, target, x, body: this.block()};
    }
    const index = this.name();
    if (this.got(Tok.In)) {
      const x = this.expr();
      return {kind: 'ForInExpr', pos, target: index, x, body: this.block()};
    }
    this.want(Tok.Assign);
    const from = this.expr();
    this.want(Tok.To);
    const to = this.expr();
    const step = this.got(Tok.By) ? this.expr() : null;
    return {kind: 'ForExpr', pos, index, from, to, step, body: this.block()};
  }

  // `switch [subject]` with `pattern => body` arms; a bare `=>` arm is the
  // default. Arm bodies are inline expressions or indented blocks.
  private switchExpr(): Expr {
    const pos = this.pos();
    this.next(); // 'switch'
    const subject = this.tok() === Tok.Newline ? null : this.expr();
    this.want(Tok.Newline);
    this.want(Tok.Indent);
    const arms: SwitchArm[] = [];
    while (this.tok() !== Tok.Dedent && this.tok() !== Tok.Eof) {
      if (this.got(Tok.Newline)) {
        continue;
      }
      const armPos = this.pos();
      const pattern = this.tok() === Tok.Arrow ? null : this.expr();
      this.want(Tok.Arrow);
      let body: Expr | Block;
      if (this.tok() === Tok.Newline) {
        body = this.block();
      } else {
        body = this.expr();
        this.stmtEnd();
      }
      arms.push({kind: 'SwitchArm', pos: armPos, pattern, body});
    }
    this.want(Tok.Dedent);
    this.blockEnded = true;
    return {kind: 'SwitchExpr', pos, subject, arms};
  }

  // ---- function declarations -----------------------------------------------

  // At a statement-leading name: does `name ( … )` close on this logical line
  // and land on '=>'? Pure lookahead over the balanced parens; a newline
  // token inside means the statement broke before the parens closed.
  private arrowFollowsParens(): boolean {
    return this.lookAhead(() => {
      this.next(); // the leading name
      if (this.tok() !== Tok.Lparen) {
        return false;
      }
      let depth = 0;
      do {
        const tok = this.tok();
        if (tok === Tok.Lparen || tok === Tok.Lbrack) {
          depth += 1;
        } else if (tok === Tok.Rparen || tok === Tok.Rbrack) {
          depth -= 1;
        } else if (
          tok === Tok.Eof ||
          tok === Tok.Newline ||
          tok === Tok.Indent ||
          tok === Tok.Dedent
        ) {
          return false;
        }
        this.next();
      } while (depth > 0);
      return this.tok() === Tok.Arrow;
    });
  }

  private funcDeclRest(pos: Pos, exported: boolean, method: boolean): FuncDecl {
    const name = this.name();
    const params = this.params();
    this.want(Tok.Arrow);
    const body = this.tok() === Tok.Newline ? this.block() : this.expr();
    return {kind: 'FuncDecl', pos, exported, method, name, params, body};
  }

  private params(): Param[] {
    this.want(Tok.Lparen);
    const params: Param[] = [];
    if (this.tok() !== Tok.Rparen) {
      do {
        params.push(this.param());
      } while (this.got(Tok.Comma));
    }
    this.want(Tok.Rparen);
    return params;
  }

  // `[qualifier] [type] name [= default]` — longest shape first, each
  // committed only when the trailing name is present.
  private param(): Param {
    const pos = this.pos();
    const qualified = this.tryParse(() => {
      if (this.tok() !== Tok.Name) {
        return null;
      }
      const qualifier = this.name();
      const typeName = this.typeName();
      if (typeName === null || this.tok() !== Tok.Name) {
        return null;
      }
      return {qualifier, typeName, name: this.name()};
    });
    if (qualified !== null) {
      return this.finishParam(
        pos,
        {
          kind: 'TypeAnnotation',
          pos,
          qualifier: qualified.qualifier,
          name: qualified.typeName,
        },
        qualified.name,
      );
    }
    const typed = this.tryParse(() => {
      const typeName = this.typeName();
      if (typeName === null || this.tok() !== Tok.Name) {
        return null;
      }
      return {typeName, name: this.name()};
    });
    if (typed !== null) {
      return this.finishParam(
        pos,
        {kind: 'TypeAnnotation', pos, qualifier: null, name: typed.typeName},
        typed.name,
      );
    }
    return this.finishParam(pos, null, this.name());
  }

  private finishParam(
    pos: Pos,
    paramType: TypeAnnotation | null,
    name: Name,
  ): Param {
    const defaultValue = this.got(Tok.Assign) ? this.expr() : null;
    return {kind: 'Param', pos, paramType, name, defaultValue};
  }

  private name(): Name {
    if (this.tok() === Tok.Name) {
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
