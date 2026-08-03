// Purpose: Type-domain tests — qualifier lattice laws, assignability and unification rules, and type formatting.

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
  joinQualifiers,
  qualifierLE,
  typesEqual,
  unifyTypes,
  type Type,
  type UdtType,
} from './type';

const QUALIFIERS = [
  Qualifier.Const,
  Qualifier.Input,
  Qualifier.Simple,
  Qualifier.Series,
] as const;

describe('qualifier lattice', () => {
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

  test('ordering is total and join-consistent', () => {
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
const udt = (name: string): UdtType => ({
  kind: TypeKind.Udt,
  name,
  fields: [{name: 'x', type: IntType, varip: false}],
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

  test('udt identity is by declaration, not structure', () => {
    const a = udt('Point');
    const b = udt('Point');
    expect(typesEqual(a, a)).toBeTrue();
    expect(typesEqual(a, b)).toBeFalse();
    expect(assignable(a, b)).toBeFalse();
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
    expect(formatType(udt('Band'))).toBe('Band');
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
