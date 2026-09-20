// Purpose: Node end positions — endPos() finds where a node's source text ends by descending to its rightmost child (Go's syntax.EndPos).

import type {Pos} from '../base/pos';
import {NodeKind, type AnyNode} from './nodes';

function after(pos: Pos, length: number): Pos {
  return {base: pos.base, line: pos.line, col: pos.col + length};
}

function later(a: Pos, b: Pos): Pos {
  return a.line > b.line || (a.line === b.line && a.col >= b.col) ? a : b;
}

/**
 * The position immediately after `node`: with `node.pos` it forms the
 * half-open source range `[pos, endPos)`, in the same 1-based, UTF-16 units
 * as every `Pos`.
 *
 * Nodes store only their start, so the end is derived by descending to the
 * rightmost child. Descent stops at a leaf (start plus lexeme length) or at
 * one of the two positions the parser stores for a closing token no child
 * owns: `CallExpr.rparen`, and `Block.dedent`, which makes a block cover the
 * blank lines after its last statement. A `File` ends at its `eof`.
 *
 * Like Go's `syntax.EndPos` the result is approximate where a node closes
 * with a token that is not stored: `(x)`, `[a, b]`, `x[1]`, `array<float>`
 * and `float[]` end where their last child ends, and a declaration block
 * (`struct`, `enum`, `interface`, `switch`) ends where its last member ends.
 * The function is total: `BadExpr` and `BadStmt` end at their own `pos`, as
 * does a `Name` the parser synthesized with an empty spelling.
 *
 * @example
 * ```ts
 * const {file} = parseText('plot(\n  close)\n');
 * const call = (file.stmtList[0] as ExprStmt).x;
 * endPos(call); // 2:9, just after the ')'
 * ```
 */
export function endPos(node: AnyNode): Pos {
  switch (node.kind) {
    case NodeKind.File:
      return node.eof;
    case NodeKind.Block: {
      // A block closed by end of input on its last statement's own line has
      // its Dedent at column 1 of that line, before the statement ends.
      const tail = node.stmtList.at(-1);
      return tail === undefined
        ? node.dedent
        : later(node.dedent, endPos(tail));
    }
    case NodeKind.CallExpr:
      return after(node.rparen, 1);

    case NodeKind.Name:
    case NodeKind.BasicLit:
      return after(node.pos, node.value.length);
    case NodeKind.ThisExpr:
      return after(node.pos, 'this'.length);
    case NodeKind.BreakStmt:
      return after(node.pos, 'break'.length);
    case NodeKind.ContinueStmt:
      return after(node.pos, 'continue'.length);
    case NodeKind.BadStmt:
    case NodeKind.BadExpr:
      return node.pos;

    case NodeKind.ExprStmt:
    case NodeKind.UnaryExpr:
    case NodeKind.ParenExpr:
      return endPos(node.x);
    case NodeKind.DeclStmt:
      return endPos(node.init);
    case NodeKind.AssignStmt:
    case NodeKind.EmitStmt:
    case NodeKind.Arg:
      return endPos(node.value);
    case NodeKind.ReturnStmt:
      return node.value === null
        ? after(node.pos, 'return'.length)
        : endPos(node.value);
    case NodeKind.FuncDecl:
    case NodeKind.MethodDecl:
    case NodeKind.SwitchArm:
    case NodeKind.ForExpr:
    case NodeKind.ForInExpr:
    case NodeKind.WhileExpr:
      return endPos(node.body);
    case NodeKind.IfExpr:
      return endPos(node.else ?? node.then);
    case NodeKind.SwitchExpr: {
      const tail = node.arms.at(-1) ?? node.subject;
      return tail === null ? after(node.pos, 'switch'.length) : endPos(tail);
    }
    case NodeKind.BinaryExpr:
      return endPos(node.y);
    case NodeKind.CondExpr:
      return endPos(node.else);
    case NodeKind.SelectorExpr:
      return endPos(node.sel);
    case NodeKind.HistoryExpr:
      return endPos(node.offset);
    case NodeKind.TupleExpr:
    case NodeKind.TuplePattern: {
      const tail = node.elems.at(-1);
      return tail === undefined ? node.pos : endPos(tail);
    }

    case NodeKind.Param:
    case NodeKind.FieldDecl:
      return endPos(node.defaultValue ?? node.name);
    case NodeKind.TypeParam:
      return endPos(node.constraint);
    case NodeKind.InterfaceDecl:
      return endPos(node.methods.at(-1) ?? node.name);
    case NodeKind.InterfaceMethodDecl:
      return endPos(node.params.at(-1) ?? node.name);
    case NodeKind.StructDecl:
      return endPos(node.members.at(-1) ?? node.typeParams.at(-1) ?? node.name);
    case NodeKind.EnumDecl:
      return endPos(node.members.at(-1) ?? node.name);
    case NodeKind.EnumMember:
      return endPos(node.title ?? node.name);
    case NodeKind.TypeAliasDecl:
      return endPos(node.aliasedType);
    case NodeKind.ImportStmt:
      return endPos(node.alias ?? node.path);
    case NodeKind.TypeAnnotation:
      return endPos(node.name);
    case NodeKind.GenericType:
      return endPos(node.args.at(-1) ?? node.name);
    case NodeKind.ArrayType:
      return endPos(node.elem);
  }
}
