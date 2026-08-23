// Purpose: Generic output intrinsic checking, contextual argument objects,
// kind-dependent declaration references, and source qualifier caps.

import {describe, expect, test} from 'vitest';
import {TypeKind} from '../ir/type';
import {CallKind, type OutputCall} from './info';
import {checkText} from './testing';

function messages(source: string): string[] {
  return checkText(source).errors.map(error => error.msg);
}

describe('output intrinsic', () => {
  test('records the primary value and independently checked argument fields', () => {
    const result = checkText(
      [
        'width = input.int(2)',
        'tone = close > open ? color.green : color.red',
        'p = output(',
        '    close,',
        '    kind="plot",',
        '    args={title: "Close", color: tone, linewidth: width})',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    const call = [...result.info.calls.values()].find(
      (candidate): candidate is OutputCall =>
        candidate.kind === CallKind.Output,
    );
    expect(call?.outputKind).toBe('plot');
    expect(call?.resultType.kind).toBe(TypeKind.Plot);
    expect(call?.value.tv.type.kind).toBe(TypeKind.Float);
    expect(call?.args.map(arg => [arg.name, arg.value.tv.qualifier])).toEqual([
      ['title', 'const'],
      ['color', 'series'],
      ['linewidth', 'input'],
    ]);
    expect(call?.argumentEvaluationOrder).toEqual([0, 1, 2, 3]);
  });

  test('maps hline to its declaration-reference type and other kinds to void', () => {
    const result = checkText(
      [
        'h = output(0.0, kind="hline", args={})',
        'output(close, kind="metric", args={title: "Close"})',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    const outputs = [...result.info.calls.values()].filter(
      (candidate): candidate is OutputCall =>
        candidate.kind === CallKind.Output,
    );
    expect(outputs.map(output => output.resultType.kind)).toEqual([
      TypeKind.Hline,
      TypeKind.Void,
    ]);
  });

  test('rejects malformed kinds, duplicate fields, and argument objects elsewhere', () => {
    expect(
      messages(
        [
          'kind = syminfo.ticker',
          'output(close, kind=kind, args={})',
          'output(close, kind="plot", args={title: "A", title: "B"})',
          'metadata = {title: "Close"}',
        ].join('\n'),
      ),
    ).toEqual(
      expect.arrayContaining([
        'output kind must be a constant string',
        "duplicate output argument 'title'",
        'argument objects are valid only as the args argument to output()',
      ]),
    );
  });

  test('supports const and input qualifier caps on Tea function parameters', () => {
    expect(
      messages(
        [
          'show(const string title, input int width) => title',
          'ok = show("Title", input.int(2))',
          'badTitle = show(syminfo.ticker, 2)',
          'badWidth = show("Title", bar_index)',
        ].join('\n'),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "argument 'title' to 'show' accepts at most const",
        ),
        expect.stringContaining(
          "argument 'width' to 'show' accepts at most input",
        ),
      ]),
    );
  });

  test('recognizes a direct-tail Tea output wrapper and applies caller placement', () => {
    const valid = checkText(
      [
        'draw(series float value, const string title) =>',
        '    output(value, kind="plot", args={title: title})',
        'first = draw(close, "Close")',
        'second = draw(open, "Open")',
        'fill(first, second)',
      ].join('\n'),
    );
    expect(valid.errors).toEqual([]);
    const calls = [...valid.info.calls.values()].filter(
      call => call.kind === CallKind.Function,
    );
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.instance.output !== null)).toBe(true);

    expect(
      messages(
        [
          'draw(series float value) => output(value, kind="plot", args={})',
          'if close > open',
          '    draw(close)',
        ].join('\n'),
      ),
    ).toContain(
      "'draw' declares an output and can only be called at the top level of the script",
    );
  });
});
