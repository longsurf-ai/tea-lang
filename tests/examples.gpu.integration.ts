// Purpose: Keep canonical struct-heavy strategies fail-closed at the WGSL
// boundary until reference-struct storage has a dedicated GPU lowering.

import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';
import {Errors} from '../src/base/print';
import {compileProgramToWgsl} from '../src/codegen/wgsl';
import {compileToProgram} from '../src/compile';
import type {Program} from '../src/ir/program';

const SOURCE = join(process.cwd(), 'examples/strategy/ema-cross/strategy.tea');
const TURTLE_SOURCE = join(
  process.cwd(),
  'examples/strategy/turtle-system/strategy.tea',
);

test('canonical EMA strategy fails closed before GPU binding', () => {
  assertStructReferenceDeferred(compileProgram(SOURCE));
});

test('canonical Turtle strategy fails closed before GPU binding', () => {
  assertStructReferenceDeferred(compileProgram(TURTLE_SOURCE));
});

function compileProgram(source: string): Program {
  const errors = new Errors();
  const program = compileToProgram([source], errors);
  assert.ok(program, formatErrors(errors));
  assert.equal(errors.count, 0);
  return program;
}

function assertStructReferenceDeferred(program: Program): void {
  const result = compileProgramToWgsl(program);
  assert.equal(result.status, 'staged-unsupported');
  if (result.status !== 'staged-unsupported') {
    throw new Error('struct-heavy strategy unexpectedly reached GPU binding');
  }
  assert.equal(result.artifact, null);
  assert.equal(result.eligibility.eligible, false);
  assert.deepEqual(result.eligibility.issues[0], {
    code: 'struct-reference-lowering-unimplemented',
    phase: 'wgsl-emission',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
    occurrences: 1,
    firstLocation: null,
  });
}

function formatErrors(errors: Errors): string {
  return errors
    .flushErrors()
    .map(error => error.msg)
    .join('; ');
}
