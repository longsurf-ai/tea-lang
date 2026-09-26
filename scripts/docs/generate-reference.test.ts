// Purpose: Verify the generated reference pages join real compiler facts with complete human-facing sections and checked examples.

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';

import {generate} from '../../src/codegen/codegen';
import {CATALOG} from '../../src/checker/catalog';
import {checkText, initTvOf} from '../../src/checker/testing';
import {PUBLIC_TYPE_CATALOG} from '../../src/checker/type-catalog';
import {Qualifier, formatType} from '../../src/ir/type';
import {buildText} from '../../src/noder/testing';
import {KEYWORDS} from '../../src/syntax/tokens';
import {
  categoryPage,
  entryPage,
  overviewPage,
  referenceOutputs,
} from './generate-reference';
import {
  PILOT_REFERENCE_ENTRIES,
  REFERENCE_CATEGORIES,
  type ConstantEntry,
  type FunctionEntry,
  type KeywordEntry,
  type TypeEntry,
  type VariableEntry,
} from './reference-pilot';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');

function entry<T extends (typeof PILOT_REFERENCE_ENTRIES)[number]['kind']>(
  kind: T,
): Extract<(typeof PILOT_REFERENCE_ENTRIES)[number], {kind: T}> {
  const found = PILOT_REFERENCE_ENTRIES.find(item => item.kind === kind);
  if (found === undefined) throw new Error(`missing pilot ${kind} entry`);
  return found as Extract<(typeof PILOT_REFERENCE_ENTRIES)[number], {kind: T}>;
}

describe('reference pilot information architecture', () => {
  test('has one focused entry and landing page for every reference category', () => {
    expect(REFERENCE_CATEGORIES).toEqual([
      'types',
      'variables',
      'constants',
      'functions',
      'keywords',
      'operators',
      'annotations',
    ]);
    expect(PILOT_REFERENCE_ENTRIES).toHaveLength(9);
    expect(
      [...new Set(PILOT_REFERENCE_ENTRIES.map(item => item.category))].sort(),
    ).toEqual([...REFERENCE_CATEGORIES].sort());
    expect(new Set(PILOT_REFERENCE_ENTRIES.map(item => item.route)).size).toBe(
      9,
    );

    const outputs = referenceOutputs(ROOT);
    expect(outputs.has(path.join(ROOT, 'docs/reference/overview.md'))).toBe(
      true,
    );
    for (const category of REFERENCE_CATEGORIES) {
      expect(
        outputs.has(path.join(ROOT, 'docs/reference', `${category}.md`)),
      ).toBe(true);
    }
    expect(
      [...outputs.keys()].some(file => file.endsWith('/reference/language.md')),
    ).toBe(false);
  });

  test('joins every representative entry to its compiler-owned fact', () => {
    const type = entry('type') as TypeEntry;
    expect(
      PUBLIC_TYPE_CATALOG.some(item => item.name === type.compilerName),
    ).toBe(true);

    // Market series are pine prelude aliases, so join through a checked read.
    const variable = entry('variable') as VariableEntry;
    const variableFact = initTvOf(
      checkText(`x = ${variable.compilerName}`),
      'x',
    );
    expect(variableFact.qualifier).toBe(Qualifier.Series);
    expect(variable.qualifiedType).toBe(
      `${variableFact.qualifier} ${formatType(variableFact.type)}`,
    );

    const constant = entry('constant') as ConstantEntry;
    const constantFact = CATALOG.vars.get(constant.compilerName);
    expect(constantFact?.qualifier).toBe(Qualifier.Const);
    expect(constantFact?.value).toBe(constant.value);

    const func = entry('function') as FunctionEntry;
    const overloads = CATALOG.funcs.get(func.compilerName);
    expect(overloads).toHaveLength(1);
    const supportedParams = [
      ...new Set(
        overloads!.flatMap(overload =>
          overload.params
            .filter(parameter => parameter.availability === 'supported')
            .map(parameter => parameter.name),
        ),
      ),
    ].sort();
    expect(Object.keys(func.arguments).sort()).toEqual(supportedParams);

    for (const keyword of PILOT_REFERENCE_ENTRIES.filter(
      item => item.kind === 'keyword',
    )) {
      for (const token of keyword.compilerKeywords) {
        expect((KEYWORDS as readonly string[]).includes(token)).toBe(true);
      }
    }
  });

  test('builds and JS-generates every named example', () => {
    for (const item of PILOT_REFERENCE_ENTRIES) {
      expect(item.examples.length).toBeGreaterThan(0);
      for (const example of item.examples) {
        expect(example.title).not.toMatch(/^Example\s*\d*$/i);
        const result = buildText(
          example.source,
          `reference-${item.category}-${item.id}.tea`,
        );
        expect(
          result.errors.map(error => `${error.pos.line}: ${error.msg}`),
        ).toEqual([]);
        expect(result.program).not.toBeNull();
        expect(generate(result.program!).length).toBeGreaterThan(0);
      }
    }
  });

  test('renders kind-specific sections instead of one catalog template', () => {
    expect(entryPage(entry('type'))).toContain('## Construction');
    expect(entryPage(entry('variable'))).toContain('## Type');
    expect(entryPage(entry('constant'))).toContain('## Value');
    const functionMarkdown = entryPage(entry('function'));
    expect(functionMarkdown).toContain('## Arguments');
    expect(functionMarkdown).toContain('## Returns');
    expect(functionMarkdown).toContain('## Runtime errors');
    const keywordMarkdown = entryPage(entry('keyword'));
    expect(keywordMarkdown).toContain('## Syntax components');
    expect(keywordMarkdown).toContain('## Type relationships');
    expect(keywordMarkdown).toContain('## Loop result');
    expect(entryPage(entry('operator'))).toContain('## Operands');
    expect(entryPage(entry('annotation'))).toContain('## Placement');
    for (const item of PILOT_REFERENCE_ENTRIES) {
      const markdown = entryPage(item);
      expect(markdown).toContain('## Examples');
      expect(markdown).toContain('## Remarks');
      expect(markdown).toContain('## See also');
    }
  });

  test('gives for...in a typed grammar and examples for each distinct behavior', () => {
    const keyword = entry('keyword');
    const markdown = entryPage(keyword);

    expect(markdown).toContain('[result = | result :=] for element in array');
    expect(markdown).toContain('return_expression');
    expect(markdown).toContain('array<Element>');
    expect(markdown).toContain('map<Key, Value>');
    expect(markdown).toContain('series Key, series Value');
    expect(markdown).not.toContain('arrayValue');
    expect(markdown).not.toContain('mapValue');
    expect(keyword.examples).toHaveLength(4);
  });

  test('publishes no compiler status or implementation jargon', () => {
    const markdown = [
      overviewPage(),
      ...REFERENCE_CATEGORIES.map(categoryPage),
      ...PILOT_REFERENCE_ENTRIES.map(entryPage),
    ].join('\n');
    expect(markdown).not.toMatch(
      /\bImplemented\b|\bReserved\b|Qualifier cap|Native effect class|\binout\b|StorageRef|\bRing\b/,
    );
  });

  test('links only to pilot entries, category landings, or the overview', () => {
    const routes = new Set([
      '/reference/overview/',
      ...REFERENCE_CATEGORIES.map(category => `/reference/${category}/`),
      ...PILOT_REFERENCE_ENTRIES.map(item => item.route),
    ]);
    for (const item of PILOT_REFERENCE_ENTRIES) {
      for (const link of item.seeAlso) expect(routes.has(link.href)).toBe(true);
      if (item.kind === 'type') {
        for (const link of [...item.construction, ...item.operations]) {
          expect(routes.has(link.href)).toBe(true);
        }
      }
    }
  });
});
