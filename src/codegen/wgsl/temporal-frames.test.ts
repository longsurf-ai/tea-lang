// Purpose: Acceptance boundary for generic call-site frames and bind-sized history in WGSL.

import {describe, expect, test} from 'vitest';
import {DepthKind} from '../../ir/node';
import {mustBuild} from '../../noder/testing';
import {compileProgramToWgsl} from './lower';
import type {CompiledWgslProgram} from './types';

function compile(source: string) {
  const result = compileProgramToWgsl(mustBuild(source));
  expect(result.status).toBe('compiled');
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact;
}

function emittedFunction(artifact: CompiledWgslProgram, owner: string): string {
  const frame = artifact.state.frames.find(
    candidate => candidate.owner === owner,
  );
  if (frame === undefined || frame.id === 0) {
    throw new Error(`missing WGSL function frame '${owner}'`);
  }
  const start = artifact.module.source.indexOf(`fn tea_fn_${frame.id - 1}(`);
  if (start < 0) throw new Error(`missing WGSL function '${owner}'`);
  const nextFunction = artifact.module.source.indexOf(
    '\nfn tea_fn_',
    start + 1,
  );
  const kernel = artifact.module.source.indexOf('\nfn tea_execute', start + 1);
  return artifact.module.source.slice(
    start,
    nextFunction < 0 ? kernel : nextFunction,
  );
}

describe('WGSL temporal call-site frames', () => {
  test('lowers canonical ta.ema and cross functions as ordinary Tea functions', () => {
    const artifact = compile(
      [
        '',
        'fast = ta.ema(close, 3)',
        'slow = ta.ema(close, 5)',
        'longSignal = ta.crossover(fast, slow)',
        'closeSignal = ta.crossunder(fast, slow)',
        'emit "output0" fast',
        'emit "output1" slow',
        'emit "output2" longSignal',
        'emit "output3" closeSignal',
      ].join('\n'),
    );

    expect(artifact.module.source).not.toContain('ta.ema');
    expect(artifact.module.source).not.toContain('crossover');
    expect(artifact.module.source).not.toContain('crossunder');
    expect(artifact.state.fixedWordCount * 4).toBe(
      artifact.executionStateFixedByteSize,
    );
    expect(
      artifact.state.frames
        .find(frame => frame.owner === 'ta.ema')
        ?.locals.map(local => local.name),
    ).toEqual(['alpha', 'e']);
    expect(emittedFunction(artifact, 'ta.ema')).toContain(
      'var tea_arg_0: TeaFloat = p0;',
    );
  });

  test('one function body serves independent written call-site frames', () => {
    const artifact = compile(
      [
        '',
        'accumulate(float source) =>',
        '    var float total = 0.0',
        '    total := total + source',
        '    total',
        'left = accumulate(close)',
        'right = accumulate(open)',
        'emit "output0" left',
        'emit "output1" right',
      ].join('\n'),
    );

    expect(artifact.module.source.match(/fn tea_fn_0\(/g)).toHaveLength(1);
  });

  test('supports constant history on a function parameter', () => {
    const artifact = compile(
      [
        '',
        'previous(float source) => source[1]',
        'emit "output0" previous(close)',
      ].join('\n'),
    );

    const frame = artifact.state.frames.find(
      candidate => candidate.owner === 'previous',
    );
    expect(frame?.locals.map(local => local.name)).toEqual(['source']);
    expect(frame?.locals[0]?.historyDescriptorWordOffset).not.toBeNull();
    expect(emittedFunction(artifact, 'previous')).not.toContain(
      'var tea_arg_0',
    );
  });

  test('fails closed for const methods on struct references', () => {
    const result = compileProgramToWgsl(
      mustBuild(
        [
          '',
          'type Sample',
          '    float value',
          '    float add(float other) const =>',
          '        this.value + other',
          'sample = Sample.new(close)',
          'emit "output0" sample.add(1.0)',
        ].join('\n'),
      ),
    );
    expect(result.status).toBe('staged-unsupported');
    expect(result.eligibility.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );
  });

  test('fails closed for mutable methods on struct references', () => {
    const result = compileProgramToWgsl(
      mustBuild(
        [
          '',
          'type Pair',
          '    float left',
          '    float right',
          '    float touch(float value) =>',
          '        this.right := this.right + 1.0',
          '        value',
          'var Pair pair = Pair.new(0.0, 0.0)',
          'pair.left := pair.touch(close)',
          'emit "output0" pair.left',
          'emit "output1" pair.right',
        ].join('\n'),
      ),
    );
    expect(result.status).toBe('staged-unsupported');
    expect(result.eligibility.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );
  });

  test('supports first-late activation and skipped active frames', () => {
    compile(
      [
        '',
        'previous(float source) => source[1]',
        'float value = na',
        'if bar_index >= 2 and bar_index != 3',
        '    value := previous(close)',
        'emit "output0" value',
      ].join('\n'),
    );
  });

  test('fails closed for wide nested struct state', () => {
    const result = compileProgramToWgsl(
      mustBuild(
        [
          '',
          'type Quad',
          '    float a',
          '    float b',
          '    float c',
          '    float d',
          'type Wide',
          '    Quad left',
          '    Quad right',
          'var Wide state = Wide.new(Quad.new(close, open, high, low), Quad.new(open, high, low, close))',
          'emit "output0" state.left.a',
        ].join('\n'),
      ),
    );
    expect(result.status).toBe('staged-unsupported');
    expect(result.eligibility.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );
  });

  test('returns typed empty for invalid and unreachable constant offsets', () => {
    const artifact = compile(
      ['', 'emit "output0" close[-1]', 'emit "output1" close[4294967296]'].join(
        '\n',
      ),
    );
    expect(artifact.module.source).not.toContain('4294967296u');
  });

  test('does not allocate frame history for a target-invalid name offset', () => {
    const artifact = compile(
      ['', 'flag = close > open', 'emit "output0" flag[2147483648]'].join('\n'),
    );
    const flag = artifact.state.frames
      .flatMap(frame => frame.locals)
      .find(local => local.name === 'flag');
    expect(flag?.historyDescriptorWordOffset).toBeNull();
    expect(artifact.module.source).not.toContain('2147483648u');
  });

  test('keeps execution state metadata compact', () => {
    const artifact = compile(
      ['', 'flag = close > open', 'emit "output0" flag[10000]'].join('\n'),
    );
    const layout = artifact.layouts[artifact.executionStateLayout];
    expect(layout?.byteSize).toBeLessThan(100);
    expect(layout?.fields.map(field => field.path)).toEqual([
      'initialized',
      'next_row',
    ]);
  });

  test('ignores target-invalid depth annotations with no valid read site', () => {
    const program = mustBuild(
      [
        '',
        'var float value = close',
        'value := close',
        'emit "output0" value',
      ].join('\n'),
    );
    const root = program.body.find(stmt => stmt.kind === 'InitName');
    if (root?.kind !== 'InitName') throw new Error('expected root name');
    root.name.depth = {kind: DepthKind.Const, bars: 0x1_0000_0000};
    const result = compileProgramToWgsl(program);
    expect(result.status).toBe('compiled');
  });

  test('keeps large valid history out of the bind-independent fixed layout', () => {
    const result = compileProgramToWgsl(
      mustBuild(
        ['', 'flag = close > open', 'emit "output0" flag[1500000000]'].join(
          '\n',
        ),
      ),
    );
    expect(result.status).toBe('compiled');
    if (result.status === 'compiled') {
      expect(result.artifact.executionStateFixedByteSize).toBeLessThan(100);
    }
  });
});
