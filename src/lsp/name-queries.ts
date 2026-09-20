// Purpose: The position queries answered from the Name index — hover, definition and references — as pure functions over an Analysis and an LSP Position.

import {MarkupKind} from 'vscode-languageserver';
import type {Hover, Position, Range} from 'vscode-languageserver';
import {formatNativeSignature} from '../checker/catalog';
import {CallKind, type FunctionInstance} from '../checker/info';
import {ObjectKind, type FunctionObject} from '../checker/object';
import {formatType, TypeKind, type Qualifier, type Type} from '../ir/type';
import {NodeKind, type CallExpr, type Name} from '../syntax/nodes';
import {
  semanticContexts,
  type Analysis,
  type IndexedName,
  type NameFact,
} from './analysis';

/**
 * A range in a named source file: an LSP `Location` whose file is still the
 * compiler's filename. The server owns turning a filename into a URI: the
 * open document's own, a `file://` URI for an imported workspace file, or
 * `tea-lib:/ta.tea` for the compiler-shipped `tea-lib/ta.tea`.
 */
export interface SourceLocation {
  readonly filename: string;
  readonly range: Range;
}

/**
 * What the checker knows about the name at `position`, as one fenced `tea`
 * block with a line per distinct fact:
 *
 * - a variable, parameter or context builtin: qualifier, type and name. A
 *   field has no qualifier of its own, so it shows one only where it is
 *   selected;
 * - a user or library function or method: at a call, the signature that call
 *   stenciled; at the declaration, every stenciled signature, or the written
 *   parameters when nothing calls it;
 * - a native: the catalog signature of the overload the call resolved to.
 *
 * A function body is checked once per called signature, so a parameter of a
 * function called two ways has two lines. The result is null where there is
 * no name (whitespace, keywords, literals), for kinds with nothing to show
 * yet (types, enums, packages), and inside a free function nothing calls,
 * where the checker recorded no fact.
 *
 * A position just past a name's last character still finds the name.
 *
 * @example
 * ```ts
 * const analysis = analyze({
 *   filename: 'g.tea',
 *   source: 'g(x) => x + 1\na = g(close)\nb = g(1)\n',
 * });
 * hover(analysis, {line: 0, character: 2})?.contents;
 * // {kind: 'markdown', value: '```tea\nseries float x\nconst int x\n```'}
 * hover(analysis, {line: 1, character: 4})?.contents;
 * // {kind: 'markdown', value: '```tea\nseries float g(series float x)\n```'}
 * ```
 */
export function hover(analysis: Analysis, position: Position): Hover | null {
  const indexed = nameAt(analysis.names, position);
  if (indexed === null) {
    return null;
  }
  const {name, facts} = indexed;
  // A Set keeps each distinct line once, in instance order.
  const lines = new Set(
    facts.flatMap(fact => hoverLines(analysis, name, fact)),
  );
  // A native callee has no Object: what is known about it is the overload
  // each call resolved to.
  for (const info of semanticContexts(analysis.checked)) {
    for (const [call, resolution] of info.calls) {
      if (
        calleeName(call) === name &&
        (resolution.kind === CallKind.Native ||
          resolution.kind === CallKind.Request)
      ) {
        lines.add(formatNativeSignature(resolution.native));
      }
    }
  }
  if (lines.size === 0) {
    return null;
  }
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: `\`\`\`tea\n${[...lines].join('\n')}\n\`\`\``,
    },
    range: nameRange(name),
  };
}

/**
 * Where the object named at `position` is defined: the defining `Name` of
 * every object the name's facts refer to, found in `Info.defs` of whichever
 * context owns it and deduplicated by syntax node. A definition in an
 * imported library carries that library's filename, such as
 * `tea-lib/ta.tea`. Natives and context builtins have no source definition,
 * so they return nothing, as does a name without facts.
 *
 * @example
 * ```ts
 * const analysis = analyze({
 *   filename: 'fast.tea',
 *   source: 'fast = ta.ema(close, 14)\nplot("fast", fast)\n',
 * });
 * definition(analysis, {line: 1, character: 13});
 * // [{filename: 'fast.tea', range: {start: {line: 0, character: 0}, ...}}]
 * definition(analysis, {line: 0, character: 10})[0].filename;
 * // 'tea-lib/ta.tea'
 * ```
 */
export function definition(
  analysis: Analysis,
  position: Position,
): SourceLocation[] {
  const targets = new Set(
    nameAt(analysis.names, position)?.facts.map(fact => fact.object),
  );
  const defining = new Set<Name>();
  // ponytail: scans every def of the compilation per request; index Object
  // to Name inside analyze() if this ever shows up in a profile.
  for (const info of semanticContexts(analysis.checked)) {
    for (const [name, object] of info.defs) {
      if (targets.has(object)) {
        defining.add(name);
      }
    }
  }
  return [...defining].map(name => ({
    filename: name.pos.base.filename,
    range: nameRange(name),
  }));
}

/**
 * Every name in this document that refers to the same object as the name at
 * `position`, in position order. The union covers every function instance:
 * a parameter is one object per called signature, and all of them count.
 * `includeDeclaration` keeps or drops the defining name, as LSP's
 * `ReferenceContext` asks. The ranges are all in the analyzed document; the
 * server pairs them with its URI.
 *
 * A native has no object, so it has no references yet.
 *
 * @example
 * ```ts
 * const analysis = analyze({
 *   filename: 'g.tea',
 *   source: 'g(x) => x + 1\na = g(close)\nb = g(1)\n',
 * });
 * references(analysis, {line: 0, character: 0}, false).map(r => r.start.line);
 * // [1, 2]
 * ```
 */
export function references(
  analysis: Analysis,
  position: Position,
  includeDeclaration: boolean,
): Range[] {
  const targets = new Set(
    nameAt(analysis.names, position)?.facts.map(fact => fact.object),
  );
  return analysis.names
    .filter(({name, facts}) =>
      facts.some(
        ({info, object}) =>
          targets.has(object) && (includeDeclaration || !info.defs.has(name)),
      ),
    )
    .map(({name}) => nameRange(name));
}

// ---- the name at a position ---------------------------------------------------

// An LSP position is a gap between characters, so the gap after a name's last
// character touches the name as much as the gap before its first: that is
// where the caret sits after a word is typed or double-clicked. At least one
// character separates two names, so neither end is ambiguous.
function nameAt(
  names: readonly IndexedName[],
  position: Position,
): IndexedName | null {
  const line = position.line + 1;
  const col = position.character + 1;
  return (
    names.find(
      ({name: {pos, value}}) =>
        pos.line === line && pos.col <= col && col <= pos.col + value.length,
    ) ?? null
  );
}

function nameRange({pos, value}: Name): Range {
  const line = pos.line - 1;
  const character = pos.col - 1;
  return {
    start: {line, character},
    end: {line, character: character + value.length},
  };
}

// ---- hover text -----------------------------------------------------------------

function hoverLines(
  analysis: Analysis,
  name: Name,
  {info, object}: NameFact,
): string[] {
  switch (object.kind) {
    case ObjectKind.Variable:
    case ObjectKind.Builtin:
      // The diagnostic already covers a name whose check failed.
      return object.type.kind === TypeKind.Invalid
        ? []
        : [typedName(object.qualifier, object.type, object.name)];
    case ObjectKind.Field: {
      const selector = [...info.selections.keys()].find(s => s.sel === name);
      const selected = selector && info.types.get(selector);
      return [typedName(selected?.qualifier ?? null, object.type, object.name)];
    }
    case ObjectKind.Function: {
      const called = [...info.calls].flatMap(([call, resolution]) =>
        calleeName(call) === name && resolution.kind === CallKind.Function
          ? [resolution.instance]
          : [],
      );
      const instances =
        called.length > 0
          ? called
          : (analysis.checked.instances.get(object) ?? []);
      return instances.length > 0
        ? instances.map(instanceSignature)
        : [declaredSignature(object)];
    }
    default:
      return [];
  }
}

// The name that spells a call's callee: `nz` in `nz(x)`, `ema` in
// `ta.ema(x, 9)`.
function calleeName({fun}: CallExpr): Name | null {
  if (fun.kind === NodeKind.Name) {
    return fun;
  }
  return fun.kind === NodeKind.SelectorExpr ? fun.sel : null;
}

// `series float x`, in the order a Tea declaration is written; `float x`
// where there is no qualifier to show.
export function typedName(
  qualifier: Qualifier | null,
  type: Type,
  name: string,
): string {
  return `${qualifier === null ? '' : `${qualifier} `}${formatType(type)} ${name}`;
}

// `series float ta.ema(series float source, const int length)`
function instanceSignature(instance: FunctionInstance): string {
  const params = instance.params.map(param =>
    typedName(param.qualifier, param.type, param.name),
  );
  return typedName(
    instance.resultQualifier,
    instance.resultType,
    `${instance.name}(${params.join(', ')})`,
  );
}

// A free function nothing calls has no instance, so all that is known is
// what is written: `ma(source, simple int length)`.
export function declaredSignature(template: FunctionObject): string {
  return `${template.displayName}(${declaredParams(template).join(', ')})`;
}

// Each parameter as written, in order: `source`, `simple int length`.
export function declaredParams(template: FunctionObject): string[] {
  return template.decl.params.map((param, index) => {
    const declared = template.declaredParams[index];
    return declared === null
      ? param.name.value
      : typedName(declared.qualifier, declared.type, param.name.value);
  });
}
