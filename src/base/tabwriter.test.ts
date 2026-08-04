// Purpose: TabWriter alignment — locks the pad-to-max-width rule used by CLI tables.

import {describe, expect, test} from 'bun:test';
import {TabWriter} from './tabwriter';

describe('TabWriter', () => {
  test('pads columns to the widest cell and leaves the last cell unpadded', () => {
    const tw = new TabWriter();
    tw.writeCells(['row', 'MACD', 'Signal']);
    tw.writeCells(['0', '1', '2']);
    tw.writeCells(['10', '0.5', '12.25']);
    expect(tw.flush()).toBe(
      ['row  MACD  Signal', '0    1     2', '10   0.5   12.25'].join('\n'),
    );
  });

  test('raw lines sit outside the column grid', () => {
    const tw = new TabWriter();
    tw.writeRaw('# indicator title=MACD');
    tw.writeCells(['row', 'v']);
    tw.writeCells(['0', '1']);
    expect(tw.flush()).toBe(
      ['# indicator title=MACD', 'row  v', '0    1'].join('\n'),
    );
  });
});
