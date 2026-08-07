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
    for (const keyword of RESERVED_KEYWORDS) {
      expect(control.test(keyword) || storage.test(keyword)).toBeTrue();
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
