// Purpose: Compiler-shipped visual prelude functions resolve as ordinary Tea
// functions and elaborate through the generic output intrinsic.

import {describe, expect, test} from 'vitest';
import {CallKind} from '../checker/info';
import {checkText} from '../checker/testing';
import {mustBuild} from '../noder/testing';

describe('visual prelude', () => {
  test('exposes plot unqualified while retaining plot.style_* native constants', () => {
    const result = checkText(
      'p = plot(close, "Close", style=plot.style_columns)',
    );
    expect(result.errors).toEqual([]);
    const rootPlot = [...result.info.calls.values()].find(
      call => call.kind === CallKind.Function && call.instance.name === 'plot',
    );
    expect(rootPlot?.kind).toBe(CallKind.Function);
    if (rootPlot?.kind === CallKind.Function) {
      expect(rootPlot.instance.template.pkg.path).toBe('visual');
      expect(rootPlot.instance.output?.resolution.kind).toBe(CallKind.Output);
    }
  });

  test('creates distinct caller-owned plot declarations consumable by fill', () => {
    const program = mustBuild(
      [
        'first = plot(close, "Close")',
        'second = plot(open, "Open")',
        'fill(first, second, color=color.blue)',
      ].join('\n'),
    );
    expect(program.outputs.map(output => output.effect)).toEqual([
      'plot',
      'plot',
      'fill',
    ]);
    expect(program.outputs[2].bindArgs).toHaveLength(2);
  });
});
