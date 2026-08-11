// Purpose: User-value runtime contracts — nominal construction, typed-empty field reads, immutable path rebuilding, and na-write failure.

import {describe, expect, test} from 'bun:test';
import {newUserValue, rebuildUserPath, userField} from './user-value';
import {
  type AggregateLayoutManifest,
  ValueLayoutRegistry,
} from './value-layout';

const INT = 0;
const BOOL = 1;
const STRING = 2;
const CHILD = 3;
const PARENT = 4;

const MANIFEST = {
  layouts: [
    {kind: 'number', numeric: 'int'},
    {kind: 'boolean'},
    {kind: 'nullable-scalar', scalar: 'string'},
    {
      kind: 'user-type',
      name: 'Child',
      fields: [{name: 'value', layout: INT}],
    },
    {
      kind: 'user-type',
      name: 'Parent',
      fields: [
        {name: 'child', layout: CHILD},
        {name: 'enabled', layout: BOOL},
        {name: 'label', layout: STRING},
      ],
    },
  ],
} as const satisfies AggregateLayoutManifest;

describe('user values', () => {
  test('na field reads return the exact field typed empty', () => {
    const layouts = new ValueLayoutRegistry(MANIFEST);
    expect(userField(layouts, null, PARENT, 0)).toBeNull();
    expect(userField(layouts, null, PARENT, 1)).toBe(false);
    expect(userField(layouts, null, PARENT, 2)).toBeNull();
    expect(Number.isNaN(userField(layouts, null, CHILD, 0) as number)).toBe(
      true,
    );
  });

  test('path rebuilding changes one value while preserving prior versions', () => {
    const layouts = new ValueLayoutRegistry(MANIFEST);
    const child = newUserValue(layouts, CHILD, [1]);
    const parent = newUserValue(layouts, PARENT, [child, true, 'before']);
    const changed = rebuildUserPath(layouts, parent, PARENT, [0, 0], 9);

    expect(parent.fields).toEqual([child, true, 'before']);
    expect(
      userField(layouts, userField(layouts, parent, PARENT, 0), CHILD, 0),
    ).toBe(1);
    expect(
      userField(layouts, userField(layouts, changed, PARENT, 0), CHILD, 0),
    ).toBe(9);
    expect(userField(layouts, changed, PARENT, 2)).toBe('before');
    expect(Object.isFrozen(parent)).toBe(true);
    expect(Object.isFrozen(parent.fields)).toBe(true);
  });

  test('constructor mismatches and writes through na fail before producing a value', () => {
    const layouts = new ValueLayoutRegistry(MANIFEST);
    expect(() => newUserValue(layouts, CHILD, ['wrong'])).toThrow(
      'VALUE_LAYOUT_MISMATCH',
    );
    expect(() => rebuildUserPath(layouts, null, PARENT, [0, 0], 1)).toThrow(
      'NA_USER_VALUE_WRITE',
    );
  });
});
