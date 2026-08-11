// Purpose: Type-domain tests — qualifier ordering rules, assignability and unification rules, and type formatting.

import {describe, expect, test} from 'bun:test';
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
  type UserType,
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
        expect(qualifierLE(a, b) || qualifierLE(b, a)).toBeTrue();
        expect(qualifierLE(a, joinQualifiers(a, b))).toBeTrue();
        expect(qualifierLE(b, joinQualifiers(a, b))).toBeTrue();
      }
    }
  });
});

const arrayOf = (elem: Type): Type => ({kind: TypeKind.Array, elem});
const userType = (name: string): UserType => ({
  kind: TypeKind.UserType,
  name,
  fields: [{name: 'x', type: IntType}],
});

describe('assignability', () => {
  test('int widens to float, never the reverse', () => {
    expect(assignable(IntType, FloatType)).toBeTrue();
    expect(assignable(FloatType, IntType)).toBeFalse();
  });

  test('na is assignable to nullable types; never void, func, or bool', () => {
    expect(assignable(NaType, FloatType)).toBeTrue();
    expect(assignable(NaType, StringType)).toBeTrue();
    expect(assignable(NaType, arrayOf(FloatType))).toBeTrue();
    expect(assignable(NaType, VoidType)).toBeFalse();
    expect(assignable(NaType, BoolType)).toBeFalse(); // Pine v6: bool is never na
  });

  test('collections are invariant', () => {
    expect(assignable(arrayOf(IntType), arrayOf(FloatType))).toBeFalse();
    expect(assignable(arrayOf(IntType), arrayOf(IntType))).toBeTrue();
  });

  test('user-type identity is by declaration, not structure', () => {
    const a = userType('Point');
    const b = userType('Point');
    expect(typesEqual(a, a)).toBeTrue();
    expect(typesEqual(a, b)).toBeFalse();
    expect(assignable(a, b)).toBeFalse();
  });
});

describe('collection domains', () => {
  test('storable values, map keys, and aggregates have distinct predicates', () => {
    const point = userType('Point');
    const array = arrayOf(point);
    const tuple: Type = {kind: TypeKind.Tuple, elems: [IntType, FloatType]};

    expect(isStorableType(point)).toBeTrue();
    expect(isStorableType(array)).toBeTrue();
    expect(isStorableType(tuple)).toBeFalse();
    expect(isStorableType(NaType)).toBeFalse();

    expect(isMapKeyType(IntType)).toBeTrue();
    expect(isMapKeyType(StringType)).toBeTrue();
    expect(isMapKeyType(point)).toBeFalse();
    expect(isMapKeyType(array)).toBeFalse();

    expect(isAggregateType(point)).toBeTrue();
    expect(isAggregateType(array)).toBeTrue();
    expect(isAggregateType(IntType)).toBeFalse();
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
    expect(formatType(userType('Band'))).toBe('Band');
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
    expect(isNaValue(NA_VALUE)).toBeTrue();
    expect(isNaValue(1)).toBeFalse();
    expect(isNaValue('na')).toBeFalse();
    expect(isNaValue(false)).toBeFalse();
  });
});
