import {describe, expect, test} from 'vitest';
import {d, i, m, s, timeframeClock, w} from './clock';

describe('timeframeClock', () => {
  test('maps regular Tea timeframes and rejects unknown forms', () => {
    expect(timeframeClock('15')).toBe(15n * m);
    expect(timeframeClock('30S')).toBe(30n * s);
    expect(timeframeClock('2D')).toBe(2n * d);
    expect(timeframeClock('W')).toBe(w);
    expect(timeframeClock('')).toBe(i);
    expect(timeframeClock('1H')).toBe(i);
  });
});
