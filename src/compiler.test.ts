// Purpose: Pipeline driver tests — the compiling entry stops at a failed parse; the tooling entry checks past it and keeps every stage's result.

import {describe, expect, test} from 'vitest';
import {Errors} from './base/print';
import {compileForTooling, compileToProgram} from './compiler';

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
