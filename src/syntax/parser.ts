// Purpose: Recursive-descent parser — drives the incremental scanner via this.scanner with one token of lookahead; owns grammar and error recovery.

import type {Pos, PosBase} from '../base/pos';
import type {ErrorHandler} from '../base/print';
import type {
  Arg,
  BadExpr,
  BadStmt,
  Block,
  DeclMode,
  EnumMember,
  Expr,
  FieldDecl,
  File,
  FuncDecl,
  IfExpr,
  InterfaceDecl,
  InterfaceMethodDecl,
  MethodDecl,
  Name,
  Param,
  SelectorExpr,
  Stmt,
  SwitchArm,
  TypedParam,
  TuplePattern,
  TypeAnnotation,
  TypeName,
  TypeParam,
  StructMember,
} from './nodes';
import {AssignOp, COMPOUND_ASSIGN, Mode, NodeKind, ReceiverMode} from './nodes';
import {Scanner} from './scanner';
import {CONTEXTUAL_KEYWORDS, LitKind, Op, Tok, type TokenKind} from './tokens';

// Keywords that real Pine treats contextually: they act as keywords only in
// their governing production and as ordinary names anywhere else (corpus
// scripts use `type` as a parameter name, for example).
const SOFT_KEYWORDS: readonly TokenKind[] = CONTEXTUAL_KEYWORDS;

interface TypedMemberHead {
  readonly pos: Pos;
  readonly annotation: TypeAnnotation;
  readonly name: Name;
}

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

  private atName(): boolean {
    return this.tok() === Tok.Name || SOFT_KEYWORDS.includes(this.tok());
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
      this.stmtLine(stmtList);
      this.stmtEnd();
    }
    return {
      kind: NodeKind.File,
      pos,
      version: this.scanner.version,
      stmtList,
      eof: this.pos(),
    };
  }

  // One logical statement line: simple statements may chain with commas
  // (`int e = 0, int d = 0`, `zzHigh := high, zzLow := low`,
  // `line.delete(ln), ln := na`). Block-bearing statements never chain.
  private stmtLine(stmtList: Stmt[]): void {
    for (;;) {
      const stmt = this.stmt();
      stmtList.push(stmt);
      const chains =
        !this.blockEnded &&
        (stmt.kind === NodeKind.DeclStmt ||
          stmt.kind === NodeKind.AssignStmt ||
          stmt.kind === NodeKind.ExprStmt);
      if (!chains || !this.got(Tok.Comma)) {
        return;
      }
    }
  }

  // Lookahead at '[': does the balanced bracket group close on this logical
  // line and land on '='?
  private assignFollowsBrackets(): boolean {
    return this.lookAhead(() => {
      let depth = 0;
      do {
        const tok = this.tok();
        if (tok === Tok.Lbrack || tok === Tok.Lparen) {
          depth += 1;
        } else if (tok === Tok.Rbrack || tok === Tok.Rparen) {
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
      return this.tok() === Tok.Assign;
    });
  }

  private namedTypeDeclarationFollows(keyword: TokenKind): boolean {
    return this.lookAhead(() => {
      this.next();
      if (!this.atName()) {
        return false;
      }
      this.next();
      const typeParams =
        keyword === Tok.Struct || keyword === Tok.Type ? this.typeParams() : [];
      if (typeParams === null) {
        return false;
      }
      return (
        this.tok() === Tok.Newline ||
        (keyword === Tok.Type &&
          typeParams.length === 0 &&
          this.tok() === Tok.Assign)
      );
    });
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
    return {kind: NodeKind.BadStmt, pos};
  }

  private badExpr(pos: Pos): BadExpr {
    return {kind: NodeKind.BadExpr, pos};
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
        return {kind: NodeKind.BreakStmt, pos};
      case Tok.Continue:
        this.next();
        return {kind: NodeKind.ContinueStmt, pos};
      case Tok.Lbrack:
        // `[a, b] = f()` declares; a bare `[a, b]` (a block's tuple value)
        // is an expression statement.
        if (this.assignFollowsBrackets()) {
          return this.tupleDecl(pos, Mode.None);
        }
        break;
      case Tok.If:
      case Tok.For:
      case Tok.While:
      case Tok.Switch:
        return {kind: NodeKind.ExprStmt, pos, x: this.controlExpr()};
      // Contextual keywords: these begin declarations only when the
      // declaration shape actually follows; otherwise they are ordinary
      // names and fall through to the expression path.
      case Tok.Import:
        if (
          this.lookAhead(() => {
            this.next();
            return this.tok() === Tok.Name;
          })
        ) {
          return this.importStmt(pos);
        }
        break;
      case Tok.Struct:
      case Tok.Type:
      case Tok.Interface:
      case Tok.Enum: {
        const keyword = this.tok();
        if (this.namedTypeDeclarationFollows(keyword)) {
          this.next();
          if (keyword === Tok.Type) {
            return this.typeOrAliasDecl(pos, false);
          }
          if (keyword === Tok.Struct) {
            return this.structDecl(pos, false, Tok.Struct);
          }
          if (keyword === Tok.Interface) {
            return this.interfaceDecl(pos, false);
          }
          return this.enumDecl(pos, false);
        }
        break;
      }
      case Tok.Export: {
        const isDecl = this.lookAhead(() => {
          this.next();
          const keyword = this.tok();
          if (
            keyword === Tok.Struct ||
            keyword === Tok.Type ||
            keyword === Tok.Interface ||
            keyword === Tok.Enum
          ) {
            if (this.namedTypeDeclarationFollows(keyword)) {
              return true;
            }
          }
          return this.atName() && this.arrowFollowsParens();
        });
        if (!isDecl) {
          break;
        }
        this.next();
        const keyword = this.tok();
        if (
          (keyword === Tok.Struct ||
            keyword === Tok.Type ||
            keyword === Tok.Interface ||
            keyword === Tok.Enum) &&
          this.namedTypeDeclarationFollows(keyword)
        ) {
          this.next();
          if (keyword === Tok.Struct) {
            return this.structDecl(pos, true, Tok.Struct);
          }
          if (keyword === Tok.Type) {
            return this.typeOrAliasDecl(pos, true);
          }
          if (keyword === Tok.Interface) {
            return this.interfaceDecl(pos, true);
          }
          return this.enumDecl(pos, true);
        }
        return this.funcDeclRest(pos, true);
      }
      default:
        break;
    }

    // `float x = …`, `array<float> xs = …`, `m.Type v = …` — commit to a
    // typed declaration only when the full head shape (type, name, '=') is
    // present; otherwise this is an expression-led statement.
    if (this.atName()) {
      const typed = this.tryParse(() => this.typedDeclHead());
      if (typed !== null) {
        const init = this.expr();
        return {
          kind: NodeKind.DeclStmt,
          pos,
          mode: Mode.None,
          declType: typed.declType,
          target: typed.target,
          init,
        };
      }
      // `f(x, y = 0) => …` — a function declaration looks like a call until
      // the arrow; peek across the balanced parens for it.
      if (this.arrowFollowsParens()) {
        return this.funcDeclRest(pos, false);
      }
    }

    const x = this.expr();
    if (this.got(Tok.Assign)) {
      const init = this.expr();
      if (x.kind !== NodeKind.Name) {
        this.error('cannot declare this expression as a variable', x.pos);
        return this.badStmt(pos);
      }
      return {
        kind: NodeKind.DeclStmt,
        pos,
        mode: Mode.None,
        declType: null,
        target: x,
        init,
      };
    }
    if (this.tok() === Tok.Define || this.tok() === Tok.AssignOp) {
      const op = this.assignOp();
      const value = this.expr();
      return {kind: NodeKind.AssignStmt, pos, op, target: x, value};
    }
    return {kind: NodeKind.ExprStmt, pos, x};
  }

  private assignOp(): AssignOp {
    if (this.got(Tok.Define)) {
      return AssignOp.Define;
    }
    const base = this.op();
    this.next();
    const op = base === null ? undefined : COMPOUND_ASSIGN[base];
    if (op === undefined) {
      this.error('malformed compound assignment');
      return AssignOp.Define;
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
        kind: NodeKind.DeclStmt,
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
    return {kind: NodeKind.DeclStmt, pos, mode, declType: null, target, init};
  }

  // Speculative: type name '=' — consumes through the '='.
  private typedDeclHead(): {
    declType: TypeAnnotation;
    target: Name;
  } | null {
    const pos = this.pos();
    const typeName = this.typeName();
    if (typeName === null || !this.atName()) {
      return null;
    }
    const target = this.name();
    if (this.tok() !== Tok.Assign) {
      return null;
    }
    this.next();
    return {
      declType: {
        kind: NodeKind.TypeAnnotation,
        pos,
        qualifier: null,
        name: typeName,
      },
      target,
    };
  }

  private tupleDecl(pos: Pos, mode: DeclMode): Stmt {
    const target = this.tuplePattern();
    this.want(Tok.Assign);
    const init = this.expr();
    return {kind: NodeKind.DeclStmt, pos, mode, declType: null, target, init};
  }

  private tuplePattern(): TuplePattern {
    const pos = this.pos();
    this.want(Tok.Lbrack);
    const elems: Name[] = [];
    do {
      elems.push(this.name());
    } while (this.got(Tok.Comma));
    this.want(Tok.Rbrack);
    return {kind: NodeKind.TuplePattern, pos, elems};
  }

  // ---- types ----------------------------------------------------------------

  // Speculation-friendly: returns null on any mismatch, reports nothing.
  private typeName(): TypeName | null {
    if (!this.atName()) {
      return null;
    }
    let t: TypeName = this.name();
    if (this.got(Tok.Dot)) {
      if (!this.atName()) {
        return null;
      }
      const sel: SelectorExpr = {
        kind: NodeKind.SelectorExpr,
        pos: t.pos,
        x: t,
        sel: this.name(),
      };
      t = sel;
    }
    if (this.tok() === Tok.Operator && this.op() === Op.Lt) {
      const head = t;
      if (head.kind !== NodeKind.Name && head.kind !== NodeKind.SelectorExpr) {
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
      t = {kind: NodeKind.GenericType, pos: head.pos, name: head, args};
    }
    while (this.tok() === Tok.Lbrack) {
      this.next();
      if (this.tok() !== Tok.Rbrack) {
        return null;
      }
      this.next();
      t = {kind: NodeKind.ArrayType, pos: t.pos, elem: t};
    }
    return t;
  }

  // Optional `<T: Constraint, ...>` on nominal structs. A present list is
  // all-or-nothing and every parameter is constrained in this first slice.
  private typeParams(): TypeParam[] | null {
    if (this.tok() !== Tok.Operator || this.op() !== Op.Lt) {
      return [];
    }
    this.next();
    const params: TypeParam[] = [];
    for (;;) {
      if (!this.atName()) {
        return null;
      }
      const pos = this.pos();
      const name = this.name();
      if (!this.got(Tok.Colon)) {
        return null;
      }
      const constraint = this.typeName();
      if (constraint === null) {
        return null;
      }
      params.push({kind: NodeKind.TypeParam, pos, name, constraint});
      if (!this.got(Tok.Comma)) {
        break;
      }
    }
    if (this.tok() !== Tok.Operator || this.op() !== Op.Gt) {
      return null;
    }
    this.next();
    return params;
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
    return {kind: NodeKind.CondExpr, pos: cond.pos, cond, then, else: orelse};
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
      x = {kind: NodeKind.BinaryExpr, pos: x.pos, op, x, y};
    }
    return x;
  }

  private unary(): Expr {
    if (this.tok() === Tok.Operator) {
      const op = this.op();
      if (op === Op.Minus || op === Op.Plus || op === Op.Not) {
        const pos = this.pos();
        this.next();
        return {kind: NodeKind.UnaryExpr, pos, op, x: this.unary()};
      }
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let x = this.primary();
    for (;;) {
      if (this.got(Tok.Dot)) {
        x = {kind: NodeKind.SelectorExpr, pos: x.pos, x, sel: this.name()};
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
        x = {kind: NodeKind.HistoryExpr, pos: x.pos, x, offset};
        continue;
      }
      if (this.tok() === Tok.Operator && this.op() === Op.Lt) {
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
    return {kind: NodeKind.CallExpr, pos: fun.pos, fun, typeArgs, args};
  }

  private arg(): Arg {
    const pos = this.pos();
    const value = this.expr();
    if (value.kind === NodeKind.Name && this.got(Tok.Assign)) {
      return {kind: NodeKind.Arg, pos, name: value, value: this.expr()};
    }
    return {kind: NodeKind.Arg, pos, name: null, value};
  }

  private primary(): Expr {
    const pos = this.pos();
    if (this.atName()) {
      return this.name();
    }
    switch (this.tok()) {
      case Tok.If:
      case Tok.For:
      case Tok.While:
      case Tok.Switch:
        return this.controlExpr();
      case Tok.This:
        this.next();
        return {kind: NodeKind.ThisExpr, pos};
      case Tok.Literal: {
        const lit: Expr = {
          kind: NodeKind.BasicLit,
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
        return {kind: NodeKind.ParenExpr, pos, x};
      }
      case Tok.Lbrack: {
        this.next();
        const elems: Expr[] = [];
        do {
          elems.push(this.expr());
        } while (this.got(Tok.Comma));
        this.want(Tok.Rbrack);
        return {kind: NodeKind.TupleExpr, pos, elems};
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
      this.stmtLine(stmtList);
      this.stmtEnd();
    }
    this.want(Tok.Dedent);
    this.blockEnded = true;
    return {kind: NodeKind.Block, pos, stmtList};
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
    return {kind: NodeKind.IfExpr, pos, cond, then, else: orelse};
  }

  private whileExpr(): Expr {
    const pos = this.pos();
    this.next(); // 'while'
    const cond = this.expr();
    const body = this.block();
    return {kind: NodeKind.WhileExpr, pos, cond, body};
  }

  // `for i = a to b [by s]` | `for x in xs` | `for [i, v] in xs`.
  private forExpr(): Expr {
    const pos = this.pos();
    this.next(); // 'for'
    if (this.tok() === Tok.Lbrack) {
      const target = this.tuplePattern();
      this.want(Tok.In);
      const x = this.expr();
      return {kind: NodeKind.ForInExpr, pos, target, x, body: this.block()};
    }
    const index = this.name();
    if (this.got(Tok.In)) {
      const x = this.expr();
      return {
        kind: NodeKind.ForInExpr,
        pos,
        target: index,
        x,
        body: this.block(),
      };
    }
    this.want(Tok.Assign);
    const from = this.expr();
    this.want(Tok.To);
    const to = this.expr();
    const step = this.got(Tok.By) ? this.expr() : null;
    return {
      kind: NodeKind.ForExpr,
      pos,
      index,
      from,
      to,
      step,
      body: this.block(),
    };
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
      arms.push({kind: NodeKind.SwitchArm, pos: armPos, pattern, body});
    }
    this.want(Tok.Dedent);
    this.blockEnded = true;
    return {kind: NodeKind.SwitchExpr, pos, subject, arms};
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

  private funcDeclRest(pos: Pos, exported: boolean): FuncDecl {
    const name = this.name();
    const params = this.params();
    this.want(Tok.Arrow);
    const body = this.tok() === Tok.Newline ? this.block() : this.expr();
    return {kind: NodeKind.FuncDecl, pos, exported, name, params, body};
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
      if (!this.atName()) {
        return null;
      }
      const qualifier = this.name();
      const typeName = this.typeName();
      if (typeName === null || !this.atName()) {
        return null;
      }
      return {qualifier, typeName, name: this.name()};
    });
    if (qualified !== null) {
      return this.finishParam(
        pos,
        {
          kind: NodeKind.TypeAnnotation,
          pos,
          qualifier: qualified.qualifier,
          name: qualified.typeName,
        },
        qualified.name,
      );
    }
    const typed = this.tryParse(() => {
      const typeName = this.typeName();
      if (typeName === null || !this.atName()) {
        return null;
      }
      return {typeName, name: this.name()};
    });
    if (typed !== null) {
      return this.finishParam(
        pos,
        {
          kind: NodeKind.TypeAnnotation,
          pos,
          qualifier: null,
          name: typed.typeName,
        },
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
    return {kind: NodeKind.Param, pos, paramType, name, defaultValue};
  }

  // ---- top-level declarations ----------------------------------------------

  // `import owner/name/version [as alias]` — the path is one atomic literal
  // produced by a scanner rescan; segmentation is the import resolver's job.
  private importStmt(pos: Pos): Stmt {
    this.next(); // 'import'
    if (this.tok() !== Tok.Name) {
      this.error(`expected import path, found '${this.tok()}'`);
      this.advance(Tok.Newline, Tok.Dedent);
      return this.badStmt(pos);
    }
    this.scanner.rescanImportPath();
    const path: Expr = {
      kind: NodeKind.BasicLit,
      pos: this.pos(),
      litKind: this.scanner.kind ?? LitKind.Path,
      value: this.scanner.lit,
      bad: false,
    };
    this.next();
    const alias = this.got(Tok.As) ? this.name() : null;
    if (path.kind !== NodeKind.BasicLit) {
      return this.badStmt(pos);
    }
    return {kind: NodeKind.ImportStmt, pos, path, alias};
  }

  private typeOrAliasDecl(pos: Pos, exported: boolean): Stmt {
    const name = this.name();
    if (this.got(Tok.Assign)) {
      const aliasedType = this.typeName();
      if (aliasedType !== null) {
        return {
          kind: NodeKind.TypeAliasDecl,
          pos,
          exported,
          name,
          aliasedType,
        };
      }
      this.error('expected aliased type');
      return {
        kind: NodeKind.TypeAliasDecl,
        pos,
        exported,
        name,
        aliasedType: {kind: NodeKind.Name, pos: this.pos(), value: ''},
      };
    }
    return this.structDeclRest(pos, exported, Tok.Type, name);
  }

  private interfaceDecl(pos: Pos, exported: boolean): InterfaceDecl {
    const name = this.name();
    this.want(Tok.Newline);
    this.want(Tok.Indent);
    const methods: InterfaceMethodDecl[] = [];
    while (this.tok() !== Tok.Dedent && this.tok() !== Tok.Eof) {
      if (this.got(Tok.Newline)) {
        continue;
      }
      if (this.tok() === Tok.Indent) {
        this.error('interface methods cannot have bodies');
        this.skipBlock();
        continue;
      }
      this.blockEnded = false;
      const method = this.interfaceMethodDecl();
      if (method !== null) {
        methods.push(method);
      }
      this.stmtEnd();
    }
    this.want(Tok.Dedent);
    this.blockEnded = true;
    return {kind: NodeKind.InterfaceDecl, pos, exported, name, methods};
  }

  private interfaceMethodDecl(): InterfaceMethodDecl | null {
    const head = this.typedMemberHead();
    if (head === null) {
      this.error('expected interface method signature');
      this.advance(Tok.Newline, Tok.Dedent);
      return null;
    }
    if (this.tok() !== Tok.Lparen) {
      this.error('interface members must be method signatures');
      this.advance(Tok.Newline, Tok.Dedent);
      return null;
    }
    const params = this.typedParams();
    for (const param of params) {
      if (param.defaultValue !== null) {
        this.error(
          'interface method parameters cannot have defaults',
          param.pos,
        );
      }
    }
    const receiverMode = this.got(Tok.Const)
      ? ReceiverMode.Const
      : ReceiverMode.Mutable;
    if (this.got(Tok.Arrow)) {
      this.error('interface methods cannot have bodies', head.pos);
      if (this.got(Tok.Newline)) {
        if (this.tok() === Tok.Indent) {
          this.skipBlock();
        }
        this.blockEnded = true;
      } else {
        this.advance(Tok.Newline, Tok.Dedent);
      }
    }
    return {
      kind: NodeKind.InterfaceMethodDecl,
      pos: head.pos,
      result: head.annotation,
      name: head.name,
      params,
      receiverMode,
    };
  }

  private structDecl(
    pos: Pos,
    exported: boolean,
    writtenKeyword: 'struct' | 'type',
  ): Stmt {
    return this.structDeclRest(pos, exported, writtenKeyword, this.name());
  }

  // `struct Name` and block-form `type Name` contain source-ordered fields
  // and methods. A method is distinguished by the `(` after its typed name.
  private structDeclRest(
    pos: Pos,
    exported: boolean,
    writtenKeyword: 'struct' | 'type',
    name: Name,
  ): Stmt {
    const parsedTypeParams = this.typeParams();
    if (parsedTypeParams === null) {
      this.error('expected constrained type parameter list');
      this.advance(Tok.Newline, Tok.Dedent);
    }
    const typeParams = parsedTypeParams ?? [];
    this.want(Tok.Newline);
    this.want(Tok.Indent);
    const members: StructMember[] = [];
    while (this.tok() !== Tok.Dedent && this.tok() !== Tok.Eof) {
      if (this.got(Tok.Newline)) {
        continue;
      }
      this.blockEnded = false;
      members.push(this.structMember());
      this.stmtEnd();
    }
    this.want(Tok.Dedent);
    this.blockEnded = true;
    return {
      kind: NodeKind.StructDecl,
      pos,
      exported,
      writtenKeyword,
      name,
      typeParams,
      members,
    };
  }

  private structMember(): StructMember {
    const pos = this.pos();
    const head = this.typedMemberHead();
    if (head === null) {
      this.error('expected field type');
      const name = this.name();
      return this.finishFieldDecl(
        pos,
        {
          kind: NodeKind.TypeAnnotation,
          pos,
          qualifier: null,
          name: {kind: NodeKind.Name, pos, value: ''},
        },
        name,
      );
    }
    if (this.tok() === Tok.Lparen) {
      return this.methodDecl(head);
    }
    return this.finishFieldDecl(pos, head.annotation, head.name);
  }

  private methodDecl(head: TypedMemberHead): MethodDecl {
    const params = this.typedParams();
    const receiverMode = this.got(Tok.Const)
      ? ReceiverMode.Const
      : ReceiverMode.Mutable;
    this.want(Tok.Arrow);
    const body = this.tok() === Tok.Newline ? this.block() : this.expr();
    return {
      kind: NodeKind.MethodDecl,
      pos: head.pos,
      result: head.annotation,
      name: head.name,
      params,
      receiverMode,
      body,
    };
  }

  private typedParams(): TypedParam[] {
    this.want(Tok.Lparen);
    const params: TypedParam[] = [];
    if (this.tok() !== Tok.Rparen) {
      do {
        const param = this.param();
        if (param.paramType !== null) {
          params.push({...param, paramType: param.paramType});
          continue;
        }
        this.error('method parameters require explicit types', param.pos);
        params.push({
          ...param,
          paramType: {
            kind: NodeKind.TypeAnnotation,
            pos: param.pos,
            qualifier: null,
            name: {kind: NodeKind.Name, pos: param.pos, value: ''},
          },
        });
      } while (this.got(Tok.Comma));
    }
    this.want(Tok.Rparen);
    return params;
  }

  private typedMemberHead(): TypedMemberHead | null {
    const pos = this.pos();
    const qualified = this.tryParse(() => {
      if (!this.atName() && this.tok() !== Tok.Varip) {
        return null;
      }
      const reserved = this.tok() === Tok.Varip;
      const qualifier: Name = reserved
        ? {kind: NodeKind.Name, pos: this.pos(), value: Tok.Varip}
        : this.name();
      if (reserved) {
        this.next();
      }
      const typeName = this.typeName();
      if (typeName === null || !this.atName()) {
        return null;
      }
      return {qualifier, typeName, name: this.name()};
    });
    if (qualified !== null) {
      return {
        pos,
        annotation: {
          kind: NodeKind.TypeAnnotation,
          pos,
          qualifier: qualified.qualifier,
          name: qualified.typeName,
        },
        name: qualified.name,
      };
    }
    const typed = this.tryParse(() => {
      const typeName = this.typeName();
      if (typeName === null || !this.atName()) {
        return null;
      }
      return {typeName, name: this.name()};
    });
    if (typed !== null) {
      return {
        pos,
        annotation: {
          kind: NodeKind.TypeAnnotation,
          pos,
          qualifier: null,
          name: typed.typeName,
        },
        name: typed.name,
      };
    }
    return null;
  }

  private finishFieldDecl(
    pos: Pos,
    fieldType: TypeAnnotation,
    name: Name,
  ): FieldDecl {
    const defaultValue = this.got(Tok.Assign) ? this.expr() : null;
    return {kind: NodeKind.FieldDecl, pos, fieldType, name, defaultValue};
  }

  // `enum Name` with indented `member [= title]` lines.
  private enumDecl(pos: Pos, exported: boolean): Stmt {
    const name = this.name();
    this.want(Tok.Newline);
    this.want(Tok.Indent);
    const members: EnumMember[] = [];
    while (this.tok() !== Tok.Dedent && this.tok() !== Tok.Eof) {
      if (this.got(Tok.Newline)) {
        continue;
      }
      const memberPos = this.pos();
      const memberName = this.name();
      const title = this.got(Tok.Assign) ? this.expr() : null;
      members.push({
        kind: NodeKind.EnumMember,
        pos: memberPos,
        name: memberName,
        title,
      });
      this.stmtEnd();
    }
    this.want(Tok.Dedent);
    this.blockEnded = true;
    return {kind: NodeKind.EnumDecl, pos, exported, name, members};
  }

  private name(): Name {
    if (this.tok() === Tok.Name) {
      const name: Name = {
        kind: NodeKind.Name,
        pos: this.pos(),
        value: this.scanner.lit,
      };
      this.next();
      return name;
    }
    if (SOFT_KEYWORDS.includes(this.tok())) {
      const name: Name = {
        kind: NodeKind.Name,
        pos: this.pos(),
        value: this.tok(),
      };
      this.next();
      return name;
    }
    this.error(`expected name, found '${this.tok()}'`);
    return {kind: NodeKind.Name, pos: this.pos(), value: ''};
  }
}
