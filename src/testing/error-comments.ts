// Purpose: Shared ERROR-comment DSL — fixtures declare expected diagnostics in place; each compiler pass's test suite matches reported and declared errors both ways.
//
// Two forms:
//   // ERROR <regex>       — an error must be reported on this line
//   /* ERROR <regex> */    — an error must be reported at the position of the
//                            next non-space character after the comment

import type {Pos} from '../base/pos';

export interface Expectation {
  readonly line: number;
  readonly col: number | null; // null = line form, any column matches
  readonly rx: RegExp;
}

export interface ReportedError {
  readonly pos: Pos;
  readonly msg: string;
}

export function collectExpectations(src: string): Expectation[] {
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

export function matches(
  expectation: Expectation,
  error: ReportedError,
): boolean {
  return (
    error.pos.line === expectation.line &&
    (expectation.col === null || error.pos.col === expectation.col) &&
    expectation.rx.test(error.msg)
  );
}

// The two-way diff a suite asserts to be empty: every expectation matched by
// some error, every error matched by some expectation.
export function diffExpectations(
  name: string,
  expectations: readonly Expectation[],
  errors: readonly ReportedError[],
): {missing: string[]; unexpected: string[]} {
  const missing = expectations
    .filter(expectation => !errors.some(error => matches(expectation, error)))
    .map(e => `${name}:${e.line}: missing ${e.rx}`);
  const unexpected = errors
    .filter(error => !expectations.some(expectation => matches(expectation, error)))
    .map(e => `${name}:${e.pos.line}:${e.pos.col}: unexpected "${e.msg}"`);
  return {missing, unexpected};
}
