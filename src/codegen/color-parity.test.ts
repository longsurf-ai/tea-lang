// Purpose: Runtime color operations preserve the canonical color helpers used by the frontend.

import {describe, expect, test} from 'vitest';
import {applyTransparency, rgbColor} from '../base/color';
import {colors} from '../runtime/native';
import {color, float} from '../runtime/js/value';

const emittedNew = (value: string, transparency: number) =>
  colors.new(color(value), float(transparency)).value;
const emittedRgb = (
  r: number,
  g: number,
  b: number,
  transparency: number | null,
) =>
  colors.rgb(
    float(r),
    float(g),
    float(b),
    ...(transparency === null ? [] : [float(transparency)]),
  ).value;

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
