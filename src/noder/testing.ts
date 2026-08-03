// Purpose: Test helpers for the noder package — parse, check, and node a source string through the same barriers compile() enforces.

import {Errors, fatal, type ErrorMsg} from '../base/print';
import {newFileBase} from '../base/pos';
import type {Program} from '../ir/program';
import {parse} from '../syntax/syntax';
import {check} from '../typecheck/check';
import {buildProgram} from './noder';

export interface BuildResult {
  readonly program: Program | null;
  readonly errors: readonly ErrorMsg[];
}

// Mirrors compile()'s barriers: a parse or check failure yields no Program.
export function buildText(src: string, filename = 'test.tea'): BuildResult {
  const errors = new Errors();
  const file = parse(newFileBase(filename), src, (pos, msg) =>
    errors.errorAt(pos, msg),
  );
  if (errors.count > 0) {
    return {program: null, errors: errors.flushErrors()};
  }
  const info = check(file, errors);
  if (errors.count > 0) {
    return {program: null, errors: errors.flushErrors()};
  }
  const program = buildProgram(file, info, errors);
  if (errors.count > 0) {
    return {program: null, errors: errors.flushErrors()};
  }
  return {program, errors: []};
}

// For fixtures that must node cleanly.
export function mustBuild(src: string): Program {
  const {program, errors} = buildText(src);
  if (program === null) {
    return fatal(
      `fixture failed to build: ${errors.map(e => `${e.pos.line}: ${e.msg}`).join('; ')}`,
    );
  }
  return program;
}
