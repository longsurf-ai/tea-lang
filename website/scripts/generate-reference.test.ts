// Purpose: Lock the generated native reference to Tea's source-facing vocabulary rather than catalog implementation metadata.

import {describe, expect, test} from 'bun:test';

import {functionsPage} from './generate-reference';

describe('native function reference', () => {
  test('describes mutable receivers without exposing internal inout mode', () => {
    const page = functionsPage();

    expect(page).not.toContain('inout');
    expect(page).toContain(
      '`array.push<T: storable>(self: array<T>, value: T) → void`',
    );
    expect(page).toContain(
      '| `self` | `array<T>` | `series` | Yes | writes receiver |',
    );
  });

  test('marks staged positional parameters without hiding their ABI slot', () => {
    const page = functionsPage();

    expect(page).toContain(
      '`request.security(symbol: string, timeframe: string, expression: any value, gaps?: bool, lookahead?: bool, ignore_invalid_symbol?: bool, currency?: string, calc_bars_count?: int) → float`',
    );
    expect(page).toContain(
      '| `currency` | `string` | `const` | No | staged; not supported |',
    );
  });
});
