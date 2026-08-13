// Purpose: CSV provider tests pin the axis-only time column and exact trailing-range projection.

import {describe, expect, test} from 'bun:test';
import {isContextError, type SeriesData} from '../../runtime/abi';
import {csvContext, csvProvider} from './csv';

function values(data: SeriesData): number[] {
  return Array.from({length: data.length}, (_, row) => data.at(row));
}

describe('csvProvider', () => {
  test('uses time only as the execution axis', async () => {
    const provider = csvProvider('time,close\n100,1\n200,2\n300,3');
    const result = await provider.resolveContext('', '', {kind: 'full'});
    if (isContextError(result)) {
      throw new Error(
        `expected context, got ${result.error}: ${result.detail}`,
      );
    }
    expect(result.rows).toBe(3);
    expect(result.series('time')).toBeNull();
    expect(result.axis?.time(0)).toBe(100);
    expect(result.axis?.closeTime(2)).toBe(400);
    expect(result.builtinValue({domain: 'syminfo', field: 'tickerid'})).toBe(
      undefined,
    );
  });

  test('projects an exact trailing range over data and axis', async () => {
    const provider = csvProvider('time,close\n100,1\n200,2\n300,3');
    const result = await provider.resolveContext('', '', {
      kind: 'trailing-bars',
      bars: 2,
    });
    if (isContextError(result)) {
      throw new Error(
        `expected context, got ${result.error}: ${result.detail}`,
      );
    }
    expect(result.rows).toBe(2);
    const close = result.series('close');
    if (close === null) {
      throw new Error("expected series 'close'");
    }
    expect(values(close)).toEqual([2, 3]);
    expect(result.axis?.time(0)).toBe(200);
    expect(result.axis?.closeTime(1)).toBe(400);
  });

  test('streams CRLF rows, blanks and a final unterminated line into columns', () => {
    const context = csvContext(
      '\r\n time , open, high, low, close, volume \r\n' +
        '100,1,3,1,2,10\r\n' +
        '   \r\n' +
        '200,2,4,,3,\r\n' +
        '300,3,5,2,4',
    );

    expect(context.rows).toBe(3);
    expect(context.series('time')).toBeNull();
    expect(values(context.series('close')!)).toEqual([2, 3, 4]);
    expect(values(context.series('low')!)).toEqual([1, NaN, 2]);
    expect(values(context.series('volume')!)).toEqual([10, NaN, NaN]);
    expect(values(context.series('hl2')!)).toEqual([2, NaN, 3.5]);
    expect(context.axis?.time(2)).toBe(300);
    expect(context.axis?.closeTime(2)).toBe(400);
  });

  test('treats absent trailing cells as numeric empties', () => {
    const context = csvContext('time,open,close\n100,1\n200,2,3');
    expect(values(context.series('close')!)).toEqual([NaN, 3]);
  });
});
