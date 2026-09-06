// Named output declarations are checked before Arrow or a backend exists.
import {describe, expect, test} from 'vitest';
import {TypeKind} from '../ir/type';
import {CallKind} from './info';
import {checkText} from './testing';

const messages = (source: string) =>
  checkText(source).errors.map(error => error.msg);

describe('named emissions', () => {
  test('records raw value type and mode, sharing append declarations', () => {
    const result = checkText(
      'emit "price" close\nemit.append "fills" 1\nemit.append "fills" 2',
    );
    expect(result.errors).toEqual([]);
    const columns = [...result.info.emits.values()];
    expect(
      columns.map(column => [column.name, column.mode, column.valueType.kind]),
    ).toEqual([
      ['price', 'set', TypeKind.Float],
      ['fills', 'append', TypeKind.Int],
      ['fills', 'append', TypeKind.Int],
    ]);
    expect(columns[1]).toBe(columns[2]);
  });

  test('different constant names specialize ordinary function bodies and forwarded defaults', () => {
    const result = checkText(
      [
        'publish(const string id, float value) =>',
        '    emit id value',
        '    return value',
        'forward(const string id = "default", float value = 1.0) => publish(id, value)',
        'forward("first", close)',
        'forward("second", open)',
        'forward()',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    const calls = [...result.info.calls.values()].filter(
      call => call.kind === CallKind.Function,
    );
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(call => call.instance)).size).toBe(3);
  });

  test('ordinary plot returns a nominal library value and emits once per explicit ID', () => {
    const result = checkText(
      'p = plot("first", close)\nq = plot("second", open)\nfill("area", p, q)',
    );
    expect(result.errors).toEqual([]);
    const call = [...result.info.calls.values()].find(
      call => call.kind === CallKind.Function,
    );
    expect(
      call?.kind === CallKind.Function && call.instance.resultType.kind,
    ).toBe(TypeKind.Struct);
    expect(messages('plot("same", close)\nplot("same", open)')).toContain(
      "output 'same' has more than one plain emit writer",
    );
  });

  test('method declaration validation defers concrete names and unused methods add nothing', () => {
    const result = checkText(
      [
        'struct Publisher',
        '    int value',
        '    int publish(const string id) const =>',
        '        emit id this.value',
        '        return this.value',
        'p = Publisher.new(1)',
        'p.publish("one")',
        'p.publish("two")',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
  });

  test.each([
    ['emit "x" 1\nemit "x" 2', 'more than one plain emit writer'],
    [
      'if close > 0\n    emit "x" 1\nelse\n    emit "x" 2',
      'more than one plain emit writer',
    ],
    ['emit.append "x" 1\nemit.append "x" 2.0', 'one write mode and Tea type'],
    [
      'emit "x" array.from(1)\nemit.append "x" 2',
      'one write mode and Tea type',
    ],
    ['for i = 0 to 2\n    emit "x" i', 'more than once per step'],
    [
      'n = 0\nfor i = 0 to 0\n    emit "x" i\n    if n == 0\n        i := -1\n    n += 1',
      'more than once per step',
    ],
    [
      'publish() =>\n    emit "x" 1\npublish()\npublish()',
      'more than one plain emit writer',
    ],
    [
      'publish() =>\n    emit "x" 1\nfor i = 0 to 2\n    publish()',
      'more than once per step',
    ],
    ['emit (syminfo.ticker) close', 'compile-time constant string'],
    ['emit "index" 1', 'reserved for execution coordinates'],
    ['emit "" 1', 'cannot be empty'],
    ['emit "x" na', 'concrete exportable type'],
  ])('rejects invalid emission contract: %s', (source, message) => {
    expect(messages(source).some(error => error.includes(message))).toBe(true);
  });

  test('allows append loops and parenthesized constant names', () => {
    expect(
      messages(
        'const prefix = "trade"\nfor i = 0 to 2\n    emit.append (prefix + ".fill") i',
      ),
    ).toEqual([]);
    expect(messages('for i = 0 to 0\n    emit "once" i')).toEqual([]);
  });

  test('rejects nominal conflicts even when fields have identical layouts', () => {
    expect(
      messages(
        'struct A\n    int x\nstruct B\n    int x\nemit.append "events" A.new(1)\nemit.append "events" B.new(2)',
      ).some(error => error.includes('one write mode and Tea type')),
    ).toBe(true);
  });

  test('keeps qualifier caps on ordinary library parameters', () => {
    expect(
      messages('plot(syminfo.ticker, close)').some(error =>
        error.includes('accepts at most const'),
      ),
    ).toBe(true);
  });
});
