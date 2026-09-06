// Purpose: Lock deterministic literal-string interning to the reachable WGSL Program graph.

import {describe, expect, test} from 'vitest';
import {IrKind} from '../../ir/node';
import type {Program} from '../../ir/program';
import {namesOf} from '../../ir/visit';
import {mustBuild} from '../../noder/testing';
import {
  WgslEffectAnalysisError,
  analyzeWgslEffects,
  collectLiteralStrings,
} from './effects-analysis';
import {compileProgramToWgsl} from './lower';

describe('WGSL effect artifact analysis', () => {
  test('collects strategy command ids in deterministic first-encounter order', () => {
    const program = mustBuild(
      [
        '',
        'var float keep = 0.0',
        'choose(bool second) => second ? "Close" : "Long"',
        'id = choose(bar_index > 0)',
        'emit.append "effect0" id',
        'emit.append "effect1" "Long"',
        'emit "output0" close + keep',
      ].join('\n'),
    );

    expect(collectLiteralStrings(program)).toEqual(['Close', 'Long']);
  });

  test('enters nested reachable UDFs once and ignores declaration metadata', () => {
    const program = mustBuild(
      [
        '',
        'var float keep = 0.0',
        'inner() => "nested"',
        'outer() => inner()',
        'emit.append "effect0" outer()',
        'emit.append "effect1" "root"',
        'emit "output0" close + keep',
      ].join('\n'),
    );

    expect(collectLiteralStrings(program)).toEqual(['nested', 'root']);
  });

  test('includes discarded calls and loop roots in effects and literal strings', () => {
    const program = mustBuild(
      [
        'publish(string value) =>',
        '    emit.append "events" value',
        '    return value',
        'publish("before")',
        'for i = 0 to 2',
        '    publish("inside")',
        'publish("after")',
        'emit "close" close',
      ].join('\n'),
    );

    expect(analyzeWgslEffects(program)).toEqual({
      maxEffectsPerRow: 5,
      literalStrings: ['before', 'inside', 'after'],
    });
    const result = compileProgramToWgsl(program);
    if (result.status !== 'compiled') {
      throw new Error(JSON.stringify(result.eligibility.issues));
    }
    expect(result.artifact.module.source.match(/= tea_fn_\d+\(/g)).toHaveLength(
      3,
    );
    expect(result.artifact.module.source).toMatch(/for \(var range_index\d+:/);
  });

  test('takes one lazy conditional arm plus sequential function calls', () => {
    const program = mustBuild(
      [
        '',
        'emitOne(int value) =>',
        '    emit.append "effect0" value',
        '    value',
        'var int keep = 0',
        'keep := true ? emitOne(1) : emitOne(2)',
        'keep := emitOne(3)',
        'emit "output0" close + keep',
      ].join('\n'),
    );

    expect(analyzeWgslEffects(program).maxEffectsPerRow).toBe(2);
  });

  test('takes the maximum lazy IfExpr arm rather than their sum', () => {
    const program = mustBuild(
      [
        '',
        'choose(bool condition) =>',
        '    if condition',
        '        emit.append "effect0" 1',
        '        1',
        '    else',
        '        emit.append "effect1" 2',
        '        emit.append "effect2" 3',
        '        2',
        'var int keep = 0',
        'keep := choose(bar_index > 0)',
        'emit "output0" close + keep',
      ].join('\n'),
    );

    expect(analyzeWgslEffects(program).maxEffectsPerRow).toBe(2);
  });

  test('multiplies a compile-time bounded loop and rejects an unknown bound', () => {
    const bounded = mustBuild(
      [
        '',
        'var int keep = 0',
        'for i = 0 to 2',
        '    emit.append "effect0" i',
        'keep := 1',
        'emit "output0" close + keep',
      ].join('\n'),
    );
    expect(analyzeWgslEffects(bounded).maxEffectsPerRow).toBe(3);

    const unbounded = mustBuild(
      [
        '',
        'var int keep = 0',
        'for i = 0 to bar_index',
        '    emit.append "effect0" i',
        'keep := 1',
        'emit "output0" close + keep',
      ].join('\n'),
    );
    expect(() => analyzeWgslEffects(unbounded)).toThrow(
      WgslEffectAnalysisError,
    );
  });

  test('rejects an effect transitively reached from a forged persistent root initializer', () => {
    const program = defaultedConstructorFixture();
    const root = namesOf(program).find(name => name.name === 'state');
    const initializer = program.body[0];
    const assignment = program.body[1];
    if (
      root === undefined ||
      initializer?.kind !== IrKind.InitName ||
      assignment?.kind !== IrKind.Assign ||
      assignment.value.kind !== IrKind.NewStruct
    ) {
      throw new Error('malformed persistent-initializer fixture');
    }

    const forged: Program = {
      ...program,
      packageGlobals: [],
      body: [{...initializer, value: assignment.value}],
    };

    expect(() => analyzeWgslEffects(forged)).toThrow(
      "persistent initializer 'state'",
    );
  });

  test('rejects an effect transitively reached from a forged package-global initializer', () => {
    const program = defaultedConstructorFixture();
    const root = namesOf(program).find(name => name.name === 'state');
    const assignment = program.body[1];
    if (
      root === undefined ||
      assignment?.kind !== IrKind.Assign ||
      assignment.value.kind !== IrKind.NewStruct
    ) {
      throw new Error('malformed package-global initializer fixture');
    }
    const global = {
      ...root,
      name: 'libraryState',
    };
    const forged: Program = {
      ...program,
      packageGlobals: [global],
      body: [
        {
          kind: IrKind.InitName,
          pos: assignment.pos,
          name: global,
          value: assignment.value,
        },
      ],
    };

    expect(() => analyzeWgslEffects(forged)).toThrow(
      "persistent initializer 'libraryState'",
    );
  });
});

function defaultedConstructorFixture(): Program {
  return mustBuild(
    [
      'noisy() =>',
      '    emit.append "effect0" 1',
      '    2',
      'type Box',
      '    int value = noisy()',
      'var Box state = Box.new(0)',
      'state := Box.new()',
      'emit "output0" close',
    ].join('\n'),
  );
}
