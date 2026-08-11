// Purpose: Lock the generated Tea TextMate grammar to compiler vocabulary and representative lexical forms.

import {describe, expect, test} from 'bun:test';
import {
  CONTEXTUAL_KEYWORDS,
  RESERVED_KEYWORDS,
} from '../../../src/syntax/tokens';
import {generateGrammar, renderGrammar} from '../scripts/generate-syntax';

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
  test('generated file is current', async () => {
    const target = new URL('../syntaxes/tea.tmLanguage.json', import.meta.url);
    expect(await Bun.file(target).text()).toBe(renderGrammar());
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
      ).toBeTrue();
    }
    for (const keyword of CONTEXTUAL_KEYWORDS) {
      expect(control.test(keyword) || storage.test(keyword)).toBeFalse();
    }

    const importPattern = new RegExp(
      grammar.repository.imports.patterns[0].match,
    );
    expect(importPattern.test('import owner/library/1 as lib')).toBeTrue();
    expect(importPattern.test('import = enum')).toBeFalse();
  });

  test('user types, aliases, and nested methods have dedicated scopes', () => {
    const grammar = generateGrammar();
    const types = grammar.repository['type-declarations'].patterns;
    const methods = grammar.repository['function-declarations'].patterns;
    const alias = new RegExp(types[0].match).exec(
      'export type Prices = array<float>',
    );
    const blockType = new RegExp(types[1].match).exec('struct Portfolio');
    const method = new RegExp(methods[0].match).exec(
      '    series int add(int qty) const =>',
    );
    expect(alias?.[4]).toBe('type');
    expect(alias?.[6]).toBe('Prices');
    expect(alias?.[10]).toBe('array<float>');
    expect(blockType?.[4]).toBe('struct');
    expect(blockType?.[6]).toBe('Portfolio');
    expect(method?.[2]).toBe('series');
    expect(method?.[4]).toBe('int');
    expect(method?.[6]).toBe('add');
    expect(methods[0].captures['6']).toEqual({
      name: 'entity.name.function.tea',
    });

    const modifier = new RegExp(
      grammar.repository['method-receiver-modifier'].patterns[0].match,
    );
    const receiver = new RegExp(
      grammar.repository['receiver-keyword'].patterns[0].match,
    );
    expect(modifier.test('const =>')).toBeTrue();
    expect(receiver.test('this')).toBeTrue();
    expect(grammar.repository['receiver-keyword'].patterns[0].name).toBe(
      'variable.language.receiver.tea',
    );
  });

  test('legacy method and inout have no keyword scopes', () => {
    const grammar = generateGrammar();
    const methods = grammar.repository['function-declarations'].patterns;
    expect(
      methods.some(pattern =>
        new RegExp(pattern.match).test(
          'method append(inout Foo self, float value) =>',
        ),
      ),
    ).toBeFalse();
    expect(
      grammar.repository['method-receiver-modifier'].patterns[0].match,
    ).not.toContain('inout');
    expect(
      grammar.repository['receiver-keyword'].patterns[0].match,
    ).not.toContain('method');
    expect(
      grammar.repository['receiver-keyword'].patterns[0].match,
    ).not.toContain('inout');
    expect(
      grammar.repository['type-declarations'].patterns[1].captures['4'],
    ).toEqual({
      name: 'storage.type.declaration.tea',
    });
  });

  test('scanner-supported number and color forms are covered', () => {
    const grammar = generateGrammar();
    const numbers = grammar.repository.numbers.patterns;
    for (const number of ['0', '42', '3.14', '1.', '.5', '6.02e23', '1e-9']) {
      expect(matches(numbers, number)).toBeTrue();
    }
    for (const number of ['1e', '.']) {
      expect(matches(numbers, number)).toBeFalse();
    }

    const colors = grammar.repository.colors.patterns;
    for (const color of ['#ff0000', '#FF00AA80']) {
      expect(matches(colors, color)).toBeTrue();
    }
    for (const color of ['#fff', '#ff00000', '#ff0000000']) {
      expect(matches(colors, color)).toBeFalse();
    }
  });
});
