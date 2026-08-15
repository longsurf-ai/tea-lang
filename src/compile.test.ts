// Purpose: Pipeline-entry tests for the single generic Program compilation
// path shared by IR inspection and target lowering.

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Errors} from './base/print';
import {compile, compileToProgram, hashProgramSourceClosure} from './compile';
import {loadModule} from './runtime/load';

const TESTDATA = join(import.meta.dir, '../tests/fixtures');
const STRATEGY_SOURCE = join(
  TESTDATA,
  'execution',
  'compile',
  'strategy-components',
  'source.tea',
);

describe('generic compilation pipeline', () => {
  test('source identity is stable across paths and changes with exact entry bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tea-source-closure-'));
    const first = join(directory, 'first.tea');
    const second = join(directory, 'second.tea');
    try {
      writeFileSync(first, 'indicator("same")\nvalue = close\n');
      writeFileSync(second, 'indicator("same")\nvalue = close\n');

      const expected = hashProgramSourceClosure([first]);
      expect(hashProgramSourceClosure([first])).toBe(expected);
      expect(hashProgramSourceClosure([second])).toBe(expected);

      writeFileSync(second, 'indicator("changed")\nvalue = close\n');
      expect(hashProgramSourceClosure([second])).not.toBe(expected);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('compiles strategy source and its imports directly to the canonical Program', () => {
    const errors = new Errors();
    const program = compileToProgram([STRATEGY_SOURCE], errors);

    expect(errors.count).toBe(0);
    expect(program?.outputs[0]?.effect).toBe('strategy');
    expect(program?.outputs[0]?.staticArgs).toEqual([
      {name: 'title', value: 'Tea strategy components'},
    ]);
    expect(program?.outputs).toHaveLength(10);
  });

  test('lowers the same strategy Program through the ordinary JS target', () => {
    const errors = new Errors();
    const program = compileToProgram([STRATEGY_SOURCE], errors);
    if (program === null) {
      throw new Error(
        errors
          .flushErrors()
          .map(error => error.msg)
          .join('; '),
      );
    }
    const result = compile([STRATEGY_SOURCE]);
    if (!result.ok) {
      throw new Error(result.errors.map(error => error.msg).join('; '));
    }
    const module = loadModule(result.js);

    expect(errors.count).toBe(0);
    expect(module.manifest.outputs.map(output => output.effect)).toEqual(
      program.outputs.map(output => output.effect),
    );
  });

  test('accepts non-strategy Programs through the same compiler entry', () => {
    const result = compile([join(TESTDATA, 'ir', 'basic.tea')]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(loadModule(result.js).manifest.outputs[0]?.effect).toBe(
        'indicator',
      );
    }
  });

  test('applies identical frontend phase barriers to IR and full compilation', () => {
    const filename = join(TESTDATA, 'errors.tea');
    const irErrors = new Errors();
    const program = compileToProgram([filename], irErrors);
    const result = compile([filename]);
    const irErrorBatch = irErrors.flushErrors();

    expect(program).toBeNull();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(irErrorBatch);
    }
    expect(irErrorBatch.map(error => error.msg)).toContain(
      'string literal not terminated',
    );
  });
});
