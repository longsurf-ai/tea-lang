// Purpose: The queries answered from the text before the cursor — completion and signature help. The expression being typed is usually broken, so they read tokens and scopes, never a syntax node at the cursor.

import {CompletionItemKind} from 'vscode-languageserver';
import type {
  CompletionItem,
  Position,
  SignatureHelp,
  SignatureInformation,
} from 'vscode-languageserver';
import {newFileBase, type Pos} from '../base/pos';
import {
  CATALOG,
  formatNativeSignature,
  formatNativeTypeRef,
  nativeFuncs,
  type NativeFunc,
} from '../checker/catalog';
// `Object` is the checker's semantic object. A type-only import leaves the
// global `Object` value in place.
import {
  ObjectKind,
  type FunctionObject,
  type Object,
  type StructObject,
} from '../checker/object';
import type {Scope} from '../checker/scope';
import {TypeKind, type Type} from '../ir/type';
import {
  NodeKind,
  type Block,
  type File,
  type ForExpr,
  type ForInExpr,
  type FuncDecl,
  type MethodDecl,
  type Node,
} from '../syntax/nodes';
import {endPos, tokenize} from '../syntax/syntax';
import {
  CONTEXTUAL_KEYWORDS,
  KEYWORDS,
  LitKind,
  Op,
  Tok,
  type Token,
} from '../syntax/tokens';
import {
  childNodes,
  semanticContexts,
  tokenWidth,
  type Analysis,
} from './analysis';
import {declaredParams, declaredSignature, typedName} from './name-queries';

/**
 * What can be typed at `position`, nearest scope first. `text` is the
 * document `analysis` was made from; it is read because the expression at the
 * cursor is usually broken (`x = ta.`), so no syntax node there is trusted.
 *
 * - After `name.` or `this.`: the exports of a package alias (`ta.`), the
 *   catalog entries of a native namespace (`math.`), the fields and methods
 *   of a struct value, or the members of an enum. Any other receiver
 *   (`a.b.`, `f().`, an unknown name) gets the list below instead.
 * - Otherwise: the names of the innermost scope at the cursor, then of each
 *   parent up to the package and the implicit libraries, then the catalog
 *   roots (`close`, `nz`, the namespace `math`) and the keywords. A name
 *   offered by a nearer scope hides a farther one, as in the language.
 *
 * The innermost scope belongs to the innermost block, loop or function that
 * contains the cursor. On a blank line the cursor's column decides: a block
 * indented deeper than the cursor does not contain it. A function body has
 * one scope per called signature, and all of them contribute. Inside a free
 * function nothing calls there are no scopes, so the function's written
 * parameters stand in for them.
 *
 * Inside a string or a line comment there is nothing to complete. `sortText`
 * carries the scope distance for clients that sort. There is no resolve
 * step: `detail` already holds the type or signature.
 *
 * @example
 * ```ts
 * const text = 'fast = ta.ema(close, 9)\nslow = ta.';
 * completion(analyze({filename: 'x.tea', source: text}), text, {
 *   line: 1,
 *   character: 10,
 * }).find(item => item.label === 'sma');
 * // {label: 'sma', kind: CompletionItemKind.Function,
 * //  detail: 'sma(source, length)', sortText: '00'}
 * ```
 */
export function completion(
  analysis: Analysis,
  text: string,
  position: Position,
): CompletionItem[] {
  const cursor = readCursor(text, position);
  if (cursor.inText) {
    return [];
  }
  // The word being typed filters the list in the client; it is not context.
  const tokens = cursor.typingWord ? cursor.tokens.slice(0, -1) : cursor.tokens;
  const visible = visibleAt(analysis, cursor);

  const receiver = simpleReceiver(tokens, tokens.length - 1);
  if (receiver !== null) {
    const selectable = receiverMembers(analysis, visible, receiver).map(
      objectItem,
    );
    const items =
      selectable.length > 0 ? selectable : catalogItems(`${receiver}.`);
    if (items.length > 0) {
      return ranked([items]);
    }
  }

  const groups: CompletionItem[][] = [
    visible.unchecked.flatMap(node => {
      if (
        node.kind !== NodeKind.FuncDecl &&
        node.kind !== NodeKind.MethodDecl
      ) {
        return [];
      }
      const written = lookup(visible.scopes, node.name.value).flatMap(object =>
        object.kind === ObjectKind.Function && object.decl === node
          ? declaredParams(object)
          : [],
      );
      return node.params.map((param, index) => ({
        label: param.name.value,
        kind: CompletionItemKind.Variable,
        detail: written[index],
      }));
    }),
  ];
  for (
    let level = visible.scopes;
    level.length > 0;
    level = [...new Set(level.flatMap(scope => scope.parent ?? []))]
  ) {
    groups.push(level.flatMap(scope => [...scope.declared()].map(objectItem)));
  }
  groups.push(
    catalogItems(''),
    KEYWORDS.map(label => ({label, kind: CompletionItemKind.Keyword})),
  );
  return ranked(groups);
}

/**
 * The signatures of the call the cursor is inside, or null when it is inside
 * none. The call is found in the tokens before the cursor: back to the
 * nearest unclosed `(`, skipping balanced brackets and string literals, so
 * `f(g(a, ` answers for `g`, and a cursor inside `"a, (b"` does not count
 * that text. Type arguments are skipped: `array.new<float>(` is `array.new`.
 *
 * The callee resolves like a name at the cursor: a user or library function
 * or a struct method gives the one signature that is written, a native
 * gives every overload. The active parameter is the number of top-level
 * commas before the cursor, the last parameter once a variadic one is
 * reached, or the parameter a named argument (`title = `) spells. The active
 * signature is the first one that has that parameter.
 *
 * @example
 * ```ts
 * const text = 'x = math.max(1, ';
 * signatureHelp(analyze({filename: 'x.tea', source: text}), text, {
 *   line: 0,
 *   character: 16,
 * });
 * // {activeSignature: 0, activeParameter: 1, signatures: [
 * //   {label: 'math.max(number: int, ...number1: int) → int', ...},
 * //   {label: 'math.max(number: int | float, ...) → float', ...}]}
 * ```
 */
export function signatureHelp(
  analysis: Analysis,
  text: string,
  position: Position,
): SignatureHelp | null {
  const cursor = readCursor(text, position);
  const {tokens} = cursor;
  let open = tokens.length;
  let depth = 0;
  let commas = 0;
  let argumentStart = -1;
  for (;;) {
    open -= 1;
    if (open < 0) {
      return null;
    }
    const {tok} = tokens[open];
    if (tok === Tok.Rparen || tok === Tok.Rbrack || tok === Tok.Rbrace) {
      depth += 1;
    } else if (tok === Tok.Lparen || tok === Tok.Lbrack || tok === Tok.Lbrace) {
      if (depth > 0) {
        depth -= 1;
      } else if (tok === Tok.Lparen) {
        break;
      } else {
        // Inside `[a, b` within some argument: those commas were its own.
        commas = 0;
        argumentStart = -1;
      }
    } else if (tok === Tok.Comma && depth === 0) {
      commas += 1;
      if (argumentStart < 0) {
        argumentStart = open + 1;
      }
    }
  }
  const start = argumentStart < 0 ? open + 1 : argumentStart;
  const argument = {
    index: commas,
    name: tokens[start + 1]?.tok === Tok.Assign ? nameOf(tokens[start]) : null,
  };

  let callee = open - 1;
  if (tokens[callee]?.op === Op.Gt) {
    while (callee >= 0 && tokens[callee].op !== Op.Lt) {
      callee -= 1;
    }
    callee -= 1;
  }
  const name = nameOf(tokens[callee]);
  const receiver = simpleReceiver(tokens, callee - 1);
  if (
    name === null ||
    (tokens[callee - 1]?.tok === Tok.Dot && receiver === null)
  ) {
    return null;
  }
  const visible = visibleAt(analysis, cursor);
  const candidates =
    receiver === null
      ? lookup(visible.scopes, name)
      : receiverMembers(analysis, visible, receiver);
  const functions = [...new Set(candidates)].filter(
    (object): object is FunctionObject =>
      object.kind === ObjectKind.Function && object.name === name,
  );
  const signatures =
    functions.length > 0
      ? functions.map(template =>
          signatureOf(
            declaredSignature(template),
            declaredParams(template).map((label, index) => ({
              name: template.decl.params[index].name.value,
              label,
              variadic: false,
            })),
            argument,
          ),
        )
      : (
          nativeFuncs(receiver === null ? name : `${receiver}.${name}`) ?? []
        ).map(native => nativeSignature(native, argument));
  if (signatures.length === 0) {
    return null;
  }
  const activeSignature = Math.max(
    0,
    signatures.findIndex(signature => signature.activeParameter !== undefined),
  );
  return {
    signatures,
    activeSignature,
    activeParameter:
      signatures[activeSignature].activeParameter ?? argument.index,
  };
}

// ---- the text before the cursor -------------------------------------------------

// What the text says about the cursor, in Tea's 1-based line and column.
// `tokens` are the tokens that start before it, from Tea's own scanner, so
// strings, comments and line joining inside brackets read as the compiler
// reads them.
function readCursor(text: string, position: Position) {
  const lines = text.split('\n');
  const line = lines[position.line] ?? '';
  const before = line.slice(0, position.character);
  const failures: Pos[] = [];
  const tokens = tokenize(
    newFileBase(''),
    [...lines.slice(0, position.line), before].join('\n'),
    pos => failures.push(pos),
  ).filter(token => tokenWidth(token) > 0);

  const last = tokens.at(-1);
  // The text is cut at the cursor, so a string the cursor is inside is one
  // the scanner found unterminated.
  const inString =
    last?.kind === LitKind.String &&
    failures.some(
      pos => pos.line === last.pos.line && pos.col === last.pos.col,
    );
  // A comment is no token: it hides between the last token and the cursor.
  // ponytail: line comments only; inside a block comment completion still
  // answers. Track the scanner's comment state if that ever matters.
  const gap =
    last?.pos.line === position.line + 1
      ? last.pos.col - 1 + tokenWidth(last)
      : 0;
  return {
    line: position.line + 1,
    col: position.character + 1,
    blank: line.trim() === '',
    tokens,
    typingWord: /\w$/.test(before),
    inText: inString || before.slice(gap).includes('//'),
  };
}

type Cursor = ReturnType<typeof readCursor>;

// The spelling of a name. A contextual keyword is a name outside its own
// production: `input.enum`, `export = 1`.
function nameOf(token: Token | undefined): string | null {
  if (token === undefined || token.tok === Tok.Name) {
    return token?.lit ?? null;
  }
  return (CONTEXTUAL_KEYWORDS as readonly string[]).includes(token.tok)
    ? token.tok
    : null;
}

// The name or `this` before the dot at `tokens[dot]`, when that is the whole
// receiver: `a.b.` and `f().` have none.
function simpleReceiver(tokens: readonly Token[], dot: number): string | null {
  if (tokens[dot]?.tok !== Tok.Dot || tokens[dot - 2]?.tok === Tok.Dot) {
    return null;
  }
  const receiver = tokens[dot - 1];
  return receiver?.tok === Tok.This ? Tok.This : nameOf(receiver);
}

// ---- scopes at the cursor -------------------------------------------------------

// The nodes whose `Info.scopes` entry holds names: a block's locals, a loop's
// index, a function's parameters. The file is the outermost one.
type ScopeOwner = Block | ForExpr | ForInExpr | FuncDecl | MethodDecl;

const SCOPE_OWNERS: ReadonlySet<string> = new Set([
  NodeKind.Block,
  NodeKind.ForExpr,
  NodeKind.ForInExpr,
  NodeKind.FuncDecl,
  NodeKind.MethodDecl,
]);

function isBefore(
  a: {readonly line: number; readonly col: number},
  b: {readonly line: number; readonly col: number},
): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

// A block is whole lines. Its Dedent sits at column 1 of the first line after
// it, or, when the input ends inside the block, on the block's own last
// line. A blank line holds no token to place it, so there the cursor's
// column decides, as indentation would for the statement about to be typed.
function blockContains(block: Block, cursor: Cursor): boolean {
  if (cursor.blank) {
    return (
      block.pos.line < cursor.line &&
      cursor.line <= block.dedent.line &&
      cursor.col >= block.pos.col
    );
  }
  // The Dedent's own line belongs to the block only when the input ended
  // inside it, which shows as a Dedent placed before the last statement's end.
  const tail = block.stmtList.at(-1);
  const endedInside =
    tail !== undefined && isBefore(block.dedent, endPos(tail));
  const lastLine = endedInside ? block.dedent.line : block.dedent.line - 1;
  return !isBefore(cursor, block.pos) && cursor.line <= lastLine;
}

function contains(node: ScopeOwner, cursor: Cursor): boolean {
  if (node.kind === NodeKind.Block) {
    return blockContains(node, cursor);
  }
  if (node.body.kind === NodeKind.Block && blockContains(node.body, cursor)) {
    return true;
  }
  // The header, and an expression body: `f(x) => x + 1`. The end is
  // inclusive because the caret sits just past what was typed.
  const end =
    node.body.kind === NodeKind.Block ? node.body.pos : endPos(node.body);
  return !cursor.blank && !isBefore(cursor, node.pos) && !isBefore(end, cursor);
}

// Owners nest, so one that does not contain the cursor hides none that does.
function collectEnclosing(
  node: Node,
  cursor: Cursor,
  out: (File | ScopeOwner)[],
): void {
  if ('kind' in node && SCOPE_OWNERS.has(node.kind as string)) {
    if (!contains(node as ScopeOwner, cursor)) {
      return;
    }
    out.push(node as ScopeOwner);
  }
  childNodes(node).forEach(child => collectEnclosing(child, cursor, out));
}

// `path` is the file and then every scope owner containing the cursor,
// outermost first. `scopes` belong to the innermost of them the checker
// entered: one scope per semantic context, so a function body called with
// two signatures has two. `unchecked` are the owners inside that one, which
// the checker never entered: the body of a free function nothing calls.
function visibleAt(analysis: Analysis, cursor: Cursor) {
  const path: (File | ScopeOwner)[] = [analysis.file];
  childNodes(analysis.file).forEach(stmt =>
    collectEnclosing(stmt, cursor, path),
  );
  const contexts = [...semanticContexts(analysis.checked)];
  let depth = path.length;
  let scopes: Scope[] = [];
  while (scopes.length === 0 && depth > 0) {
    depth -= 1;
    const node = path[depth];
    scopes = contexts.flatMap(info => info.scopes.get(node) ?? []);
  }
  return {path, scopes, unchecked: path.slice(depth + 1)};
}

type Visible = ReturnType<typeof visibleAt>;

function lookup(scopes: readonly Scope[], name: string): Object[] {
  return [...new Set(scopes.flatMap(scope => scope.lookup(name) ?? []))];
}

// What can be selected after a dot on a simple receiver. `this` is no scope
// entry: the enclosing method's declaration names its owner struct directly,
// which also covers a generic struct nobody has specialized yet.
function receiverMembers(
  analysis: Analysis,
  visible: Visible,
  receiver: string,
): Object[] {
  if (receiver !== Tok.This) {
    return lookup(visible.scopes, receiver).flatMap(object =>
      members(analysis, object),
    );
  }
  const method = visible.path.findLast(
    node => node.kind === NodeKind.MethodDecl,
  );
  const owners = [...analysis.checked.instances.keys()].flatMap(template =>
    template.decl === method && template.receiver !== null
      ? [template.receiver.owner]
      : [],
  );
  // Every specialization shares the declaration; one owner names the members.
  return owners
    .slice(0, 1)
    .flatMap(owner => [...owner.fields, ...owner.methods]);
}

// What can be selected after a dot on `receiver`.
function members(analysis: Analysis, receiver: Object): readonly Object[] {
  switch (receiver.kind) {
    case ObjectKind.PackageName:
      return [...receiver.pkg.exports.values()];
    case ObjectKind.Enum:
      return receiver.members;
    case ObjectKind.Variable:
    case ObjectKind.Builtin: {
      const struct = structOf(analysis, receiver.type);
      return struct === undefined ? [] : [...struct.fields, ...struct.methods];
    }
    default:
      return [];
  }
}

// The declaration behind a struct type. Every struct is declared in a
// package scope, a generic one through its specializations.
function structOf(analysis: Analysis, type: Type): StructObject | undefined {
  if (type.kind !== TypeKind.Struct) {
    return undefined;
  }
  for (const pkg of analysis.checked.packageContexts.keys()) {
    for (const object of pkg.scope.declared()) {
      if (object.kind === ObjectKind.Struct && object.type === type) {
        return object;
      }
      if (object.kind === ObjectKind.GenericStruct) {
        const specialized = object.instances.find(
          instance => instance.object.type === type,
        );
        if (specialized !== undefined) {
          return specialized.object;
        }
      }
    }
  }
  return undefined;
}

// ---- completion items -----------------------------------------------------------

const ITEM_KIND: Record<Object['kind'], CompletionItemKind> = {
  [ObjectKind.Variable]: CompletionItemKind.Variable,
  [ObjectKind.Builtin]: CompletionItemKind.Variable,
  [ObjectKind.Function]: CompletionItemKind.Function,
  [ObjectKind.Field]: CompletionItemKind.Field,
  [ObjectKind.Struct]: CompletionItemKind.Struct,
  [ObjectKind.GenericStruct]: CompletionItemKind.Struct,
  [ObjectKind.Enum]: CompletionItemKind.Enum,
  [ObjectKind.EnumMember]: CompletionItemKind.EnumMember,
  [ObjectKind.Interface]: CompletionItemKind.Interface,
  [ObjectKind.InterfaceMethod]: CompletionItemKind.Method,
  [ObjectKind.TypeParameter]: CompletionItemKind.TypeParameter,
  [ObjectKind.PackageName]: CompletionItemKind.Module,
};

function objectItem(object: Object): CompletionItem {
  return {
    label: object.name,
    kind:
      object.kind === ObjectKind.Function && object.receiver !== null
        ? CompletionItemKind.Method
        : ITEM_KIND[object.kind],
    detail: objectDetail(object),
  };
}

function objectDetail(object: Object): string | undefined {
  switch (object.kind) {
    case ObjectKind.Variable:
    case ObjectKind.Builtin:
      // The diagnostic already covers a name whose check failed.
      return object.type.kind === TypeKind.Invalid
        ? undefined
        : typedName(object.qualifier, object.type, object.name);
    case ObjectKind.Field:
      return typedName(null, object.type, object.name);
    case ObjectKind.Function:
      return declaredSignature(object);
    case ObjectKind.EnumMember:
      return `${object.owner.name}.${object.name}`;
    case ObjectKind.PackageName:
      return `library ${object.pkg.name}`;
    case ObjectKind.GenericStruct:
      return `struct ${object.name}`;
    default:
      return `${object.kind} ${object.name}`;
  }
}

// Catalog names are `close`, `nz` or `math.max`. Under '' these are the
// roots, a namespace offered once for all its entries; under 'math.' they
// are the entries of `math`.
function catalogItems(prefix: string): CompletionItem[] {
  const entries: CompletionItem[] = [
    ...[...CATALOG.funcs].map(([label, overloads]) => ({
      label,
      kind: CompletionItemKind.Function,
      detail: formatNativeSignature(overloads[0]),
    })),
    ...[...CATALOG.vars.values()].map(native => ({
      label: native.name,
      kind:
        native.binding === null
          ? CompletionItemKind.Constant
          : CompletionItemKind.Variable,
      detail: typedName(native.qualifier, native.type, native.name),
    })),
  ];
  return entries
    .filter(entry => entry.label.startsWith(prefix))
    .map(entry => {
      const [label, ...deeper] = entry.label.slice(prefix.length).split('.');
      return deeper.length === 0
        ? {...entry, label}
        : {
            label,
            kind: CompletionItemKind.Module,
            detail: `namespace ${label}`,
          };
    });
}

// The first offer of a label wins, which is the language's shadowing rule.
// The group's index becomes `sortText`, so a client that sorts keeps nearer
// scopes first. A name the parser synthesized during recovery has an empty
// spelling and is left out.
function ranked(
  groups: readonly (readonly CompletionItem[])[],
): CompletionItem[] {
  const items = new Map<string, CompletionItem>();
  groups.forEach((group, rank) => {
    for (const item of group) {
      if (item.label !== '' && !items.has(item.label)) {
        items.set(item.label, {
          ...item,
          sortText: String(rank).padStart(2, '0'),
        });
      }
    }
  });
  return [...items.values()];
}

// ---- signatures -----------------------------------------------------------------

// A parameter's label is its text inside the signature's label, which is how
// a client finds what to highlight. A signature that lacks the parameter the
// cursor is on has no active parameter.
function signatureOf(
  label: string,
  params: readonly {
    readonly name: string;
    readonly label: string;
    readonly variadic: boolean;
  }[],
  argument: {readonly index: number; readonly name: string | null},
): SignatureInformation {
  const last = params.length - 1;
  const active =
    argument.name !== null
      ? params.findIndex(param => param.name === argument.name)
      : argument.index > last && params.at(-1)?.variadic === true
        ? last
        : argument.index;
  return {
    label,
    parameters: params.map(param => ({label: param.label})),
    activeParameter: active >= 0 && active <= last ? active : undefined,
  };
}

// The parameter texts repeat the spelling of `formatNativeSignature`, whose
// line they must be found in.
// ponytail: a staged parameter is not shown, so positional arguments after
// one are off by one (`request.security` past `currency`). Count over
// `native.params` if more natives stage a parameter mid-list.
function nativeSignature(
  native: NativeFunc,
  argument: {readonly index: number; readonly name: string | null},
): SignatureInformation {
  return signatureOf(
    formatNativeSignature(native),
    native.params
      .filter(param => param.availability === 'supported')
      .map(param => ({
        name: param.name,
        label: `${param.name}${param.required ? '' : '?'}: ${formatNativeTypeRef(param.type)}`,
        variadic: param.variadic,
      })),
    argument,
  );
}
