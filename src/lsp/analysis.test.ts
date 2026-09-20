// Purpose: analyze() tests — diagnostic ranges, agreement with compileToProgram, crash-freedom on truncated sources, and the name index.

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {DiagnosticSeverity, type Range} from 'vscode-languageserver';
import {Errors} from '../base/print';
import {CallKind} from '../checker/info';
import {ObjectKind} from '../checker/object';
import {compileToProgram} from '../compiler';
import {TypeKind} from '../ir/type';
import {analyze, type Analysis, type IndexedName} from './analysis';

const FIXTURES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures',
);

// Every .tea file under tests/fixtures, as paths relative to it.
const FIXTURE_FILES = readdirSync(FIXTURES, {recursive: true, encoding: 'utf8'})
  .filter(path => path.endsWith('.tea'))
  .sort();

function analyzeText(source: string): Analysis {
  return analyze({filename: 'test.tea', source});
}

// `line:start-end message`, in LSP's 0-based units.
function rendered(analysis: Analysis): string[] {
  return analysis.diagnostics.map(({range, message}) => {
    expect(range.end.line).toBe(range.start.line);
    return `${range.start.line}:${range.start.character}-${range.end.character} ${message}`;
  });
}

const PARSE_ERROR = "expected expression, found 'newline'";
const TYPE_ERROR =
  "operator '+' requires numeric operands (got float and string)";

describe('diagnostics', () => {
  test('a parse error at a line end covers the last character before it', () => {
    expect(rendered(analyzeText('x = 1 +\n'))).toEqual([
      `0:6-7 ${PARSE_ERROR}`,
    ]);
  });

  test('a type error covers the token at its position', () => {
    const analysis = analyzeText('y = close + "a"\n');
    expect(rendered(analysis)).toEqual([`0:4-9 ${TYPE_ERROR}`]);
    expect(analysis.diagnostics[0]).toMatchObject({
      severity: DiagnosticSeverity.Error,
      source: 'tea',
    });
  });

  test('checking continues past a parse error', () => {
    expect(rendered(analyzeText('x = 1 +\ny = close + "a"\n'))).toEqual([
      `0:6-7 ${PARSE_ERROR}`,
      `1:4-9 ${TYPE_ERROR}`,
    ]);
  });

  test('an error at end of file backs up to the last character', () => {
    // Inside an open group the statement ends at 2:1, on an empty line.
    expect(rendered(analyzeText('x = (1 +\n'))).toEqual([
      `0:7-8 ${PARSE_ERROR}`,
    ]);
    expect(rendered(analyzeText('x = 1 +'))).toEqual([`0:6-7 ${PARSE_ERROR}`]);
    expect(rendered(analyzeText('x = 1 +  \r\n'))).toEqual([
      `0:6-7 ${PARSE_ERROR}`,
    ]);
  });

  test('columns count UTF-16 code units, as LSP does', () => {
    const source = 's = "日本😀" + missing\n';
    const start = source.indexOf('missing');
    expect(start).toBe(13); // the emoji is two code units
    expect(rendered(analyzeText(source))).toEqual([
      `0:${start}-${start + 'missing'.length} undeclared name 'missing'`,
    ]);
  });

  test('a position where no token starts extends to the end of the line', () => {
    // Reported at column 1, before the first token of the line.
    expect(rendered(analyzeText('   x = 1\n'))).toEqual([
      '0:0-8 unexpected indentation',
    ]);
    // A comment is not a token.
    expect(rendered(analyzeText('x = 1 /* open\ny = 2\n'))).toEqual([
      '0:6-13 block comment not terminated',
    ]);
  });

  test('a clean script has no diagnostics', () => {
    expect(analyzeText('plot("c", close)\n').diagnostics).toEqual([]);
    expect(analyzeText('').diagnostics).toEqual([]);
  });
});

describe('errors positioned in a library body', () => {
  const IN_EMA =
    "in ta.ema (tea-lib/ta.tea:27:24): operator '*' requires numeric operands (got float and string)";

  test('surface on the call in this document that caused them', () => {
    expect(rendered(analyzeText('e = ta.ema("a", 14)\n'))).toEqual([
      `0:4-10 ${IN_EMA}`,
    ]);
  });

  test('only the call with the bad signature is marked', () => {
    const analysis = analyzeText(
      'good = ta.ema(close, 14)\nbad = ta.ema("a", 14)\nplot("p", good)\n',
    );
    expect(rendered(analysis)).toEqual([`1:6-12 ${IN_EMA}`]);
  });

  test('every error of one call is kept, on the same range', () => {
    const lines = rendered(analyzeText('s = ta.sma(close, "x")\n'));
    expect(lines.length).toBe(2);
    expect(
      lines.every(line => line.startsWith('0:4-10 in ta.sma (tea-lib/ta.tea:')),
    ).toBe(true);
  });

  test('a call made inside a function of this document is marked where it is written', () => {
    const analysis = analyzeText(
      'smooth(src) =>\n    ta.ema(src, 14)\nx = smooth("a")\n',
    );
    expect(rendered(analysis)).toEqual([`1:4-10 ${IN_EMA}`]);
  });

  test('a library function reached through another library function marks the outer call', () => {
    // ta.macd calls ta.ema; the error sits in ema, the document wrote macd.
    const lines = rendered(
      analyzeText('[m, s, h] = ta.macd("a", 12, 26, 9)\n'),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines.every(line =>
        /^0:12-19 in ta\.macd \(tea-lib\/ta\.tea:\d+:\d+\): /.test(line),
      ),
    ).toBe(true);
  });
});

describe('agreement with compileToProgram', () => {
  // The files under fixtures/execution must compile. Every other fixture is
  // classified by what compileToProgram says about it; no acceptance is
  // asserted for them (fixtures/corpus is parse-only).
  const startsAt = (range: Range, line: number, col: number): boolean =>
    range.start.line === line - 1 && range.start.character === col - 1;
  // The range of an error with nothing after it on its line.
  const endsBefore = (range: Range, line: number, col: number): boolean =>
    range.end.line < line - 1 ||
    (range.end.line === line - 1 && range.end.character <= col - 1);

  test.each(FIXTURE_FILES)('%s', path => {
    const filename = join(FIXTURES, path);
    const input = {filename, source: readFileSync(filename, 'utf8')};
    const errors = new Errors();
    const program = compileToProgram([input], errors);
    const {diagnostics} = analyze(input);
    if (path.startsWith('execution')) {
      expect(program).not.toBeNull();
    }
    if (program !== null) {
      expect(diagnostics).toEqual([]);
      return;
    }
    // A rejected script always shows at least one diagnostic, even when every
    // error sits in a library body.
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const {pos, msg} of errors.flushErrors()) {
      if (pos.base.filename !== filename) {
        continue;
      }
      const match = diagnostics.find(
        ({range, message}) =>
          message === msg &&
          (startsAt(range, pos.line, pos.col) ||
            endsBefore(range, pos.line, pos.col)),
      );
      expect(match, `${pos.line}:${pos.col} ${msg}`).toBeDefined();
    }
  });

  test('the fixtures cover both outcomes', () => {
    const accepted = FIXTURE_FILES.filter(path => {
      const filename = join(FIXTURES, path);
      const source = readFileSync(filename, 'utf8');
      return compileToProgram([{filename, source}], new Errors()) !== null;
    });
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThan(FIXTURE_FILES.length);
  });
});

describe('robustness', () => {
  // Crash-freedom only, NOT acceptance: fixtures/corpus is parse-only, and a
  // truncated source is rarely valid anyway. analyze() must return, with
  // well-formed ranges, for whatever text an editor holds mid-keystroke.
  // Cuts are sampled to keep the run short: CUTS_PER_FILE lines spread over
  // each file, each cut at its line end and again in the middle of the line.
  const CUTS_PER_FILE = 25;

  test.each(FIXTURE_FILES)('truncated prefixes of %s', path => {
    const source = readFileSync(join(FIXTURES, path), 'utf8');
    const lineEnds = [...source.matchAll(/\n/g)].map(match => match.index);
    const step = Math.max(1, Math.ceil(lineEnds.length / CUTS_PER_FILE));
    for (let i = 0; i < lineEnds.length; i += step) {
      const lineStart = i === 0 ? 0 : lineEnds[i - 1] + 1;
      for (const cut of [lineEnds[i], (lineStart + lineEnds[i]) >> 1]) {
        const prefix = source.slice(0, cut);
        const lineCount = prefix.split('\n').length;
        for (const {range} of analyze({filename: path, source: prefix})
          .diagnostics) {
          expect(range.start.line).toBe(range.end.line);
          expect(range.start.line).toBeLessThan(lineCount);
          expect(range.start.character).toBeGreaterThanOrEqual(0);
          expect(range.end.character).toBeGreaterThan(range.start.character);
        }
      }
    }
  });

  // A compiler defect, not an analyze() one: compileToProgram throws the same
  // InternalError ('uncontextualized na reached Program construction') from
  // the noder. The source is valid, so the fix is a checker or noder decision
  // about a discarded `if` value, not poison.
  test('an else-less `if` whose block ends in `float y = na` analyzes', () => {
    expect(rendered(analyzeText('if close > 1\n    float y = na\n'))).toEqual(
      [],
    );
    expect(rendered(analyzeText('if close > 1\n    na\n'))).toEqual([]);
  });
});

describe('name index', () => {
  const analysis = analyzeText(
    [
      'struct Bar', // 1
      '    float top = 0.0', // 2
      'g(x) =>', // 3
      '    y = x + 1', // 4
      '    y', // 5
      'unused(z) => z', // 6
      'bar = Bar.new(high)', // 7
      'a = g(close)', // 8
      'b = g(1)', // 9
      'peak = bar.top', // 10
      'fast = ta.ema(close, 14)', // 11
      'safe = nz(fast)', // 12
      'sym = syminfo.tickerid', // 13
    ].join('\n'),
  );

  // The name spelled `value` that starts at `line`:`col` (1-based, as Pos).
  function at(line: number, col: number, value: string): IndexedName {
    const found = analysis.names.find(
      ({name}) => name.pos.line === line && name.pos.col === col,
    );
    expect(found?.name.value).toBe(value);
    return found!;
  }

  test('the fixture checks cleanly', () => {
    expect(analysis.diagnostics).toEqual([]);
  });

  test('holds every name of the document, sorted by position', () => {
    expect(analysis.names.map(({name}) => name.value).join(' ')).toBe(
      [
        'Bar float top',
        'g x y x y',
        'unused z z',
        'bar Bar new high',
        'a g close',
        'b g',
        'peak bar top',
        'fast ta ema close',
        'safe nz fast',
        'sym syminfo tickerid',
      ].join(' '),
    );
  });

  test('a local has one fact, shared by its definition and its uses', () => {
    const def = at(7, 1, 'bar');
    const use = at(10, 8, 'bar');
    expect(def.facts).toEqual([
      {info: analysis.checked.info, object: def.facts[0].object},
    ]);
    expect(def.facts[0].object.kind).toBe(ObjectKind.Variable);
    expect(use.facts[0].object).toBe(def.facts[0].object);
  });

  test('a parameter has one fact per called signature', () => {
    const g = at(3, 1, 'g').facts[0].object;
    const instances =
      (g.kind === ObjectKind.Function && analysis.checked.instances.get(g)) ||
      [];
    for (const name of [at(3, 3, 'x'), at(4, 9, 'x'), at(4, 5, 'y')]) {
      expect(name.facts.map(fact => fact.info)).toEqual(
        instances.map(instance => instance.info),
      );
    }
    expect(
      at(3, 3, 'x').facts.map(
        ({object}) => object.kind === ObjectKind.Variable && object.type.kind,
      ),
    ).toEqual([TypeKind.Float, TypeKind.Int]);
  });

  test('a function that is never called has no facts inside', () => {
    expect(at(6, 1, 'unused').facts.length).toBe(1);
    expect(at(6, 8, 'z').facts).toEqual([]);
    expect(at(6, 14, 'z').facts).toEqual([]);
  });

  test('a field selection is indexed under the selected name', () => {
    const field = at(2, 11, 'top').facts[0].object;
    expect(field.kind).toBe(ObjectKind.Field);
    expect(at(10, 12, 'top').facts.map(fact => fact.object)).toEqual([field]);
  });

  test('a builtin selection is indexed under the selected name', () => {
    expect(at(13, 7, 'syminfo').facts).toEqual([]);
    expect(at(13, 15, 'tickerid').facts.map(fact => fact.object)).toEqual([
      expect.objectContaining({
        kind: ObjectKind.Builtin,
        name: 'syminfo.tickerid',
      }),
    ]);
  });

  test('a ta.* call resolves into the library file', () => {
    expect(at(11, 8, 'ta').facts[0].object.kind).toBe(ObjectKind.PackageName);
    const ema = at(11, 11, 'ema').facts[0].object;
    expect(ema.kind === ObjectKind.Function && ema.decl.name.pos).toMatchObject(
      {base: {filename: 'tea-lib/ta.tea'}},
    );
  });

  test('a native callee has no Object; its call resolution is in Info.calls', () => {
    const nz = at(12, 8, 'nz');
    expect(nz.facts).toEqual([]);
    const resolutions = [...analysis.checked.info.calls]
      .filter(([call]) => call.fun === nz.name)
      .map(([, resolution]) => resolution);
    expect(resolutions).toEqual([
      expect.objectContaining({
        kind: CallKind.Native,
        native: expect.objectContaining({name: 'nz'}),
      }),
    ]);
  });
});
