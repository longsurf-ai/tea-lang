// Pine's market series are input aliases in the silent pine prelude.

import {describe, expect, test} from 'vitest';
import {CATALOG} from '../checker/catalog';
import {ObjectKind} from '../checker/object';
import {checkText} from '../checker/testing';
import {FloatType, Qualifier} from '../ir/type';
import {seriesInputsOf} from '../ir/visit';
import {mustBuild} from '../noder/testing';

const MARKET = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
];

describe('pine prelude', () => {
  test('exports exactly the market series, each an input alias', () => {
    const result = checkText('x = close');
    expect(result.errors).toEqual([]);
    const pine = [...result.checked.packageContexts.keys()].find(
      pkg => pkg.path === 'pine',
    );
    expect(pine).toBeDefined();
    expect([...pine!.exports.keys()]).toEqual(MARKET);
    for (const [name, object] of pine!.exports) {
      expect(object).toEqual({
        kind: ObjectKind.Builtin,
        name,
        type: FloatType,
        qualifier: Qualifier.Series,
        value: null,
        binding: {kind: 'series', id: name},
      });
    }
    // A script's close is that same object, not a copy.
    const [use] = [...result.info.uses.values()].filter(
      object => object.kind === ObjectKind.Builtin && object.name === 'close',
    );
    expect(use).toBe(pine!.exports.get('close'));
  });

  test('the core catalog declares no market name', () => {
    for (const name of MARKET) {
      expect(CATALOG.vars.has(name)).toBe(false);
    }
  });

  test('ta reads the prelude through ordinary input aliases', () => {
    const program = mustBuild('emit "output0" ta.atr(3) + ta.sma(hl2, 2)');
    expect(
      seriesInputsOf(program)
        .map(series => series.id)
        .sort(),
    ).toEqual(['close', 'high', 'hl2', 'low']);
  });
});
