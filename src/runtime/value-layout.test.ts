// Purpose: Runtime layout registry tests for immutable ownership, exact nominal guards, typed empties, and finite collection-mediated recursion.

import {describe, expect, test} from 'bun:test';
import {ValueClass} from './abi';
import {
  type AggregateLayoutManifest,
  ValueLayoutRegistry,
} from './value-layout';

describe('ValueLayoutRegistry', () => {
  test('owns a deeply frozen copy of the generated manifest', () => {
    const enumLayout = {
      kind: 'enum',
      name: 'Side',
      members: ['buy', 'sell'],
    };
    const userLayout = {
      kind: 'user-type',
      name: 'Order',
      fields: [{name: 'side', layout: 1}],
    };
    const source = {
      layouts: [{kind: 'number', numeric: 'int'}, enumLayout, userLayout],
    } as unknown as AggregateLayoutManifest;
    const layouts = new ValueLayoutRegistry(source);

    enumLayout.name = 'Changed';
    enumLayout.members.push('other');
    userLayout.fields[0].name = 'changed';

    expect(layouts.layout(1)).toEqual({
      kind: 'enum',
      name: 'Side',
      members: ['buy', 'sell'],
    });
    expect(layouts.layout(2)).toEqual({
      kind: 'user-type',
      name: 'Order',
      fields: [{name: 'side', layout: 1}],
    });
    expect(Object.isFrozen(layouts.layout(1))).toBe(true);
    expect(
      Object.isFrozen(
        (layouts.layout(2) as {fields: readonly unknown[]}).fields,
      ),
    ).toBe(true);
  });

  test('derives exact typed empties and nominal value classes', () => {
    const layouts = new ValueLayoutRegistry({
      layouts: [
        {kind: 'number', numeric: 'float'},
        {kind: 'boolean'},
        {kind: 'nullable-scalar', scalar: 'string'},
        {kind: 'resource', handle: 'label'},
      ],
    });

    expect(Number.isNaN(layouts.empty(0) as number)).toBe(true);
    expect(layouts.empty(1)).toBe(false);
    expect(layouts.empty(2)).toBeNull();
    expect(layouts.empty(3)).toBeNull();
    expect(layouts.valueClass(0)).toBe(ValueClass.Numeric);
    expect(layouts.valueClass(1)).toBe(ValueClass.Boolean);
    expect(layouts.valueClass(2)).toBe(ValueClass.Nullable);
  });

  test('rejects inline recursion but accepts recursion through a collection', () => {
    expect(
      () =>
        new ValueLayoutRegistry({
          layouts: [
            {
              kind: 'user-type',
              name: 'Loop',
              fields: [{name: 'next', layout: 0}],
            },
          ],
        }),
    ).toThrow('infinite inline cycle');

    const layouts = new ValueLayoutRegistry({
      layouts: [
        {
          kind: 'user-type',
          name: 'Node',
          fields: [{name: 'children', layout: 1}],
        },
        {kind: 'array', element: 0},
      ],
    });
    expect(layouts.length).toBe(2);
  });

  test('shallow size expands inline values and stops at collection headers', () => {
    const layouts = new ValueLayoutRegistry({
      layouts: [
        {kind: 'number', numeric: 'int'},
        {
          kind: 'user-type',
          name: 'Inner',
          fields: [
            {name: 'x', layout: 0},
            {name: 'y', layout: 0},
          ],
        },
        {kind: 'array', element: 1},
        {
          kind: 'user-type',
          name: 'Outer',
          fields: [
            {name: 'inner', layout: 1},
            {name: 'items', layout: 2},
          ],
        },
      ],
    });

    expect(layouts.shallowBytes(1)).toBe(32);
    expect(layouts.shallowBytes(2)).toBe(32);
    expect(layouts.shallowBytes(3)).toBe(80);
  });

  test('guards enum membership and concrete resource kind', () => {
    const layouts = new ValueLayoutRegistry({
      layouts: [
        {kind: 'enum', name: 'Side', members: ['buy', 'sell']},
        {kind: 'resource', handle: 'label'},
      ],
    });
    expect(() => layouts.assertValue(0, 'other')).toThrow(
      'VALUE_LAYOUT_MISMATCH',
    );
    expect(() =>
      layouts.assertValue(
        1,
        Object.freeze({kind: 'resource', handle: 'line', id: 1}),
      ),
    ).toThrow('VALUE_LAYOUT_MISMATCH');
  });
});
