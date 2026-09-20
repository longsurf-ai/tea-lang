// Purpose: hover, definition and references tests — one fixture covering a local, a parameter of a function called with two signatures, a struct field, a method, a ta.* library function, a native, and the places with no answer.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import type {Position, Range} from 'vscode-languageserver';
import {analyze} from './analysis';
import {definition, hover, references} from './name-queries';

const FILE = '/charts/fixture.tea';
const LINES = [
  'struct Bar', // 1
  '    float top = 0.0', // 2
  '    float scaled(float k) const =>', // 3
  '        this.top * k', // 4
  'g(x) =>', // 5
  '    y = x + 1', // 6
  '    y', // 7
  'unused(z, simple int n) => z', // 8
  'bar = Bar.new(high)', // 9
  'a = g(close)', // 10
  'b = g(1)', // 11
  'peak = bar.top', // 12
  'half = bar.scaled(0.5)', // 13
  'fast = ta.ema(close, 14)', // 14
  'best = math.max(a, fast)', // 15
  'if a > b', // 16
  '    plot("line", a)', // 17
];
const analysis = analyze({filename: FILE, source: LINES.join('\n')});

// The range of the first whole-word `word` on the 1-based `line`.
function rangeOf(line: number, word: string): Range {
  const character = LINES[line - 1].search(new RegExp(`\\b${word}\\b`));
  expect(character).toBeGreaterThanOrEqual(0);
  return {
    start: {line: line - 1, character},
    end: {line: line - 1, character: character + word.length},
  };
}

function on(line: number, word: string): Position {
  return rangeOf(line, word).start;
}

// The lines of the hover's `tea` block, or null.
function hoverLines(position: Position): string[] | null {
  const result = hover(analysis, position);
  if (result === null) {
    return null;
  }
  expect(result.contents).toMatchObject({kind: 'markdown'});
  const {value} = result.contents as {value: string};
  expect(value.startsWith('```tea\n') && value.endsWith('\n```')).toBe(true);
  return value.split('\n').slice(1, -1);
}

const inThisFile = (line: number, word: string) => ({
  filename: FILE,
  range: rangeOf(line, word),
});

// Places with no name under them, and names with no fact.
const SILENT: readonly (readonly [string, Position])[] = [
  ['indentation', {line: 5, character: 1}],
  ['the keyword `if`', on(16, 'if')],
  ['the keyword `struct`', on(1, 'struct')],
  ['an operator', {line: 5, character: 10}],
  ['a number', on(14, '14')],
  ['a line past the end', {line: 99, character: 0}],
  ['a parameter of an uncalled function', on(8, 'z')],
  ['a use inside an uncalled function', {line: 7, character: 27}],
];

test('the fixture checks cleanly', () => {
  expect(analysis.diagnostics).toEqual([]);
});

describe('hover', () => {
  test('a local and a context builtin show qualifier, type and name', () => {
    expect(hoverLines(on(12, 'bar'))).toEqual(['series Bar bar']);
    expect(hoverLines(on(11, 'b'))).toEqual(['const int b']);
    expect(hoverLines(on(10, 'close'))).toEqual(['series float close']);
    expect(hover(analysis, on(12, 'bar'))?.range).toEqual(rangeOf(12, 'bar'));
  });

  test('a parameter of a function called two ways lists each type once', () => {
    const both = ['series float x', 'const int x'];
    expect(hoverLines(on(5, 'x'))).toEqual(both);
    expect(hoverLines(on(6, 'x'))).toEqual(both);
    expect(hoverLines(on(7, 'y'))).toEqual(['series float y', 'const int y']);
  });

  test('a function shows every signature at its declaration, one at a call', () => {
    const ofClose = 'series float g(series float x)';
    const ofOne = 'const int g(const int x)';
    expect(hoverLines(on(5, 'g'))).toEqual([ofClose, ofOne]);
    expect(hoverLines(on(10, 'g'))).toEqual([ofClose]);
    expect(hoverLines(on(11, 'g'))).toEqual([ofOne]);
  });

  test('an uncalled function shows its written parameters', () => {
    expect(hoverLines(on(8, 'unused'))).toEqual(['unused(z, simple int n)']);
  });

  test('a field shows its type, and its qualifier where it is selected', () => {
    expect(hoverLines(on(2, 'top'))).toEqual(['float top']);
    expect(hoverLines(on(12, 'top'))).toEqual(['series float top']);
    expect(hoverLines(on(4, 'top'))).toEqual(['series float top']);
  });

  test('a method shows its signature; its instances agree, so once', () => {
    const scaled = ['series float Bar.scaled(const float k)'];
    expect(hoverLines(on(3, 'scaled'))).toEqual(scaled);
    expect(hoverLines(on(13, 'scaled'))).toEqual(scaled);
    expect(hoverLines(on(4, 'k'))).toEqual(['const float k']);
  });

  test('a ta.* function shows the signature this call stenciled', () => {
    expect(hoverLines(on(14, 'ema'))).toEqual([
      'series float ta.ema(series float source, const int length)',
    ]);
  });

  test('a native shows the catalog signature of the resolved overload', () => {
    expect(hoverLines(on(15, 'max'))).toEqual([
      'math.max(number: int | float, ...number1: int | float) → float',
    ]);
    expect(hover(analysis, on(15, 'max'))?.range).toEqual(rangeOf(15, 'max'));
    // The namespace is not a value.
    expect(hoverLines(on(15, 'math'))).toBeNull();
  });

  test('a position just past a name still finds it', () => {
    const {end} = rangeOf(12, 'bar');
    expect(hover(analysis, end)?.range).toEqual(rangeOf(12, 'bar'));
    expect(hover(analysis, {...end, character: end.character + 1})).toEqual(
      hover(analysis, on(12, 'top')),
    );
  });

  test.each(SILENT)('%s has none', (_, position) => {
    expect(hover(analysis, position)).toBeNull();
  });
});

describe('definition', () => {
  test('a use goes to its declaration in this file', () => {
    expect(definition(analysis, on(12, 'bar'))).toEqual([inThisFile(9, 'bar')]);
    expect(definition(analysis, on(11, 'g'))).toEqual([inThisFile(5, 'g')]);
    expect(definition(analysis, on(12, 'top'))).toEqual([inThisFile(2, 'top')]);
    expect(definition(analysis, on(13, 'scaled'))).toEqual([
      inThisFile(3, 'scaled'),
    ]);
    expect(definition(analysis, on(9, 'Bar'))).toEqual([inThisFile(1, 'Bar')]);
  });

  test('a declaration is its own definition', () => {
    expect(definition(analysis, on(9, 'bar'))).toEqual([inThisFile(9, 'bar')]);
  });

  test('a parameter with one object per instance has one definition', () => {
    expect(definition(analysis, on(6, 'x'))).toEqual([inThisFile(5, 'x')]);
  });

  test('a ta.* function is defined in the shipped library', () => {
    const [{filename, range}, ...rest] = definition(analysis, on(14, 'ema'));
    expect(rest).toEqual([]);
    expect(filename).toBe('tea-lib/ta.tea');
    const library = readFileSync(
      fileURLToPath(new URL('../tea-lib/ta.tea', import.meta.url)),
      'utf8',
    ).split('\n');
    expect(range.end.line).toBe(range.start.line);
    expect(
      library[range.start.line].slice(
        range.start.character,
        range.end.character,
      ),
    ).toBe('ema');
    expect(library[range.start.line]).toMatch(/^export ema\(/);
  });

  test('natives and context builtins have no source definition', () => {
    expect(definition(analysis, on(15, 'max'))).toEqual([]);
    expect(definition(analysis, on(10, 'close'))).toEqual([]);
  });

  test.each(SILENT)('%s has none', (_, position) => {
    expect(definition(analysis, position)).toEqual([]);
  });
});

describe('references', () => {
  test('a local: its declaration and every use, in position order', () => {
    const uses = [rangeOf(15, 'a'), rangeOf(16, 'a'), rangeOf(17, 'a')];
    expect(references(analysis, on(16, 'a'), true)).toEqual([
      rangeOf(10, 'a'),
      ...uses,
    ]);
    expect(references(analysis, on(16, 'a'), false)).toEqual(uses);
    expect(references(analysis, on(10, 'a'), false)).toEqual(uses);
  });

  test('a parameter: the union over instances, each node once', () => {
    expect(references(analysis, on(6, 'x'), true)).toEqual([
      rangeOf(5, 'x'),
      rangeOf(6, 'x'),
    ]);
  });

  test('a function, a field and a method', () => {
    expect(references(analysis, on(5, 'g'), true)).toEqual([
      rangeOf(5, 'g'),
      rangeOf(10, 'g'),
      rangeOf(11, 'g'),
    ]);
    expect(references(analysis, on(12, 'top'), true)).toEqual([
      rangeOf(2, 'top'),
      rangeOf(4, 'top'),
      rangeOf(12, 'top'),
    ]);
    expect(references(analysis, on(3, 'scaled'), false)).toEqual([
      rangeOf(13, 'scaled'),
    ]);
  });

  test('a ta.* function: only this document, whose uses are all it has', () => {
    expect(references(analysis, on(14, 'ema'), true)).toEqual([
      rangeOf(14, 'ema'),
    ]);
  });

  test('every reference has the definition of the name asked about', () => {
    for (const {name, facts} of analysis.names) {
      const position = {line: name.pos.line - 1, character: name.pos.col - 1};
      const found = references(analysis, position, true);
      expect(found.length > 0).toBe(facts.length > 0);
      for (const range of found) {
        expect(definition(analysis, range.start)).toEqual(
          definition(analysis, position),
        );
      }
    }
  });

  test('a native has no object, so none', () => {
    expect(references(analysis, on(15, 'max'), true)).toEqual([]);
  });

  test.each(SILENT)('%s has none', (_, position) => {
    expect(references(analysis, position, true)).toEqual([]);
  });
});

describe('across the files a script imports', () => {
  const IMPORTS = join(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../tests/fixtures/imports',
  );
  const entry = join(IMPORTS, 'strategies/entry.tea');
  const imported = analyze({
    filename: entry,
    source: readFileSync(entry, 'utf8'),
  });
  // Line 5 of the entry: `upper = bands.upper(10.0, 2.0)`.
  const onUpper = {line: 4, character: 15};

  test('definition leads into the imported file', () => {
    expect(definition(imported, onUpper)).toEqual([
      {
        filename: join(IMPORTS, 'strategies/lib/bands.tea'),
        range: {
          start: {line: 6, character: 7},
          end: {line: 6, character: 12},
        },
      },
    ]);
  });

  test('hover shows the imported function as it was called', () => {
    const value = hover(imported, onUpper)?.contents;
    expect(JSON.stringify(value)).toContain('upper(');
    expect(JSON.stringify(value)).toContain('float');
  });
});
