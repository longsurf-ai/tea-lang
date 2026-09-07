// Purpose: Runtime color operations preserve the canonical color helpers used by the frontend.

import {describe, expect, test} from 'vitest';
import {applyTransparency, rgbColor} from '../base/color';
import {colors} from '../runtime/native';
import {color, float} from '../runtime/js/value';
import {Context} from '../runtime/js/context';
import {loadModule} from '../runtime/load';
import {mustBuild} from '../noder/testing';
import {generate} from './codegen';
import {checkGenerated} from './check';

const emittedNew = (value: string, transparency: number) =>
  colors.new(color(value), float(transparency)).value?.toString();
const emittedRgb = (
  r: number,
  g: number,
  b: number,
  transparency: number | null,
) =>
  colors
    .rgb(
      float(r),
      float(g),
      float(b),
      ...(transparency === null ? [] : [float(transparency)]),
    )
    .value?.toString();

describe('color helper parity', () => {
  test('$colorNew mirrors applyTransparency', () => {
    for (const color of ['#2196F3', '#FF6D00AA', '#000000']) {
      for (const transp of [0, 0.001, 10, 50, 90, 100]) {
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

test('constant folding and execution compare canonical color channels equally', () => {
  const source = generate(
    mustBuild(`
emit "constant" color.rgb(1, 2, 3, 0.001) == #010203
emit "runtime" color.rgb(1, 2, 3, close) == #010203
emit "literal" #010203FF == #010203
emit "unequal" #010203FE != #010203
emit "transparent" color.new(#010203, 0.001) == #010203FF
`),
  );
  checkGenerated(source);
  const context = new Context(loadModule(source).bind());
  expect(
    context.step({
      series: [0.001],
      builtins: [],
      requests: [],
      provisional: false,
    }).outputs,
  ).toEqual([true, true, true, true, true]);
  context.dispose();
});

test('compiled color parameters and map keys retain value semantics with RGBA output', () => {
  const source = generate(
    mustBuild(`
chosen = input.color(color.red)
values = map.new<color, int>()
values.put(chosen, 1)
values.put(color.rgb(33, 150, 243), 2)
emit "count" values.size()
emit "value" values.get(color.new(#2196F3, 0))
emit "keys" values.keys()
emit "chosen" chosen
emit "text" str.tostring(chosen)
emit "equal" chosen == color.rgb(33, 150, 243)
`),
  );
  checkGenerated(source);
  const module = loadModule(source).bind({chosen: '#2196f3ff'});
  expect(module.parameters[0].value).toBe('#2196F3');
  const context = new Context(module);
  const result = context.step({
    series: [],
    builtins: [],
    requests: [],
    provisional: false,
  });
  expect(result.outputs).toEqual([
    1,
    2,
    [{r: 33, g: 150, b: 243, a: 255}],
    {r: 33, g: 150, b: 243, a: 255},
    '#2196F3',
    true,
  ]);
  context.dispose();
});
