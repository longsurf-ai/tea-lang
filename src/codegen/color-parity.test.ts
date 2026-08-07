// Purpose: Parity lock — the emitted $colorNew/$colorRgb helper strings must agree with base/color.ts on every probed value; the formulas are deliberately duplicated (generated code cannot import TS) and this test is the invariant.

import {describe, expect, test} from 'bun:test';
import {applyTransparency, rgbColor} from '../base/color';
import {HELPERS} from './lower';

const emittedNew = new Function(`return ${HELPERS.$colorNew}`)() as (
  c: string,
  t: number,
) => string;
const emittedRgb = new Function(`return ${HELPERS.$colorRgb}`)() as (
  r: number,
  g: number,
  b: number,
  t: number | null,
) => string;

describe('color helper parity', () => {
  test('$colorNew mirrors applyTransparency', () => {
    for (const color of ['#2196F3', '#FF6D00AA', '#000000']) {
      for (const transp of [0, 10, 50, 90, 100]) {
        expect(emittedNew(color, transp)).toBe(
          applyTransparency(color, transp),
        );
      }
    }
  });

  test('$colorRgb mirrors rgbColor', () => {
    const probes: [number, number, number, number | null][] = [
      [33, 150, 243, null],
      [255, 109, 0, 20],
      [0, 0, 0, 100],
      [300, -5, 127.6, 50], // clamping and rounding
    ];
    for (const [r, g, b, t] of probes) {
      expect(emittedRgb(r, g, b, t)).toBe(rgbColor(r, g, b, t));
    }
  });
});
