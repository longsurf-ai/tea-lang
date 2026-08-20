// Purpose: Lock deterministic literal-string interning to the reachable WGSL Program graph.

import {describe, expect, test} from 'bun:test';
import {IrKind} from '../../ir/node';
import type {Program} from '../../ir/program';
import {namesOf} from '../../ir/visit';
import {mustBuild} from '../../noder/testing';
import {
  WgslEffectAnalysisError,
  analyzeWgslEffects,
  collectLiteralStrings,
} from './effects-analysis';

describe('WGSL effect artifact analysis', () => {
  test('collects strategy command ids in deterministic first-encounter order', () => {
    const program = mustBuild(
      [
        'strategy("literal ids")',
        'var float keep = 0.0',
        'choose(bool second) => second ? "Close" : "Long"',
        'id = choose(bar_index > 0)',
        'effect.emit(id)',
        'effect.emit("Long")',
        'plot(close + keep)',
      ].join('\n'),
    );

    expect(collectLiteralStrings(program)).toEqual(['Close', 'Long']);
  });

  test('enters nested reachable UDFs once and ignores declaration metadata', () => {
    const program = mustBuild(
      [
        'strategy("not a runtime literal")',
        'var float keep = 0.0',
        'inner() => "nested"',
        'outer() => inner()',
        'effect.emit(outer())',
        'effect.emit("root")',
        'plot(close + keep, "output title")',
      ].join('\n'),
    );

    expect(collectLiteralStrings(program)).toEqual(['nested', 'root']);
  });

  test('adds eager Cond arms and sequential function calls', () => {
    const program = mustBuild(
      [
        'strategy("effect bound")',
        'emitOne(int value) =>',
        '    effect.emit(value)',
        '    value',
        'var int keep = 0',
        'keep := true ? emitOne(1) : emitOne(2)',
        'keep := emitOne(3)',
        'plot(close + keep)',
      ].join('\n'),
    );

    expect(analyzeWgslEffects(program).maxEffectsPerRow).toBe(3);
  });

  test('takes the maximum lazy IfExpr arm rather than their sum', () => {
    const program = mustBuild(
      [
        'strategy("lazy effect bound")',
        'choose(bool condition) =>',
        '    if condition',
        '        effect.emit(1)',
        '        1',
        '    else',
        '        effect.emit(2)',
        '        effect.emit(3)',
        '        2',
        'var int keep = 0',
        'keep := choose(bar_index > 0)',
        'plot(close + keep)',
      ].join('\n'),
    );

    expect(analyzeWgslEffects(program).maxEffectsPerRow).toBe(2);
  });

  test('multiplies a compile-time bounded loop and rejects an unknown bound', () => {
    const bounded = mustBuild(
      [
        'strategy("bounded effects")',
        'var int keep = 0',
        'for i = 0 to 2',
        '    effect.emit(i)',
        'keep := 1',
        'plot(close + keep)',
      ].join('\n'),
    );
    expect(analyzeWgslEffects(bounded).maxEffectsPerRow).toBe(3);

    const unbounded = mustBuild(
      [
        'strategy("unbounded effects")',
        'var int keep = 0',
        'for i = 0 to bar_index',
        '    effect.emit(i)',
        'keep := 1',
        'plot(close + keep)',
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
      assignment?.kind !== IrKind.WriteName ||
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
      assignment?.kind !== IrKind.WriteName ||
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
      '    effect.emit(1)',
      '    2',
      'type Box',
      '    int value = noisy()',
      'var Box state = Box.new(0)',
      'state := Box.new()',
      'plot(close)',
    ].join('\n'),
  );
}
