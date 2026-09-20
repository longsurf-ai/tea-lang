// Purpose: Pipeline driver tests — the compiling entry stops at a failed parse; the tooling entry checks past it and keeps every stage's result.

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
