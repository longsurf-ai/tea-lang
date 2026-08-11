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
            match:
              '^(\\s*)(?:(' +
              Tok.Export +
              ')(\\s+))?(' +
              Tok.Type +
              ')(\\s+)(' +
              IDENTIFIER +
              ')(\\s*)(=)(\\s*)(' +
              TYPE_SYNTAX +
              ')(?=\\s*(?://|/\\*|$))',
            captures: {
              '2': {name: 'storage.modifier.export.tea'},
              '4': {name: 'storage.type.alias.declaration.tea'},
              '6': {name: 'entity.name.type.alias.tea'},
              '8': {name: 'keyword.operator.assignment.tea'},
              '10': {name: 'entity.name.type.tea'},
            },
          },
          {
            match:
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
              ')(?=\\s*(?://|/\\*|$))',
            captures: {
              '2': {name: 'storage.modifier.export.tea'},
              '4': {name: 'storage.type.declaration.tea'},
              '6': {name: 'entity.name.type.tea'},
            },
          },
          {
            match:
              '^(\\s*)(?:(' +
              Tok.Export +
              ')(\\s+))?(' +
              Tok.Enum +
              ')(\\s+)(' +
              IDENTIFIER +
              ')(?=\\s*(?://|/\\*|$))',
            captures: {
              '2': {name: 'storage.modifier.export.tea'},
              '4': {name: 'storage.type.enum.declaration.tea'},
              '6': {name: 'entity.name.type.enum.tea'},
            },
          },
        ],
      },
      'function-declarations': {
        patterns: [
          {
            match:
              '^(\\s+)(?:(' +
              words(QUALIFIERS) +
              ')(\\s+))?(' +
              TYPE_SYNTAX +
              ')(\\s+)(' +
              IDENTIFIER +
              ')(?=\\s*\\([^\\r\\n]*\\)\\s*(?:' +
              Tok.Const +
              '\\s*)?=>)',
            captures: {
              '2': {name: 'storage.modifier.qualifier.tea'},
              '4': {name: 'meta.type.return.tea'},
              '6': {name: 'entity.name.function.tea'},
            },
          },
          {
            match:
              '^(\\s*)(' +
              Tok.Export +
              ')(\\s+)(' +
              IDENTIFIER +
              ')(?=\\s*\\()',
            captures: {
              '2': {name: 'storage.modifier.export.tea'},
              '4': {name: 'entity.name.function.tea'},
            },
          },
          {
            match: '^(\\s*)(' + IDENTIFIER + ')(?=\\s*\\([^\\r\\n]*\\)\\s*=>)',
            captures: {
              '2': {name: 'entity.name.function.tea'},
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
            match: words([Tok.Const]) + '(?=\\s*=>)',
            name: 'storage.modifier.receiver.tea',
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
            name: 'entity.name.function.call.tea',
          },
        ],
      },
      'type-annotations': {
        patterns: [
          {
            match:
              words(QUALIFIERS) +
              '(?=\\s+' +
              TYPE_SYNTAX +
              '\\s+' +
              IDENTIFIER +
              '\\b)',
            name: 'storage.modifier.qualifier.tea',
          },
          {
            match:
              typeWords +
              '(?=(?:\\s*<[^>\\r\\n]+>)?(?:\\s*\\[\\])*\\s+' +
              IDENTIFIER +
              '\\b)',
            name: 'support.type.builtin.tea',
          },
          {
            match:
              '\\b' +
              IDENTIFIER +
              '(?:\\.' +
              IDENTIFIER +
              ')?(?=(?:\\s*<[^>\\r\\n]+>)?(?:\\s*\\[\\])*\\s+' +
              IDENTIFIER +
              '\\b)',
            name: 'entity.name.type.tea',
          },
          {
            match: '(?<=[<,])(\\s*)(' + typeWords + ')',
            captures: {
              '2': {name: 'support.type.builtin.tea'},
            },
          },
          {
            match:
              '(?<=[<,])(\\s*)(' + IDENTIFIER + '(?:\\.' + IDENTIFIER + ')?)',
            captures: {
              '2': {name: 'entity.name.type.tea'},
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
          'packages/tea-lang/editors/vscode.',
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
