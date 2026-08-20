// Purpose: Generated-helper parity locks for finite-or-na normalization and type-directed na behavior.

import {describe, expect, test} from 'vitest';
import {IrKind} from '../ir/node';
import {FloatType, NaType, Qualifier} from '../ir/type';
import {HELPERS, lowerExpr, valueClassOf, type LowerCtx} from './lower';

function helper<T>(source: string): T {
  return new Function(`return ${source}`)() as T;
}

describe('finite-or-na helpers', () => {
  test('an uncontextualized na type cannot cross the lowering boundary', () => {
    expect(() => valueClassOf(NaType)).toThrow(
      'uncontextualized na type reached lowering',
    );
  });

  test('$num preserves finite values and canonicalizes every non-finite value', () => {
    const num = helper<(x: number) => number>(HELPERS.$num);
    expect(num(12.5)).toBe(12.5);
    expect(Number.isNaN(num(NaN))).toBe(true);
    expect(Number.isNaN(num(Infinity))).toBe(true);
    expect(Number.isNaN(num(-Infinity))).toBe(true);
  });

  test('$rangeNext stops zero, overflowing, and numerically stalled ranges', () => {
    const next = helper<(x: number, step: number) => number>(
      HELPERS.$rangeNext,
    );
    expect(next(1, 2)).toBe(3);
    expect(next(3, -2)).toBe(1);
    expect(Number.isNaN(next(1, 0))).toBe(true);
    expect(Number.isNaN(next(Number.MAX_VALUE, Number.MAX_VALUE))).toBe(true);
    expect(Number.isNaN(next(1e20, 1))).toBe(true);
  });

  test('a non-finite Program constant fails at the lowering boundary', () => {
    const ctx: LowerCtx = {
      nameSlots: new Map(),
      directNames: new Map(),
      seriesIds: new Map(),
      builtinIds: new Map(),
      paramIds: new Map(),
      paramSeriesIds: new Map(),
      outputIds: new Map(),
      effectIds: new Map(),
      funcIds: new Map(),
      requestIds: new Map(),
      dynamicRequests: new Set(),
      moduleRef: 'M',
      layoutOf: () => 0,
      currentFid: 0,
      noteCallSite() {},
      useHelper() {},
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
    const eq = helper<(a: unknown, b: unknown) => boolean>(HELPERS.$eq);
    const ne = helper<(a: unknown, b: unknown) => boolean>(HELPERS.$ne);
    for (const na of [NaN, null]) {
      expect(eq(na, 1)).toBe(false);
      expect(eq(1, na)).toBe(false);
      expect(ne(na, 1)).toBe(false);
      expect(ne(1, na)).toBe(false);
    }
    expect(eq('same', 'same')).toBe(true);
    expect(ne('left', 'right')).toBe(true);
  });

  test('reference helpers propagate na and use type-owned replacements', () => {
    const concat = helper<
      (a: string | null, b: string | null) => string | null
    >(HELPERS.$concat);
    const nz = helper<(x: string | null, replacement: string) => string>(
      HELPERS.$nzRef,
    );
    const tostring = helper<(x: unknown) => string>(HELPERS.$toString);

    expect(concat('a', 'b')).toBe('ab');
    expect(concat(null, 'b')).toBeNull();
    expect(concat('a', null)).toBeNull();
    expect(nz(null, '#00000000')).toBe('#00000000');
    expect(tostring(NaN)).toBe('NaN');
    expect(tostring(null)).toBe('NaN');
  });
});
