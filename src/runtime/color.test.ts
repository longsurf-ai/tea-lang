import {expect, test} from 'vitest';
import {applyTransparency, rgbColor} from '../base/color';
import {Color} from './color';

test('Color has immutable byte fields, canonical hex and value equality', () => {
  const red = Color.parse('#ff0000ff');
  expect(Object.keys(red)).toEqual(['r', 'g', 'b', 'a']);
  expect(Object.isFrozen(red)).toBe(true);
  expect(red.toString()).toBe('#FF0000');
  expect(red.equals(new Color(255, 0, 0))).toBe(true);
  expect(red.equals(new Color(255, 0, 0, 254))).toBe(false);
  expect(red.equals(null)).toBe(false);
  expect(Reflect.set(red, 'r', 0)).toBe(false);
  expect(new Color(300, -5, 127.6, 0).toString()).toBe('#FF008000');
  for (const invalid of ['', 'red', '#123', '#FF0000F', '#GG0000'])
    expect(() => Color.parse(invalid)).toThrow(TypeError);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    expect(() => new Color(invalid, 0, 0)).toThrow(TypeError);
    expect(() => new Color(0, 0, 0, invalid)).toThrow(TypeError);
    expect(() => red.withTransparency(invalid)).toThrow(TypeError);
  }
});

test('Color preserves the frontend color arithmetic and transparency', () => {
  for (const source of ['#2196F3', '#FF6D00AA', '#000000']) {
    const value = Color.parse(source);
    for (const transparency of [-10, 0, 10, 50, 90, 100, 110]) {
      const result = value.withTransparency(transparency);
      expect(result.toString()).toBe(applyTransparency(source, transparency));
      expect(value.toString()).toBe(source);
    }
  }
  for (const [r, g, b, transparency] of [
    [33, 150, 243, 0],
    [255, 109, 0, 20],
    [0, 0, 0, 100],
    [300, -5, 127.6, 50],
  ]) {
    expect(Color.rgb(r, g, b, transparency).toString()).toBe(
      rgbColor(r, g, b, transparency),
    );
  }
});
