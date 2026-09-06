// Purpose: Named raw output fields preserve schema order in reports and traces.
import type {Module} from '../runtime/module-binding';
import {Field, Float64, List, Utf8} from 'apache-arrow';
import {outputSchema} from '../runtime/output';
import {describe, expect, test} from 'vitest';
import {renderRunReport, traceDatum, traceDeclaration} from './output';

const scalar = (name: string) =>
  new Field(
    name,
    new Float64(),
    true,
    new Map([
      ['tea:write', 'set'],
      ['tea:type', 'float'],
    ]),
  );
const declaration: Module['outputs'] = {
  declarations: [{layout: 0}, {layout: 1}],
  schema: outputSchema([
    scalar('equity'),
    new Field(
      'fills',
      new List(new Field('item', new Utf8(), true)),
      false,
      new Map([['tea:write', 'append']]),
    ),
  ]),
};

describe('CLI output', () => {
  test('renders named cells including absent values and append lists', () => {
    expect(traceDeclaration(declaration)).toEqual([
      '# set "equity" type=float',
      '# append "fills" type=List<Utf8>',
    ]);
    expect(
      traceDatum(
        {
          index: 1,
          timed: false,
          equity: NaN,
          fills: ['buy', 'sell'],
          provisional: true,
        },
        declaration.schema,
      ),
    ).toEqual(['1 "equity" ? na', '1 "fills" ? ["buy","sell"]']);
  });

  test('uses declaration order for numeric-like names and keeps nested values', () => {
    const schema = outputSchema([scalar('10'), scalar('2'), scalar('absent')]);
    expect(
      traceDatum(
        {
          index: 3,
          timed: false,
          provisional: false,
          '2': new Map([['x', 2]]),
          '10': [null, NaN, new Uint8Array([0, 255])],
          absent: null,
        },
        schema,
      ),
    ).toEqual([
      '3 "10" [null,"na",[0,255]]',
      '3 "2" [["x",2]]',
      '3 "absent" na',
    ]);
  });

  test('renders only final values in the human report', () => {
    const report = renderRunReport(
      declaration,
      [
        {index: 0, timed: false, equity: 10, fills: ['buy'], provisional: true},
        {
          index: 0,
          timed: false,
          equity: 11,
          fills: ['sell'],
          provisional: false,
        },
      ],
      [],
      {indices: 1, compilationMs: 1.25, executionMs: 4},
    );
    expect(report).toContain('compilation  1.25 ms');
    expect(report).toContain('execution    4.00 ms');
    expect(report).toMatch(/^0\s+11\s+\["sell"\]$/m);
    expect(report).not.toContain('["buy"]');
  });
});
