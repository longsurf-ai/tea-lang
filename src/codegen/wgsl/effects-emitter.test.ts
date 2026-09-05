// Purpose: Lock chunked WGSL emission to generic Program facts: persistent
// execution state, absolute rows, ordinary function effects, and fixed payloads.

import {describe, expect, test} from 'vitest';
import {newFileBase} from '../../base/pos';
import {Errors} from '../../base/print';
import {checkPackage} from '../../checker/check';
import {resolveImports, defaultRegistry} from '../../loader/loader';
import {buildProgram} from '../../noder/noder';
import {mustBuild} from '../../noder/testing';
import {parse} from '../../syntax/syntax';
import {compileProgramToWgsl} from './lower';

function compile(source: string): string {
  const result = compileProgramToWgsl(mustBuild(source));
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact.module.source;
}

function compileWithCounter(source: string): string {
  const errors = new Errors();
  const file = parse(newFileBase('main.tea'), source, (pos, msg) =>
    errors.errorAt(pos, msg),
  );
  const importer = resolveImports([file], path => {
    if (path === 'counter') {
      return {
        filename: 'tea-lib/counter.tea',
        source: [
          'library("counter")',
          'var int total = 0',
          'export next(int value) =>',
          '    total := total + value',
          '    total',
        ].join('\n'),
      };
    }
    return defaultRegistry(path);
  });
  const checked = checkPackage([file], errors, importer);
  const program = buildProgram(checked, errors);
  if (errors.count > 0) {
    throw new Error(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  const result = compileProgramToWgsl(program);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact.module.source;
}

describe('chunked sparse-effect WGSL emitter', () => {
  test('accepts an effects-only stateless Program', () => {
    const source = compile(
      ['strategy("effects only")', 'effect.emit(close)'].join('\n'),
    );
    expect(source).toContain(
      'var<storage, read_write> tea_execution_states: array<u32>',
    );
    expect(source).toContain('TeaEffectRecord(tea_row, 1u');
    expect(source).toContain('effect_capacity > 0u');
    expect(source).toContain('if (tea_job.result_count != 0u)');
  });

  test('keeps declaration-only bind arguments outside the GPU subset', () => {
    const result = compileProgramToWgsl(
      mustBuild(
        ['level = input.float(1)', 'hline(level)', 'plot(close)'].join('\n'),
      ),
    );
    expect(result.status).toBe('staged-unsupported');
    expect(result.eligibility.issues[0]?.code).toBe(
      'result-transport-lowering-unimplemented',
    );
  });

  test('keeps an initialized absolute cursor in external execution state', () => {
    const source = compile(
      [
        'strategy("cursor")',
        'var int seen = 0',
        'seen := bar_index',
        'plot(close + (barstate.islast ? seen : -1))',
      ].join('\n'),
    );

    expect(source).toContain('let tea_execution_base: u32');
    expect(source).toContain('let tea_start_row = tea_state_load(');
    expect(source).toContain('tea_start_row + tea_chunk_row');
    expect(source).toContain('tea_start_row + tea_chunk_count');
    expect(source).toContain('tea_row + 1u == tea_job.row_count');
    expect(source).toContain('select(tea_chunk_row, 0u');
    expect(source).toContain('tea_job.result_offset +');
  });

  test('fails closed for struct effects reached through a UDF', () => {
    const result = compileProgramToWgsl(
      mustBuild(
        [
          'strategy("effects")',
          'type Event',
          '    string id',
          '    int row',
          'emitTwo(int row) =>',
          '    effect.emit(Event.new("first", row))',
          '    effect.emit(Event.new("second", row))',
          '    row',
          'var int last = 0',
          'last := emitTwo(bar_index)',
          'plot(close + last)',
        ].join('\n'),
      ),
    );
    expect(result.status).toBe('staged-unsupported');
    expect(result.eligibility.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );
  });

  test('uses literal ids for string equality and fails closed for concatenation', () => {
    const equality = compile(
      [
        'strategy("string ids")',
        'same(string value) =>',
        '    value == "same"',
        'var int keep = 0',
        'keep := same("same") ? 1 : 0',
        'plot(close + keep)',
      ].join('\n'),
    );
    expect(
      equality.match(/TeaString\(1u, 0u\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);

    const dynamic = compileProgramToWgsl(
      mustBuild(
        [
          'strategy("dynamic string")',
          'type Event',
          '    string id',
          'emitValue(string value) =>',
          '    effect.emit(Event.new(value + "b"))',
          '    0',
          'var int keep = 0',
          'keep := emitValue("a")',
          'plot(close + keep)',
        ].join('\n'),
      ),
    );
    expect(dynamic.status).toBe('staged-unsupported');
    expect(dynamic.eligibility.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );
  });

  test('emits package globals through the same external execution state', () => {
    const source = compileWithCounter(
      [
        'strategy("package global")',
        'import counter',
        'value = counter.next(bar_index)',
        'plot(close + value)',
      ].join('\n'),
    );

    expect(source).toContain('tea_root_base: u32');
    expect(source).toMatch(/tea_state_(?:load|store)\(tea_root_base \+ \d+u/);
  });
});
