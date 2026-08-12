// Purpose: Generate the Tea TextMate grammar from compiler-owned syntax and semantic vocabulary.

import {fatal} from '../../../src/base/print';
import {CATALOG, Effect} from '../../../src/checker/catalog';
import {
  BUILTIN_ANNOTATION_TYPES,
  COLLECTION_TYPE_CATALOG,
} from '../../../src/checker/type-catalog';
import {Qualifier} from '../../../src/ir/type';
import {
  CONTEXTUAL_KEYWORDS,
  Op,
  RESERVED_KEYWORDS,
  Tok,
} from '../../../src/syntax/tokens';

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const IMPORT_PATH = IDENTIFIER + '(?:/[A-Za-z0-9_]+)*';
const TYPE_SYNTAX =
  IDENTIFIER +
  '(?:\\.' +
  IDENTIFIER +
  ')?(?:\\s*<[^>\\r\\n]+>)?(?:\\s*\\[\\])*';

const MODES = [Tok.Var, Tok.Varip, Tok.Const] as const;
const LOOP_KEYWORDS = [Tok.In, Tok.To, Tok.By] as const;
const QUALIFIERS = [Qualifier.Simple, Qualifier.Series] as const;

// The grammar owns scopes, never colors. Keeping each syntactic role behind
// one canonical constant prevents equivalent declaration forms from drifting
// into theme-dependent aliases.
export const TEA_SCOPES = {
  exportModifier: 'storage.modifier.export.tea',
  declarationKeyword: 'storage.type.declaration.tea',
  interfaceKeyword: 'storage.type.interface.declaration.tea',
  enumKeyword: 'storage.type.enum.declaration.tea',
  aliasKeyword: 'storage.type.alias.declaration.tea',
  typeName: 'entity.name.type.tea',
  interfaceName: 'entity.name.type.interface.tea',
  enumName: 'entity.name.type.enum.tea',
  aliasName: 'entity.name.type.alias.tea',
  typeParameter: 'entity.name.type.parameter.tea',
  namespace: 'entity.name.namespace.tea',
  functionName: 'entity.name.function.tea',
  functionCall: 'entity.name.function.call.tea',
  parameter: 'variable.parameter.tea',
  builtinType: 'support.type.builtin.tea',
  receiverModifier: 'storage.modifier.receiver.tea',
} as const;

function words(values: readonly string[]): string {
  return '\\b(?:' + values.join('|') + ')\\b';
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function verifyContextualCoverage(): void {
  const handled: ReadonlySet<string> = new Set([
    Tok.Struct,
    Tok.Type,
    Tok.Interface,
    Tok.Enum,
    Tok.Import,
    Tok.Export,
    Tok.To,
    Tok.By,
    Tok.In,
    Tok.As,
  ]);
  const missing = CONTEXTUAL_KEYWORDS.filter(word => !handled.has(word));
  if (missing.length > 0) {
    fatal(
      'Tea TextMate grammar has no contextual rule for: ' + missing.join(', '),
    );
  }
}

export function generateGrammar() {
  verifyContextualCoverage();

  const controls = RESERVED_KEYWORDS.filter(
    word => !MODES.some(mode => mode === word) && word !== Tok.This,
  );
  const types = sorted([
    ...BUILTIN_ANNOTATION_TYPES.keys(),
    ...COLLECTION_TYPE_CATALOG.keys(),
  ]);
  const constants = sorted(
    [...CATALOG.vars.values()]
      .filter(
        variable =>
          variable.qualifier === Qualifier.Const &&
          !variable.name.includes('.'),
      )
      .map(variable => variable.name),
  );
  const declarations = sorted(
    [...CATALOG.funcs.values()]
      .flat()
      .filter(func => func.effect === Effect.Declaration)
      .map(func => func.name),
  );
  const typeWords = words(types);

  return {
    $schema:
      'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name: 'Tea',
    scopeName: 'source.tea',
    fileTypes: ['tea'],
    patterns: [
      {include: '#version-directive'},
      {include: '#comments'},
      {include: '#strings'},
      {include: '#imports'},
      {include: '#type-declarations'},
      {include: '#function-declarations'},
      {include: '#receiver-keyword'},
      {include: '#method-receiver-modifier'},
      {include: '#for-header'},
      {include: '#storage-modifiers'},
      {include: '#control-keywords'},
      {include: '#language-constants'},
      {include: '#script-declarations'},
      {include: '#function-calls'},
      {include: '#type-annotations'},
      {include: '#members'},
      {include: '#colors'},
      {include: '#numbers'},
      {include: '#operators'},
      {include: '#punctuation'},
    ],
    repository: {
      'version-directive': {
        patterns: [
          {
            name: 'comment.line.double-slash.tea',
            begin: '(//)(@version)(\\s*)(=)(\\s*)([^\\s]+)',
            beginCaptures: {
              '1': {name: 'punctuation.definition.comment.tea'},
              '2': {name: 'keyword.control.directive.tea'},
              '4': {name: 'keyword.operator.assignment.tea'},
              '6': {name: 'constant.numeric.version.tea'},
            },
            end: '(?=$)',
          },
        ],
      },
      comments: {
        patterns: [
          {
            name: 'comment.block.tea',
            begin: '/\\*',
            beginCaptures: {
              '0': {name: 'punctuation.definition.comment.begin.tea'},
            },
            end: '\\*/',
            endCaptures: {
              '0': {name: 'punctuation.definition.comment.end.tea'},
            },
          },
          {
            name: 'comment.line.double-slash.tea',
            begin: '//',
            beginCaptures: {
              '0': {name: 'punctuation.definition.comment.tea'},
            },
            end: '(?=$)',
          },
        ],
      },
      strings: {
        patterns: [
          {
            name: 'string.quoted.double.tea',
            begin: '"',
            beginCaptures: {
              '0': {name: 'punctuation.definition.string.begin.tea'},
            },
            end: '"|(?=$)',
            endCaptures: {
              '0': {name: 'punctuation.definition.string.end.tea'},
            },
            patterns: [{match: '\\\\.', name: 'constant.character.escape.tea'}],
          },
          {
            name: 'string.quoted.single.tea',
            begin: "'",
            beginCaptures: {
              '0': {name: 'punctuation.definition.string.begin.tea'},
            },
            end: "'|(?=$)",
            endCaptures: {
              '0': {name: 'punctuation.definition.string.end.tea'},
            },
            patterns: [{match: '\\\\.', name: 'constant.character.escape.tea'}],
          },
        ],
      },
      imports: {
        patterns: [
          {
            match:
              '^(\\s*)(' +
              Tok.Import +
              ')(\\s+)(' +
              IMPORT_PATH +
              ')(?:(\\s+)(' +
              Tok.As +
              ')(\\s+)(' +
              IDENTIFIER +
              '))?',
            captures: {
              '2': {name: 'keyword.control.import.tea'},
              '4': {name: 'string.unquoted.import-path.tea'},
              '6': {name: 'keyword.control.import.tea'},
              '8': {name: 'entity.name.namespace.tea'},
            },
          },
        ],
      },
      'type-declarations': {
        patterns: [
          {
            name: 'meta.declaration.interface.tea',
            begin:
              '^(\\s*)(?:(' +
              Tok.Export +
              ')(\\s+))?(' +
              Tok.Interface +
              ')(\\s+)(' +
              IDENTIFIER +
              ')\\b',
            beginCaptures: {
              '2': {name: TEA_SCOPES.exportModifier},
              '4': {name: TEA_SCOPES.interfaceKeyword},
              '6': {name: TEA_SCOPES.interfaceName},
            },
            end: '(?=$)',
            patterns: [{include: '#comments'}],
          },
          {
            name: 'meta.declaration.type.alias.tea',
            begin:
              '^(\\s*)(?:(' +
              Tok.Export +
              ')(\\s+))?(' +
              Tok.Type +
              ')(\\s+)(' +
              IDENTIFIER +
              ')\\b(?=\\s*=)',
            beginCaptures: {
              '2': {name: TEA_SCOPES.exportModifier},
              '4': {name: TEA_SCOPES.aliasKeyword},
              '6': {name: TEA_SCOPES.aliasName},
            },
            end: '(?=$)',
            patterns: [
              {include: '#comments'},
              {include: '#type-parameter-list'},
              {include: '#type-references'},
              {include: '#operators'},
              {include: '#punctuation'},
            ],
          },
          {
            name: 'meta.declaration.type.tea',
            begin:
              '^(\\s*)(?:(' +
              Tok.Export +
              ')(\\s+))?(' +
              '(?:' +
              Tok.Struct +
              '|' +
              Tok.Type +
              ')' +
              ')(\\s+)(' +
              IDENTIFIER +
              ')\\b',
            beginCaptures: {
              '2': {name: TEA_SCOPES.exportModifier},
              '4': {name: TEA_SCOPES.declarationKeyword},
              '6': {name: TEA_SCOPES.typeName},
            },
            end: '(?=$)',
            patterns: [
              {include: '#comments'},
              {include: '#type-parameter-list'},
            ],
          },
          {
            name: 'meta.declaration.enum.tea',
            begin:
              '^(\\s*)(?:(' +
              Tok.Export +
              ')(\\s+))?(' +
              Tok.Enum +
              ')(\\s+)(' +
              IDENTIFIER +
              ')\\b',
            beginCaptures: {
              '2': {name: TEA_SCOPES.exportModifier},
              '4': {name: TEA_SCOPES.enumKeyword},
              '6': {name: TEA_SCOPES.enumName},
            },
            end: '(?=$)',
            patterns: [{include: '#comments'}],
          },
        ],
      },
      'type-parameter-list': {
        name: 'meta.type.parameters.tea',
        begin: '<',
        beginCaptures: {
          '0': {name: 'punctuation.definition.typeparameters.begin.tea'},
        },
        // Angle-bracket type syntax cannot continue across a Tea newline, so
        // recover at EOL while the user is still typing an incomplete list.
        end: '>|(?=$)',
        endCaptures: {
          '0': {name: 'punctuation.definition.typeparameters.end.tea'},
        },
        patterns: [
          {
            match: '(?:(?<=<)|(?<=,))(\\s*)(' + IDENTIFIER + ')(?=\\s*:)',
            captures: {'2': {name: TEA_SCOPES.typeParameter}},
          },
          {match: ':', name: 'punctuation.separator.constraint.tea'},
          {include: '#type-parameter-list'},
          {include: '#type-references'},
          {include: '#punctuation'},
        ],
      },
      'type-references': {
        patterns: [
          {
            match: '\\b(' + IDENTIFIER + ')(\\.)(' + IDENTIFIER + ')\\b',
            captures: {
              '1': {name: TEA_SCOPES.namespace},
              '2': {name: 'punctuation.accessor.tea'},
              '3': {name: TEA_SCOPES.typeName},
            },
          },
          {match: typeWords, name: TEA_SCOPES.builtinType},
          {match: '\\b' + IDENTIFIER + '\\b', name: TEA_SCOPES.typeName},
        ],
      },
      'function-declarations': {
        patterns: [
          {
            name: 'meta.declaration.method.tea',
            begin:
              '^(\\s+)(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              TYPE_SYNTAX +
              ')(\\s+)(' +
              IDENTIFIER +
              ')(?=\\s*\\()',
            beginCaptures: {
              '2': {name: 'storage.modifier.qualifier.tea'},
              '4': {
                name: 'meta.type.return.tea',
                patterns: [
                  {include: '#type-parameter-list'},
                  {include: '#type-references'},
                  {include: '#punctuation'},
                ],
              },
              '6': {name: TEA_SCOPES.functionName},
            },
            end: '(=>)|(?=$)',
            endCaptures: {
              '1': {name: 'keyword.operator.function.tea'},
            },
            patterns: [
              {include: '#comments'},
              {include: '#strings'},
              {include: '#parameter-declarations'},
              {include: '#type-parameter-list'},
              {include: '#method-receiver-modifier'},
              {include: '#punctuation'},
            ],
          },
          {
            name: 'meta.declaration.function.exported.tea',
            begin:
              '^(\\s*)(' +
              Tok.Export +
              ')(\\s+)(' +
              IDENTIFIER +
              ')(?=\\s*\\()',
            beginCaptures: {
              '2': {name: TEA_SCOPES.exportModifier},
              '4': {name: TEA_SCOPES.functionName},
            },
            end: '(=>)|(?=$)',
            endCaptures: {
              '1': {name: 'keyword.operator.function.tea'},
            },
            patterns: [
              {include: '#comments'},
              {include: '#strings'},
              {include: '#parameter-declarations'},
              {include: '#type-parameter-list'},
              {include: '#punctuation'},
            ],
          },
          {
            match: '^(\\s*)(' + IDENTIFIER + ')(?=\\s*\\([^\\r\\n]*\\)\\s*=>)',
            captures: {
              '2': {name: TEA_SCOPES.functionName},
            },
          },
        ],
      },
      'parameter-declarations': {
        patterns: [
          {
            match:
              '(?:(?<=\\()|(?<=,))(\\s*)(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              IDENTIFIER +
              ')(\\.)(' +
              IDENTIFIER +
              ')(\\s+)(' +
              IDENTIFIER +
              ')\\b',
            captures: {
              '2': {name: 'storage.modifier.qualifier.tea'},
              '4': {name: TEA_SCOPES.namespace},
              '5': {name: 'punctuation.accessor.tea'},
              '6': {name: TEA_SCOPES.typeName},
              '8': {name: TEA_SCOPES.parameter},
            },
          },
          {
            match:
              '(?:(?<=\\()|(?<=,))(\\s*)(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              typeWords +
              ')(\\s+)(' +
              IDENTIFIER +
              ')\\b',
            captures: {
              '2': {name: 'storage.modifier.qualifier.tea'},
              '4': {name: TEA_SCOPES.builtinType},
              '6': {name: TEA_SCOPES.parameter},
            },
          },
          {
            match:
              '(?:(?<=\\()|(?<=,))(\\s*)(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              IDENTIFIER +
              ')(\\s+)(' +
              IDENTIFIER +
              ')\\b',
            captures: {
              '2': {name: 'storage.modifier.qualifier.tea'},
              '4': {name: TEA_SCOPES.typeName},
              '6': {name: TEA_SCOPES.parameter},
            },
          },
          {
            match:
              '(?:(?<=\\()|(?<=,))(\\s*)(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              TYPE_SYNTAX +
              ')(\\s+)(' +
              IDENTIFIER +
              ')\\b',
            captures: {
              '2': {name: 'storage.modifier.qualifier.tea'},
              '4': {name: 'meta.type.annotation.tea'},
              '6': {name: TEA_SCOPES.parameter},
            },
          },
        ],
      },
      'receiver-keyword': {
        patterns: [
          {match: words([Tok.This]), name: 'variable.language.receiver.tea'},
        ],
      },
      'method-receiver-modifier': {
        patterns: [
          {
            match:
              '(?<=\\))(\\s*)(' +
              words([Tok.Const]) +
              ')(?=\\s*(?:=>)?\\s*(?://.*)?$)',
            captures: {'2': {name: TEA_SCOPES.receiverModifier}},
          },
        ],
      },
      'for-header': {
        name: 'meta.control.loop.tea',
        begin: '^(\\s*)(' + Tok.For + ')\\b',
        beginCaptures: {
          '2': {name: 'keyword.control.loop.tea'},
        },
        end: '(?=$)',
        patterns: [
          {include: '#comments'},
          {include: '#strings'},
          {match: words(LOOP_KEYWORDS), name: 'keyword.control.loop.tea'},
          {include: '#storage-modifiers'},
          {include: '#control-keywords'},
          {include: '#language-constants'},
          {include: '#script-declarations'},
          {include: '#function-calls'},
          {include: '#type-annotations'},
          {include: '#members'},
          {include: '#colors'},
          {include: '#numbers'},
          {include: '#operators'},
          {include: '#punctuation'},
        ],
      },
      'storage-modifiers': {
        patterns: [
          {match: words(MODES), name: 'storage.modifier.declaration.tea'},
        ],
      },
      'control-keywords': {
        patterns: [{match: words(controls), name: 'keyword.control.tea'}],
      },
      'language-constants': {
        patterns: [{match: words(constants), name: 'constant.language.tea'}],
      },
      'script-declarations': {
        patterns: [
          {
            match: words(declarations) + '(?=\\s*\\()',
            name: 'support.function.declaration.tea',
          },
        ],
      },
      'function-calls': {
        patterns: [
          {
            match: '\\b' + IDENTIFIER + '(?=\\s*(?:<[^>\\r\\n]+>\\s*)?\\()',
            name: TEA_SCOPES.functionCall,
          },
        ],
      },
      'type-annotations': {
        patterns: [
          {
            match:
              '^(\\s*)(?:(' +
              words(MODES) +
              ')(\\s+))?(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              typeWords +
              ')(?=\\s+' +
              IDENTIFIER +
              '\\b)',
            captures: {
              '2': {name: 'storage.modifier.declaration.tea'},
              '4': {name: 'storage.modifier.qualifier.tea'},
              '6': {name: TEA_SCOPES.builtinType},
            },
          },
          {
            match:
              '^(\\s*)(?:(' +
              words(MODES) +
              ')(\\s+))?(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              IDENTIFIER +
              ')(\\.)(' +
              IDENTIFIER +
              ')(?=\\s+' +
              IDENTIFIER +
              '\\b)',
            captures: {
              '2': {name: 'storage.modifier.declaration.tea'},
              '4': {name: 'storage.modifier.qualifier.tea'},
              '6': {name: TEA_SCOPES.namespace},
              '7': {name: 'punctuation.accessor.tea'},
              '8': {name: TEA_SCOPES.typeName},
            },
          },
          {
            match:
              '^(\\s*)(?:(' +
              words(MODES) +
              ')(\\s+))?(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              IDENTIFIER +
              ')(?=\\s+' +
              IDENTIFIER +
              '\\b)',
            captures: {
              '2': {name: 'storage.modifier.declaration.tea'},
              '4': {name: 'storage.modifier.qualifier.tea'},
              '6': {name: TEA_SCOPES.typeName},
            },
          },
          {
            match:
              '^(\\s*)(?!(?:' +
              [
                Tok.Export,
                Tok.Type,
                Tok.Struct,
                Tok.Interface,
                Tok.Enum,
                Tok.Import,
              ].join('|') +
              ')\\b)(?:(' +
              words(MODES) +
              ')(\\s+))?(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              TYPE_SYNTAX +
              ')(?=\\s+' +
              IDENTIFIER +
              '\\b)',
            captures: {
              '2': {name: 'storage.modifier.declaration.tea'},
              '4': {name: 'storage.modifier.qualifier.tea'},
              '6': {name: 'meta.type.annotation.tea'},
            },
          },
        ],
      },
      members: {
        patterns: [
          {
            match: '(?<=\\.)' + IDENTIFIER,
            name: 'variable.other.member.tea',
          },
        ],
      },
      colors: {
        patterns: [
          {
            match: '(?<![A-Za-z0-9_])#[0-9A-Fa-f]{8}(?![A-Za-z0-9_])',
            name: 'constant.other.color.tea',
          },
          {
            match: '(?<![A-Za-z0-9_])#[0-9A-Fa-f]{6}(?![A-Za-z0-9_])',
            name: 'constant.other.color.tea',
          },
        ],
      },
      numbers: {
        patterns: [
          {
            match:
              '(?<![A-Za-z0-9_])(?:(?:[0-9]+\\.[0-9]*|\\.[0-9]+)' +
              '(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)' +
              '(?![A-Za-z0-9_])',
            name: 'constant.numeric.float.tea',
          },
          {
            match: '(?<![A-Za-z0-9_.])[0-9]+(?![A-Za-z0-9_.])',
            name: 'constant.numeric.integer.tea',
          },
        ],
      },
      operators: {
        patterns: [
          {
            match: words([Op.And, Op.Or, Op.Not]),
            name: 'keyword.operator.logical.tea',
          },
          {match: '=>', name: 'keyword.operator.function.tea'},
          {
            match: '==|!=|<=|>=|<|>',
            name: 'keyword.operator.comparison.tea',
          },
          {
            match: ':=|\\+=|-=|\\*=|/=|%=|=(?!=|>)',
            name: 'keyword.operator.assignment.tea',
          },
          {match: '[+\\-*/%]', name: 'keyword.operator.arithmetic.tea'},
          {match: '[?:]', name: 'keyword.operator.ternary.tea'},
        ],
      },
      punctuation: {
        patterns: [
          {match: '\\(', name: 'punctuation.section.parens.begin.tea'},
          {match: '\\)', name: 'punctuation.section.parens.end.tea'},
          {match: '\\[', name: 'punctuation.section.brackets.begin.tea'},
          {match: '\\]', name: 'punctuation.section.brackets.end.tea'},
          {match: ',', name: 'punctuation.separator.comma.tea'},
          {match: '\\.', name: 'punctuation.accessor.tea'},
        ],
      },
    },
  };
}

export function renderGrammar(): string {
  return (
    JSON.stringify(generateGrammar(), null, 2).replace(
      '"fileTypes": [\n    "tea"\n  ]',
      '"fileTypes": ["tea"]',
    ) + '\n'
  );
}

async function main(): Promise<void> {
  const output = renderGrammar();
  const target = new URL('../syntaxes/tea.tmLanguage.json', import.meta.url);
  if (process.argv.includes('--check')) {
    const current = await Bun.file(target).text();
    if (current !== output) {
      console.error(
        'Tea TextMate grammar is stale; run bun run generate in ' +
          'editors/vscode.',
      );
      process.exitCode = 1;
    }
    return;
  }
  await Bun.write(target, output);
}

if (import.meta.main) {
  await main();
}
