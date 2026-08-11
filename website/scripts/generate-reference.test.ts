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
});
