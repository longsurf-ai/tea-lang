// Purpose: Lock the generated Tea TextMate grammar to compiler vocabulary and representative lexical forms.

import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {describe, expect, test} from 'vitest';
import {createOnigScanner, createOnigString, loadWASM} from 'vscode-oniguruma';
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type StateStack,
} from 'vscode-textmate';
import {
  CONTEXTUAL_KEYWORDS,
  RESERVED_KEYWORDS,
} from '../../../src/syntax/tokens';
import {
  TEA_SCOPES,
  generateGrammar,
  renderGrammar,
} from '../scripts/generate-syntax';

interface ScopedToken {
  readonly line: number;
  readonly text: string;
  readonly scopes: readonly string[];
}

const require = createRequire(__filename);
await loadWASM(
  await readFile(require.resolve('vscode-oniguruma/release/onig.wasm')),
);
const registry = new Registry({
  onigLib: Promise.resolve({createOnigScanner, createOnigString}),
  loadGrammar: async scopeName =>
    scopeName === 'source.tea'
      ? parseRawGrammar(renderGrammar(), 'tea.tmLanguage.json')
      : null,
});
const loadedTeaGrammar = await registry.loadGrammar('source.tea');
if (loadedTeaGrammar === null) {
  throw new Error('failed to load generated Tea grammar');
}
const teaGrammar = loadedTeaGrammar;

function tokenize(source: string): ScopedToken[] {
  let ruleStack: StateStack = INITIAL;
  return source.split('\n').flatMap((line, lineIndex) => {
    const result = teaGrammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;
    return result.tokens
      .map(token => ({
        line: lineIndex + 1,
        text: line.slice(token.startIndex, token.endIndex),
        scopes: token.scopes,
      }))
      .filter(token => token.text.trim().length > 0);
  });
}

function tokensNamed(
  tokens: readonly ScopedToken[],
  text: string,
): ScopedToken[] {
  return tokens.filter(token => token.text === text);
}

function matches(
  patterns: readonly {readonly match: string}[],
  text: string,
): boolean {
  return patterns.some(pattern =>
    new RegExp('^(?:' + pattern.match + ')$').test(text),
  );
}

function collectRegexes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectRegexes);
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const regexes: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === 'match' || key === 'begin' || key === 'end') &&
      typeof child === 'string'
    ) {
      regexes.push(child);
      continue;
    }
    regexes.push(...collectRegexes(child));
  }
  return regexes;
}

describe('Tea TextMate grammar', () => {
  test('highlights emission and return keywords while retaining ternary operators', () => {
    const tokens = tokenize(
      'emit "price" flag ? close : open\nemit.append "fills" value\nreturn value',
    );
    for (const token of [
      ...tokensNamed(tokens, 'emit'),
      ...tokensNamed(tokens, 'return'),
    ]) {
      expect(token.scopes).toContain('keyword.control.tea');
    }
    expect(tokensNamed(tokens, 'emit')).toHaveLength(2);
    expect(tokensNamed(tokens, 'return')).toHaveLength(1);
    expect(tokensNamed(tokens, '?')).toHaveLength(1);
    expect(tokensNamed(tokens, ':')).toHaveLength(1);
  });
  test('generated file is current', async () => {
    const target = new URL('../syntaxes/tea.tmLanguage.json', import.meta.url);
    expect(await readFile(target, 'utf8')).toBe(renderGrammar());
  });

  test('all generated regular expressions compile', () => {
    for (const regex of collectRegexes(generateGrammar())) {
      expect(() => new RegExp(regex)).not.toThrow();
    }
  });

  test('reserved and contextual keywords stay distinct', () => {
    const grammar = generateGrammar();
    const control = new RegExp(
      grammar.repository['control-keywords'].patterns[0].match,
    );
    const storage = new RegExp(
      grammar.repository['storage-modifiers'].patterns[0].match,
    );
    const receiver = new RegExp(
      grammar.repository['receiver-keyword'].patterns[0].match,
    );
    for (const keyword of RESERVED_KEYWORDS) {
      expect(
        control.test(keyword) ||
          storage.test(keyword) ||
          receiver.test(keyword),
      ).toBe(true);
    }
    for (const keyword of CONTEXTUAL_KEYWORDS) {
      expect(control.test(keyword) || storage.test(keyword)).toBe(false);
    }

    const importPattern = new RegExp(
      grammar.repository.imports.patterns[0].match,
    );
    expect(importPattern.test('import owner/library/1 as lib')).toBe(true);
    expect(importPattern.test('import = enum')).toBe(false);
  });

  test('declaration scopes remain stable across enums, interfaces, aliases, and generic types', () => {
    const tokens = tokenize(
      [
        'export enum Direction',
        'export interface Broker',
        'export type Prices = array<float>',
        'export type Strategy<B: broker.Broker, P: portfolio.Portfolio>',
      ].join('\n'),
    );
    const exports = tokensNamed(tokens, 'export');
    expect(exports).toHaveLength(4);
    exports.forEach(token =>
      expect(token.scopes).toContain(TEA_SCOPES.exportModifier),
    );

    expect(tokensNamed(tokens, 'Direction')[0]?.scopes).toContain(
      TEA_SCOPES.enumName,
    );
    expect(tokensNamed(tokens, 'Broker')[0]?.scopes).toContain(
      TEA_SCOPES.interfaceName,
    );
    expect(tokensNamed(tokens, 'Prices')[0]?.scopes).toContain(
      TEA_SCOPES.aliasName,
    );
    expect(tokensNamed(tokens, 'Strategy')[0]?.scopes).toContain(
      TEA_SCOPES.typeName,
    );
    const typeKeywords = tokensNamed(tokens, 'type');
    expect(typeKeywords).toHaveLength(2);
    typeKeywords.forEach(token => {
      expect(
        token.scopes.some(scope => scope.startsWith('storage.type.')),
      ).toBe(true);
      expect(token.scopes).not.toContain(TEA_SCOPES.typeName);
    });
    for (const parameter of ['B', 'P']) {
      expect(tokensNamed(tokens, parameter)[0]?.scopes).toContain(
        TEA_SCOPES.typeParameter,
      );
    }
    for (const namespace of ['broker', 'portfolio']) {
      expect(tokensNamed(tokens, namespace)[0]?.scopes).toContain(
        TEA_SCOPES.namespace,
      );
    }
  });

  test('incomplete and nested generic syntax stays inside its declaration line', () => {
    const tokens = tokenize(
      [
        'export type Nested = map<string, array<float>>',
        'export type Incomplete<T:',
        'export enum StillSeparate',
      ].join('\n'),
    );
    expect(tokensNamed(tokens, 'export')).toHaveLength(3);
    tokensNamed(tokens, 'export').forEach(token =>
      expect(token.scopes).toContain(TEA_SCOPES.exportModifier),
    );
    for (const builtin of ['map', 'string', 'array', 'float']) {
      expect(tokensNamed(tokens, builtin)[0]?.scopes).toContain(
        TEA_SCOPES.builtinType,
      );
    }
    expect(tokensNamed(tokens, 'T')[0]?.scopes).toContain(
      TEA_SCOPES.typeParameter,
    );
    expect(tokensNamed(tokens, 'StillSeparate')[0]?.scopes).toContain(
      TEA_SCOPES.enumName,
    );
  });

  test('methods retain syntactic result, parameter, receiver, and function scopes', () => {
    const tokens = tokenize(
      '    broker.Fill begin(float openPrice, int barIndex) const =>',
    );
    expect(tokensNamed(tokens, 'broker')[0]?.scopes).toContain(
      'meta.type.return.tea',
    );
    expect(tokensNamed(tokens, 'broker')[0]?.scopes).toContain(
      TEA_SCOPES.namespace,
    );
    expect(tokensNamed(tokens, 'Fill')[0]?.scopes).toContain(
      TEA_SCOPES.typeName,
    );
    expect(tokensNamed(tokens, 'begin')[0]?.scopes).toContain(
      TEA_SCOPES.functionName,
    );
    expect(tokensNamed(tokens, 'float')[0]?.scopes).toContain(
      TEA_SCOPES.builtinType,
    );
    expect(tokensNamed(tokens, 'openPrice')[0]?.scopes).toContain(
      TEA_SCOPES.parameter,
    );
    expect(tokensNamed(tokens, 'barIndex')[0]?.scopes).toContain(
      TEA_SCOPES.parameter,
    );
    expect(tokensNamed(tokens, 'const')[0]?.scopes).toContain(
      TEA_SCOPES.receiverModifier,
    );
  });

  test('builtin result types and receiver modifiers are identical in interface and implemented methods', () => {
    const tokens = tokenize(
      [
        'export interface Portfolio',
        '    bool is_flat() const',
        '    float mark(float price)',
        '    int apply(broker.Fill execution)',
        'export type Basic',
        '    bool flag',
        '    bool is_flat() const =>',
        '        this.flag',
        '    float mark(float price) =>',
        '        price',
        '    int apply(broker.Fill execution) =>',
        '        1',
      ].join('\n'),
    );

    for (const builtin of ['bool', 'float', 'int']) {
      const occurrences = tokensNamed(tokens, builtin);
      expect(occurrences.length).toBeGreaterThanOrEqual(2);
      occurrences.forEach(token =>
        expect(token.scopes).toContain(TEA_SCOPES.builtinType),
      );
    }

    const receiverModifiers = tokensNamed(tokens, 'const');
    expect(receiverModifiers).toHaveLength(2);
    receiverModifiers.forEach(token => {
      expect(token.scopes).toContain(TEA_SCOPES.receiverModifier);
      expect(token.scopes).not.toContain('storage.modifier.declaration.tea');
    });
  });

  test('contextual words remain identifiers outside their governing shapes', () => {
    const tokens = tokenize(
      [
        'export = 1',
        'type = export',
        'method append(inout Foo self, float value) =>',
      ].join('\n'),
    );
    for (const word of ['export', 'type', 'method', 'inout']) {
      for (const token of tokensNamed(tokens, word)) {
        expect(token.scopes.some(scope => scope.startsWith('storage.'))).toBe(
          false,
        );
        expect(token.scopes.some(scope => scope.startsWith('keyword.'))).toBe(
          false,
        );
      }
    }
  });

  test('scanner-supported number and color forms are covered', () => {
    const grammar = generateGrammar();
    const numbers = grammar.repository.numbers.patterns;
    for (const number of ['0', '42', '3.14', '1.', '.5', '6.02e23', '1e-9']) {
      expect(matches(numbers, number)).toBe(true);
    }
    for (const number of ['1e', '.']) {
      expect(matches(numbers, number)).toBe(false);
    }

    const colors = grammar.repository.colors.patterns;
    for (const color of ['#ff0000', '#FF00AA80']) {
      expect(matches(colors, color)).toBe(true);
    }
    for (const color of ['#fff', '#ff00000', '#ff0000000']) {
      expect(matches(colors, color)).toBe(false);
    }
  });
});
