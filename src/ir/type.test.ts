// Purpose: Type-domain tests — qualifier ordering rules, assignability and unification rules, and type formatting.

import {describe, expect, test} from 'vitest';
import {
  BoolType,
  NA_VALUE,
  isNaValue,
  FloatType,
  IntType,
  NaType,
  Qualifier,
  StringType,
  TypeKind,
  VoidType,
  assignable,
  formatType,
  formatTypeAndQualifier,
  isAggregateType,
  isMapKeyType,
  joinQualifiers,
  isStorableType,
  qualifierLE,
  typesEqual,
  unifyTypes,
  type Type,
  type StructType,
} from './type';

const QUALIFIERS = [
  Qualifier.Const,
  Qualifier.Input,
  Qualifier.Simple,
  Qualifier.Series,
] as const;

describe('qualifier ordering', () => {
  test('join is the later-known qualifier', () => {
    expect(joinQualifiers(Qualifier.Const, Qualifier.Series)).toBe(
      Qualifier.Series,
    );
    expect(joinQualifiers(Qualifier.Input, Qualifier.Simple)).toBe(
      Qualifier.Simple,
    );
    expect(joinQualifiers(Qualifier.Const, Qualifier.Const)).toBe(
      Qualifier.Const,
    );
  });

  test('join is commutative and associative over all elements', () => {
    for (const a of QUALIFIERS) {
      for (const b of QUALIFIERS) {
        expect(joinQualifiers(a, b)).toBe(joinQualifiers(b, a));
        for (const c of QUALIFIERS) {
          expect(joinQualifiers(joinQualifiers(a, b), c)).toBe(
            joinQualifiers(a, joinQualifiers(b, c)),
          );
        }
      }
    }
  });

  test('ordering is total and consistent with the combine rule', () => {
    for (const a of QUALIFIERS) {
      for (const b of QUALIFIERS) {
        expect(qualifierLE(a, b) || qualifierLE(b, a)).toBe(true);
        expect(qualifierLE(a, joinQualifiers(a, b))).toBe(true);
        expect(qualifierLE(b, joinQualifiers(a, b))).toBe(true);
      }
    }
  });
});

const arrayOf = (elem: Type): Type => ({kind: TypeKind.Array, elem});
const structType = (name: string): StructType => ({
  kind: TypeKind.Struct,
  name,
  fields: [{name: 'x', type: IntType}],
});

describe('assignability', () => {
  test('int widens to float, never the reverse', () => {
    expect(assignable(IntType, FloatType)).toBe(true);
    expect(assignable(FloatType, IntType)).toBe(false);
  });

  test('na is assignable to nullable types; never void, func, or bool', () => {
    expect(assignable(NaType, FloatType)).toBe(true);
    expect(assignable(NaType, StringType)).toBe(true);
    expect(assignable(NaType, arrayOf(FloatType))).toBe(true);
    expect(assignable(NaType, VoidType)).toBe(false);
    expect(assignable(NaType, BoolType)).toBe(false); // Pine v6: bool is never na
  });

  test('collections are invariant', () => {
    expect(assignable(arrayOf(IntType), arrayOf(FloatType))).toBe(false);
    expect(assignable(arrayOf(IntType), arrayOf(IntType))).toBe(true);
  });

  test('struct identity is by declaration, not structure', () => {
    const a = structType('Point');
    const b = structType('Point');
    expect(typesEqual(a, a)).toBe(true);
    expect(typesEqual(a, b)).toBe(false);
    expect(assignable(a, b)).toBe(false);
  });
});

describe('collection domains', () => {
  test('storable values, map keys, and aggregates have distinct predicates', () => {
    const point = structType('Point');
    const array = arrayOf(point);
    const tuple: Type = {kind: TypeKind.Tuple, elems: [IntType, FloatType]};

    expect(isStorableType(point)).toBe(true);
    expect(isStorableType(array)).toBe(true);
    expect(isStorableType(tuple)).toBe(false);
    expect(isStorableType(NaType)).toBe(false);

    expect(isMapKeyType(IntType)).toBe(true);
    expect(isMapKeyType(StringType)).toBe(true);
    expect(isMapKeyType(point)).toBe(false);
    expect(isMapKeyType(array)).toBe(false);

    expect(isAggregateType(point)).toBe(true);
    expect(isAggregateType(array)).toBe(true);
    expect(isAggregateType(IntType)).toBe(false);
  });
});

describe('unification', () => {
  test('numeric branches unify to float', () => {
    expect(unifyTypes(IntType, FloatType)).toBe(FloatType);
  });

  test('na adopts the other branch, except void/func/bool', () => {
    expect(unifyTypes(NaType, FloatType)).toBe(FloatType);
    expect(unifyTypes(StringType, NaType)).toBe(StringType);
    expect(unifyTypes(NaType, VoidType)).toBeNull();
    expect(unifyTypes(NaType, BoolType)).toBeNull(); // Pine v6: bool is never na
  });

  test('unrelated types do not unify', () => {
    expect(unifyTypes(BoolType, StringType)).toBeNull();
    expect(unifyTypes(arrayOf(IntType), arrayOf(FloatType))).toBeNull();
  });
});

describe('formatting', () => {
  test('composite forms', () => {
    expect(formatType(arrayOf(FloatType))).toBe('array<float>');
    expect(
      formatType({kind: TypeKind.Map, key: StringType, value: FloatType}),
    ).toBe('map<string, float>');
    expect(formatType({kind: TypeKind.Tuple, elems: [IntType, BoolType]})).toBe(
      '[int, bool]',
    );
    expect(formatType(structType('Band'))).toBe('Band');
  });

  test('two-axis display form', () => {
    expect(formatTypeAndQualifier(FloatType, Qualifier.Series)).toBe(
      'series float',
    );
    expect(formatTypeAndQualifier(StringType, Qualifier.Simple)).toBe(
      'simple string',
    );
  });
});

describe('na constant', () => {
  test('NA_VALUE is the only object-shaped constant', () => {
    expect(isNaValue(NA_VALUE)).toBe(true);
    expect(isNaValue(1)).toBe(false);
    expect(isNaValue('na')).toBe(false);
    expect(isNaValue(false)).toBe(false);
  });
});
