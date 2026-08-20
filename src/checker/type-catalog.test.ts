// Purpose: Lock the checker-owned public/internal partition of Tea's type domain and its annotation/collection projections.

import {describe, expect, test} from 'vitest';
import {TypeKind} from '../ir/type';
import {
  BUILTIN_ANNOTATION_TYPES,
  COLLECTION_TYPE_CATALOG,
  INTERNAL_TYPE_KINDS,
  PUBLIC_TYPE_CATALOG,
} from './type-catalog';

describe('public type catalog', () => {
  test('partitions every type kind exactly once', () => {
    const publicKinds = PUBLIC_TYPE_CATALOG.map(type => type.typeKind);
    const projected = [...publicKinds, ...INTERNAL_TYPE_KINDS];
    expect(new Set(projected).size).toBe(projected.length);
    expect([...new Set(projected)].sort()).toEqual(
      Object.values(TypeKind).sort(),
    );
  });

  test('owns all writable builtin and collection type names', () => {
    expect([...BUILTIN_ANNOTATION_TYPES.keys()]).toEqual([
      'int',
      'float',
      'bool',
      'string',
      'color',
      'line',
      'label',
      'box',
      'table',
      'polyline',
      'linefill',
    ]);
    expect([...COLLECTION_TYPE_CATALOG.keys()]).toEqual([
      'array',
      'matrix',
      'map',
    ]);
  });
});
