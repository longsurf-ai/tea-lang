// Purpose: Pipeline driver tests — the compiling entry stops at a failed parse; the tooling entry checks past it and keeps every stage's result.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Schema} from 'apache-arrow';
import {describe, expect, test} from 'vitest';
import {formatPos} from './base/pos';
import {Errors} from './base/print';
import {compile, compileForTooling, compileToProgram} from './compiler';
import {executeTestProgram, finiteStream} from './testing/batch';
import {OutputCapture} from './testing/output';

function lines(errors: Errors): string[] {
  return errors.flushErrors().map(error => `${error.pos.line}: ${error.msg}`);
}

const PARSE_ERROR = "1: expected expression, found 'newline'";
const TYPE_ERROR =
  "2: operator '+' requires numeric operands (got float and string)";
const broken = [{filename: 'broken.tea', source: 'x = 1 +\ny = close + "a"\n'}];

describe('checking past parse errors', () => {
  test('compileToProgram stops at the parse barrier', () => {
    const errors = new Errors();
    expect(compileToProgram(broken, errors)).toBeNull();
    expect(lines(errors)).toEqual([PARSE_ERROR]);
  });

  test('compileForTooling reports the parse error and the type error', () => {
    const errors = new Errors();
    const {files, checked, program} = compileForTooling(broken, errors);
    expect(lines(errors)).toEqual([PARSE_ERROR, TYPE_ERROR]);
    expect(program).toBeNull();
    expect(checked.pkg.files).toEqual(files);
    // Facts exist on both sides of the broken line.
    expect(checked.pkg.scope.has('x')).toBe(true);
    expect(checked.pkg.scope.has('y')).toBe(true);
  });

  test('on clean source both entries node the same Program', () => {
    const clean = [{filename: 'clean.tea', source: 'plot("c", close)\n'}];
    const errors = new Errors();
    const {program} = compileForTooling(clean, errors);
    expect(lines(errors)).toEqual([]);
    expect(program).not.toBeNull();
    expect(program).toEqual(compileToProgram(clean, new Errors()));
  });
});

describe('relative imports', () => {
  const IMPORTS = join(
    fileURLToPath(new URL('.', import.meta.url)),
    '../tests/fixtures/imports',
  );
  const entry = join(IMPORTS, 'strategies/entry.tea');
  const located = (errors: Errors): string[] =>
    errors.flushErrors().map(error => `${formatPos(error.pos)}: ${error.msg}`);

  test('tooling dependencies come from resolution, including failed and cyclic imports', () => {
    expect(
      [...compileForTooling([entry], new Errors()).dependencies].sort(),
    ).toEqual(
      [
        entry,
        join(IMPORTS, 'strategies/lib/bands.tea'),
        join(IMPORTS, 'shared/risk.tea'),
      ].sort(),
    );
    const missing = join(IMPORTS, 'missing/entry.tea');
    expect(compileForTooling([missing], new Errors()).dependencies).toEqual([
      missing,
      join(IMPORTS, 'missing/nope.tea'),
    ]);
    const cycle = join(IMPORTS, 'cycle/entry.tea');
    expect(
      [...compileForTooling([cycle], new Errors()).dependencies].sort(),
    ).toEqual(
      [
        cycle,
        join(IMPORTS, 'cycle/a.tea'),
        join(IMPORTS, 'cycle/b.tea'),
      ].sort(),
    );
  });

  test('a script runs with its own library files, reached by two spellings', async () => {
    const errors = new Errors();
    const program = compileToProgram([entry], errors);
    expect(located(errors)).toEqual([]);
    const sink = new OutputCapture();
    await executeTestProgram(program!, {
      stream: finiteStream(new Schema([]), [{}]),
      sink,
      timeNow: 0,
    });
    // upper = cap(10 + 2, 100); capped = cap(upper, 11).
    expect(sink.publications[0]).toMatchObject({upper: 12, capped: 11});
    // The generated TypeScript of the whole closure typechecks.
    expect(compile([entry]).ok).toBe(true);
  });

  test('resolution errors sit on the import statement', () => {
    const missing = join(IMPORTS, 'missing/entry.tea');
    const errors = new Errors();
    expect(compileToProgram([missing], errors)).toBeNull();
    expect(located(errors)).toEqual([
      `${missing}:1:8: cannot find './nope' (no file ${join(IMPORTS, 'missing/nope.tea')})`,
    ]);

    const cycle = join(IMPORTS, 'cycle/entry.tea');
    const cycleErrors = new Errors();
    expect(compileToProgram([cycle], cycleErrors)).toBeNull();
    const [message] = located(cycleErrors);
    expect(message.startsWith(`${cycle}:1:8: in library '`)).toBe(true);
    expect(message).toContain('import cycle: ');
  });

  test('complete sources supply relative imports without filesystem fallback', async () => {
    const root = '/snapshot';
    const files = new Map([
      [
        `${root}/lib/bands.tea`,
        'library("bands")\nimport ../shared/risk\nexport upper(source, k) =>\n    risk.cap(source + k, 100.0)\n',
      ],
      [
        `${root}/shared/risk.tea`,
        'library("risk")\nexport cap(value, limit) =>\n    math.min(value, limit)\n',
      ],
    ]);
    const sources = Object.fromEntries(files);
    const source =
      'import ./lib/bands\nimport ./shared/risk as limits\nemit "capped" limits.cap(bands.upper(10.0, 2.0), 11.0)\n';
    const errors = new Errors();
    const program = compileToProgram(
      [{filename: `${root}/entry.tea`, source, imports: sources}],
      errors,
    );
    expect(located(errors)).toEqual([]);

    const sink = new OutputCapture();
    await executeTestProgram(program!, {
      stream: finiteStream(new Schema([]), [{}]),
      sink,
      timeNow: 0,
    });
    expect(sink.publications[0]).toMatchObject({capped: 11});

    const missing = new Errors();
    expect(
      compileToProgram(
        [
          {
            filename: `${root}/entry.tea`,
            source: 'import ./nope\n',
            imports: sources,
          },
        ],
        missing,
      ),
    ).toBeNull();
    expect(located(missing)).toEqual([
      `${root}/entry.tea:1:8: cannot find './nope' (no file ${root}/nope.tea)`,
    ]);
  });

  test('optionally returns the exact source snapshot without changing ordinary results', () => {
    const errors = new Errors();
    const captured = compileToProgram([entry], errors, {includeSources: true});
    expect(located(errors)).toEqual([]);
    expect(Object.keys(captured!.sources).sort()).toEqual(
      [
        entry,
        join(IMPORTS, 'strategies/lib/bands.tea'),
        join(IMPORTS, 'shared/risk.tea'),
      ].sort(),
    );
    const program = compileToProgram(
      [
        {
          filename: entry,
          source: captured!.sources[entry]!,
          imports: captured!.sources,
        },
      ],
      new Errors(),
    );
    expect(program).not.toBeNull();
    expect(program).not.toHaveProperty('program');
  });

  test('an explicit import map never falls back to existing disk files', () => {
    const errors = new Errors();
    expect(
      compileToProgram(
        [
          {
            filename: entry,
            source: readFileSync(entry, 'utf8'),
            imports: {},
          },
        ],
        errors,
      ),
    ).toBeNull();
    expect(located(errors).join('\n')).toContain("cannot find './lib/bands'");
  });

  test('an imported file must be a library', () => {
    const errors = new Errors();
    expect(
      compileToProgram([join(IMPORTS, 'notlib/entry.tea')], errors),
    ).toBeNull();
    const plain = join(IMPORTS, 'notlib/plain.tea');
    expect(located(errors)).toEqual([
      `${plain}:1:1: library '${plain}' has no library() declaration`,
    ]);
  });
});
