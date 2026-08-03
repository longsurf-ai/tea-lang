// Purpose: ERROR-comment regression harness — testdata files declare expected diagnostics in place; reported and declared errors must match both ways.
//
// Two forms, checked against the scanner's raw reports:
//   // ERROR <regex>       — an error must be reported on this line
//   /* ERROR <regex> */    — an error must be reported at the position of the
//                            next non-space character after the comment

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {parseText, type ScanError} from './testing';

const TESTDATA = join(import.meta.dir, '../../testdata');

interface Expectation {
  readonly line: number;
  readonly col: number | null; // null = line form, any column matches
  readonly rx: RegExp;
}

function collectExpectations(src: string): Expectation[] {
  const expectations: Expectation[] = [];
  const lines = src.split('\n');

  lines.forEach((text, index) => {
    const lineForm = /\/\/ ERROR (.+)$/.exec(text);
    if (lineForm !== null) {
      expectations.push({
        line: index + 1,
        col: null,
        rx: new RegExp(lineForm[1].trim()),
      });
    }
    const blockForm = /\/\* ERROR (.+?) \*\//g;
    for (;;) {
      const match = blockForm.exec(text);
      if (match === null) {
        break;
      }
      let col = match.index + match[0].length + 1;
      while (text[col - 1] === ' ') {
        col += 1;
      }
      expectations.push({
        line: index + 1,
        col,
        rx: new RegExp(match[1].trim()),
      });
    }
  });
  return expectations;
}

function matches(expectation: Expectation, error: ScanError): boolean {
  return (
    error.pos.line === expectation.line &&
    (expectation.col === null || error.pos.col === expectation.col) &&
    expectation.rx.test(error.msg)
  );
}

describe('testdata error comments', () => {
  const files = readdirSync(TESTDATA).filter(name => name.endsWith('.tea'));
  expect(files.length).toBeGreaterThan(0);

  for (const name of files) {
    test(name, () => {
      const src = readFileSync(join(TESTDATA, name), 'utf8');
      const expectations = collectExpectations(src);
      const {errors} = parseText(src, name);

      const unmatchedExpectations = expectations.filter(
        expectation => !errors.some(error => matches(expectation, error)),
      );
      const unexpectedErrors = errors.filter(
        error => !expectations.some(expectation => matches(expectation, error)),
      );

      expect(
        unmatchedExpectations.map(e => `${name}:${e.line}: missing ${e.rx}`),
      ).toEqual([]);
      expect(
        unexpectedErrors.map(
          e => `${name}:${e.pos.line}:${e.pos.col}: unexpected "${e.msg}"`,
        ),
      ).toEqual([]);
    });
  }
});
