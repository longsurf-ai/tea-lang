// Purpose: Lock chunked WGSL emission to generic Program facts: persistent
// lane state, absolute rows, ordinary function effects, and fixed payloads.

import {describe, expect, test} from 'bun:test';
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
        filename: 'lib/counter.tea',
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
    throw new Error(errors.flushErrors().map(error => error.msg).join('; '));
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
    expect(source).toContain('struct TeaLaneState {');
    expect(source).toContain('TeaEffectRecord(tea_row, 0u');
    expect(source).toContain('if (tea_job.result_count != 0u)');
  });

  test('keeps an initialized absolute cursor in external lane state', () => {
    const source = compile(
      [
        'strategy("cursor")',
        'var int seen = 0',
        'seen := bar_index',
        'plot(close + (barstate.islast ? seen : -1))',
      ].join('\n'),
    );

    expect(source).toContain('initialized: u32');
    expect(source).toContain('next_row: u32');
    expect(source).toContain('tea_start_row + tea_chunk_row');
    expect(source).toContain('tea_start_row + tea_chunk_count');
    expect(source).toContain('tea_row + 1u == tea_job.row_count');
    expect(source).toContain(
      'tea_job.result_offset + tea_chunk_row * 1u',
    );
  });

  test('threads lane state through a UDF and appends two ordered effects', () => {
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
    if (result.status !== 'compiled') {
      throw new Error(JSON.stringify(result.eligibility.issues));
    }
    const {source} = result.artifact.module;

    expect(source).toContain(
      'tea_state: ptr<storage, TeaLaneState, read_write>',
    );
    expect(source).toContain('tea_effect_status[tea_lane].count');
    const first = source.indexOf('TeaEffectRecord(tea_row, 0u');
    const second = source.indexOf('TeaEffectRecord(tea_row, 1u');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(source).toContain('TeaString(1u, 0u)');
    expect(source).toContain('TeaString(1u, 1u)');
    expect(result.artifact.literalStrings).toEqual(['first', 'second']);
    expect(result.artifact.maxEffectsPerRow).toBe(2);
    expect(result.artifact.effectSchemas.map(schema => schema.effectId)).toEqual([
      0,
      1,
    ]);
    expect(result.artifact.externalBuffers).toMatchObject({
      laneStatesBinding: 2,
      resultsBinding: 3,
      effectStatusBinding: 4,
      effectRecordsBinding: 5,
    });
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
    expect(equality.match(/TeaString\(1u, 0u\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

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
    expect(dynamic.eligibility.issues[0]?.message).toContain(
      'dynamic GPU strings are unsupported',
    );
  });

  test('emits package globals through the same external lane state', () => {
    const source = compileWithCounter(
      [
        'strategy("package global")',
        'import counter',
        'value = counter.next(bar_index)',
        'plot(close + value)',
      ].join('\n'),
    );

    expect(source).toContain('ptr<storage, TeaLaneState, read_write>');
    expect(source).toMatch(/\(\*tea_state\)\.r\d/);
  });
});
