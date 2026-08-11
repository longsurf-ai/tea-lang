// Purpose: CSV provider tests pin the axis-only time column and exact trailing-range projection.

import {describe, expect, test} from 'bun:test';
import {isContextError, type SeriesData} from '../../runtime/abi';
import {csvProvider} from './csv';

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
});
