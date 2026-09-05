// Purpose: Runtime numeric semantics and rejection of invalid Program constants.

import {describe, expect, test} from 'vitest';
import {IrKind} from '../ir/node';
import {FloatType, NaType, NA_VALUE, Qualifier} from '../ir/type';
import {lowerExpr, type LowerCtx} from './lower';
import {float, int, text} from '../runtime/js/value';
import {rangeNext, nz, str} from '../runtime/native';

describe('finite-or-na helpers', () => {
  test('an uncontextualized na type cannot cross the lowering boundary', () => {
    expect(() =>
      lowerExpr(
        {
          kind: IrKind.Const,
          pos: {base: {filename: 'test.tea'}, line: 1, col: 1},
          type: NaType,
          qualifier: Qualifier.Const,
          value: NA_VALUE,
        },
        [],
        {} as LowerCtx,
      ),
    ).toThrow('uncontextualized na type reached lowering');
  });

  test('numeric captures preserve finite values and canonicalize non-finite values', () => {
    const num = (value: number) => float(value).value;
    expect(num(12.5)).toBe(12.5);
    expect(Number.isNaN(num(NaN))).toBe(true);
    expect(Number.isNaN(num(Infinity))).toBe(true);
    expect(Number.isNaN(num(-Infinity))).toBe(true);
  });

  test('rangeNext stops zero, overflowing, and numerically stalled ranges', () => {
    const next = (value: number, step: number) =>
      rangeNext(float(value), float(step)).value;
    expect(next(1, 2)).toBe(3);
    expect(next(3, -2)).toBe(1);
    expect(Number.isNaN(next(1, 0))).toBe(true);
    expect(Number.isNaN(next(Number.MAX_VALUE, Number.MAX_VALUE))).toBe(true);
    expect(Number.isNaN(next(1e20, 1))).toBe(true);
  });

  test('a non-finite Program constant fails at the lowering boundary', () => {
    const ctx: LowerCtx = {
      nameLocations: new Map(),
      directNames: new Map(),
      seriesIds: new Map(),
      builtinIds: new Map(),
      paramIds: new Map(),
      paramSeriesIds: new Map(),
      outputIds: new Map(),
      funcIds: new Map(),
      requestIds: new Map(),
      layoutOf: () => 0,
      currentFid: 0,
      noteCallSite() {},
      typeOf: () => '',
      valueOf: (_, raw) => raw,
      emptyOf: () => 'NaN',
      factoryOf: () => '',
      localKey: name => name.name,
      callKey: () => '',
      functionRef: () => '',
      seriesKey: () => '',
      fresh: () => 't0',
    };
    expect(() =>
      lowerExpr(
        {
          kind: IrKind.Const,
          pos: {base: {filename: 'test.tea'}, line: 1, col: 1},
          type: FloatType,
          qualifier: Qualifier.Const,
          value: Infinity,
        },
        [],
        ctx,
      ),
    ).toThrow('non-finite constant reached lowering');
  });

  test('equality and inequality are both false when either operand is na', () => {
    for (const method of ['eq', 'ne'] as const) {
      expect(float(NaN)[method](float(1)).value).toBe(false);
      expect(float(1)[method](float(NaN)).value).toBe(false);
      expect(text(null)[method](text('one')).value).toBe(false);
      expect(text('one')[method](text(null)).value).toBe(false);
    }
    expect(text('same').eq(text('same')).value).toBe(true);
    expect(text('left').ne(text('right')).value).toBe(true);
  });

  test('reference helpers propagate na and use type-owned replacements', () => {
    const concat = (left: string | null, right: string | null) =>
      text(left).concat(text(right)).value;
    const replace = (value: string | null, replacement: string) =>
      nz(text(value), text(replacement)).value;
    const tostring = (value: number | null) =>
      str.tostring(value === null ? text(null) : int(value)).value;
    expect(concat('a', 'b')).toBe('ab');
    expect(concat(null, 'b')).toBeNull();
    expect(concat('a', null)).toBeNull();
    expect(replace(null, '#00000000')).toBe('#00000000');
    expect(tostring(NaN)).toBe('NaN');
    expect(tostring(null)).toBe('NaN');
  });
});
