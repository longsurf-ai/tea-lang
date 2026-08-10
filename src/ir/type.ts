// Purpose: Tea type domain — the single type system shared by checker, IR, and Program: value types crossed with the qualifier ordering.

// ---- qualifiers -------------------------------------------------------------

// The qualifier axis answers WHEN a value becomes known, as an ordering:
// combining values takes the later-known qualifier of the operands. It is
// orthogonal to the value type: `series color` is a color knowable only per
// bar. History is a property of this axis — only series-qualified values
// have a time dimension.
export const Qualifier = {
  Const: 'const', // known at compile time
  Input: 'input', // fixed when the runtime binds inputs
  Simple: 'simple', // fixed before the first bar
  Series: 'series', // may differ on every bar
} as const;

export type Qualifier = (typeof Qualifier)[keyof typeof Qualifier];

// Persistence is semantic declaration metadata shared by checking and IR:
// perBar reinitializes each iteration, var carries the prior committed value,
// and varip additionally persists across provisional executions.
export const Storage = {
  PerBar: 'perBar',
  Var: 'var',
  Varip: 'varip',
} as const;

export type NameStorage = (typeof Storage)[keyof typeof Storage];

const QUALIFIER_RANK: Record<Qualifier, number> = {
  const: 0,
  input: 1,
  simple: 2,
  series: 3,
};

// a ⊑ b: a value known earlier may be used where a later-known value is
// expected (upward promotion only).
export function qualifierLE(a: Qualifier, b: Qualifier): boolean {
  return QUALIFIER_RANK[a] <= QUALIFIER_RANK[b];
}

// The later-known of two qualifiers — the qualifier of any combination.
export function joinQualifiers(a: Qualifier, b: Qualifier): Qualifier {
  return QUALIFIER_RANK[a] >= QUALIFIER_RANK[b] ? a : b;
}

// ---- value types ------------------------------------------------------------

export const TypeKind = {
  // The checker's poison type: the result of an expression that already
  // failed. It is assignable to and from everything so one error never
  // cascades, and it never reaches a Program — compile()'s phase barrier
  // stops noding when the checker reported errors.
  Invalid: 'Invalid',
  Int: 'Int',
  Float: 'Float',
  Bool: 'Bool',
  String: 'String',
  Color: 'Color',
  // The type of an expression used only for its effects (plot(...)).
  Void: 'Void',
  // The type of a bare `na` before context resolves it; assignable to every
  // nullable value type. Every value type is nullable except Void, Func, and
  // Bool (Pine v6: booleans are never na).
  Na: 'Na',
  // Drawing object handles (values are host handles; heap state is
  // runtime-owned).
  Line: 'Line',
  Label: 'Label',
  Box: 'Box',
  Table: 'Table',
  Polyline: 'Polyline',
  Linefill: 'Linefill',
  // Declarative-output references (compile-time ids consumed by fill());
  // not runtime heap handles — no COW or rollback participation.
  Plot: 'Plot',
  Hline: 'Hline',
  // Collections (heap objects with value-semantic history via runtime COW).
  Array: 'Array',
  Matrix: 'Matrix',
  Map: 'Map',
  // Named types, identified by declaration identity (object reference).
  Udt: 'Udt',
  Enum: 'Enum',
  // Multi-value shapes.
  Tuple: 'Tuple',
  // A concrete (fully instantiated) function signature. Function templates
  // (untyped params) are a checker concern, not a type.
  Func: 'Func',
} as const;

export type TypeKindName = (typeof TypeKind)[keyof typeof TypeKind];

export type PrimitiveKind =
  | typeof TypeKind.Int
  | typeof TypeKind.Float
  | typeof TypeKind.Bool
  | typeof TypeKind.String
  | typeof TypeKind.Color
  | typeof TypeKind.Void
  | typeof TypeKind.Na;

export type HandleKind =
  | typeof TypeKind.Line
  | typeof TypeKind.Label
  | typeof TypeKind.Box
  | typeof TypeKind.Table
  | typeof TypeKind.Polyline
  | typeof TypeKind.Linefill;

export interface InvalidType {
  readonly kind: typeof TypeKind.Invalid;
}

export interface PrimitiveType {
  readonly kind: PrimitiveKind;
}

export interface HandleType {
  readonly kind: HandleKind;
}

export type OutputRefKind = typeof TypeKind.Plot | typeof TypeKind.Hline;

export interface OutputRefType {
  readonly kind: OutputRefKind;
}

export interface ArrayType {
  readonly kind: typeof TypeKind.Array;
  readonly elem: Type;
}

export interface MatrixType {
  readonly kind: typeof TypeKind.Matrix;
  readonly elem: Type;
}

export interface MapType {
  readonly kind: typeof TypeKind.Map;
  readonly key: Type;
  readonly value: Type;
}

export interface UdtField {
  readonly name: string;
  readonly type: Type;
  // Pine v6 allows varip fields: exempt from rollback while sibling fields
  // roll back — per-field granularity the runtime's Time Machine must know.
  readonly varip: boolean;
}

// One UdtType instance exists per `type` declaration; identity is reference
// identity, never structural.
export interface UdtType {
  readonly kind: typeof TypeKind.Udt;
  readonly name: string;
  readonly fields: readonly UdtField[];
}

// Titles are runtime-visible (str.tostring returns the title; input.enum
// displays it), so they live on the type; identity stays by declaration.
export interface EnumMemberType {
  readonly name: string;
  readonly title: string;
}

export interface EnumType {
  readonly kind: typeof TypeKind.Enum;
  readonly name: string;
  readonly members: readonly EnumMemberType[];
}

export interface TupleType {
  readonly kind: typeof TypeKind.Tuple;
  readonly elems: readonly Type[];
}

export interface FuncParamType {
  readonly name: string;
  readonly type: Type;
  readonly qualifierCap: Qualifier;
}

export interface FuncType {
  readonly kind: typeof TypeKind.Func;
  readonly params: readonly FuncParamType[];
  readonly result: Type;
  readonly resultQualifier: Qualifier;
}

export type Type =
  | InvalidType
  | PrimitiveType
  | HandleType
  | OutputRefType
  | ArrayType
  | MatrixType
  | MapType
  | UdtType
  | EnumType
  | TupleType
  | FuncType;

// Interned primitives and handles — compare by reference or kind, either
// works.
export const InvalidType: Type = {kind: TypeKind.Invalid};
export const IntType: Type = {kind: TypeKind.Int};
export const FloatType: Type = {kind: TypeKind.Float};
export const BoolType: Type = {kind: TypeKind.Bool};
export const StringType: Type = {kind: TypeKind.String};
export const ColorType: Type = {kind: TypeKind.Color};
export const VoidType: Type = {kind: TypeKind.Void};
export const NaType: Type = {kind: TypeKind.Na};
export const LineType: Type = {kind: TypeKind.Line};
export const LabelType: Type = {kind: TypeKind.Label};
export const BoxType: Type = {kind: TypeKind.Box};
export const TableType: Type = {kind: TypeKind.Table};
export const PolylineType: Type = {kind: TypeKind.Polyline};
export const LinefillType: Type = {kind: TypeKind.Linefill};
export const PlotType: Type = {kind: TypeKind.Plot};
export const HlineType: Type = {kind: TypeKind.Hline};

// ---- constants --------------------------------------------------------------

// Compile-time constant values. Colors are canonical '#rrggbb' / '#rrggbbaa'
// strings; int vs float is disambiguated by the accompanying Type. `na` is a
// first-class constant — a branded singleton, deliberately not null, so that
// TypeAndValue.value === null keeps meaning "not a constant". Numeric NaN is
// the runtime encoding only; checker folders canonicalize it to NA_VALUE.
export interface NaValue {
  readonly na: true;
}
export const NA_VALUE: NaValue = Object.freeze({na: true});
export type ConstValue = number | string | boolean | NaValue;

export function isNaValue(value: ConstValue): value is NaValue {
  return typeof value === 'object';
}

// The checker's currency (types2 TypeAndValue with Tea's extra axis): what an
// expression is, when it is known, and — when const-qualified — what it
// equals.
export interface TypeAndValue {
  readonly type: Type;
  readonly qualifier: Qualifier;
  readonly value: ConstValue | null;
}

// ---- relations --------------------------------------------------------------

export function typesEqual(a: Type, b: Type): boolean {
  if (a === b) {
    return true;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case TypeKind.Array:
    case TypeKind.Matrix:
      return typesEqual(a.elem, (b as ArrayType | MatrixType).elem);
    case TypeKind.Map: {
      const other = b as MapType;
      return typesEqual(a.key, other.key) && typesEqual(a.value, other.value);
    }
    case TypeKind.Tuple: {
      const other = b as TupleType;
      return (
        a.elems.length === other.elems.length &&
        a.elems.every((elem, i) => typesEqual(elem, other.elems[i]))
      );
    }
    case TypeKind.Func: {
      const other = b as FuncType;
      return (
        a.params.length === other.params.length &&
        a.params.every(
          (param, i) =>
            typesEqual(param.type, other.params[i].type) &&
            param.qualifierCap === other.params[i].qualifierCap,
        ) &&
        typesEqual(a.result, other.result) &&
        a.resultQualifier === other.resultQualifier
      );
    }
    case TypeKind.Udt:
    case TypeKind.Enum:
      return false; // reference identity only, handled by a === b above
    default:
      return true; // primitives and handles: kind equality suffices
  }
}

// Value-type assignability: equality, the sole implicit widening int → float,
// and `na` into any nullable type. Collections are invariant.
export function assignable(from: Type, to: Type): boolean {
  if (from.kind === TypeKind.Invalid || to.kind === TypeKind.Invalid) {
    return true;
  }
  if (typesEqual(from, to)) {
    return true;
  }
  if (from.kind === TypeKind.Int && to.kind === TypeKind.Float) {
    return true;
  }
  if (from.kind === TypeKind.Na) {
    return (
      to.kind !== TypeKind.Void &&
      to.kind !== TypeKind.Func &&
      to.kind !== TypeKind.Bool
    );
  }
  return false;
}

// The type of a value join (if/switch branches, ?:): null when the branches
// cannot unify.
export function unifyTypes(a: Type, b: Type): Type | null {
  // Poison absorbs: unifying with an already-failed side yields the good side.
  if (a.kind === TypeKind.Invalid) {
    return b;
  }
  if (b.kind === TypeKind.Invalid) {
    return a;
  }
  if (typesEqual(a, b)) {
    return a;
  }
  const naUnifiable = (t: Type): boolean =>
    t.kind !== TypeKind.Void &&
    t.kind !== TypeKind.Func &&
    t.kind !== TypeKind.Bool;
  if (a.kind === TypeKind.Na) {
    return naUnifiable(b) ? b : null;
  }
  if (b.kind === TypeKind.Na) {
    return naUnifiable(a) ? a : null;
  }
  const numeric = (t: Type): boolean =>
    t.kind === TypeKind.Int || t.kind === TypeKind.Float;
  if (numeric(a) && numeric(b)) {
    return FloatType;
  }
  return null;
}

// ---- formatting -------------------------------------------------------------

const PRIMITIVE_NAMES: Record<
  PrimitiveKind | HandleKind | OutputRefKind,
  string
> = {
  Int: 'int',
  Float: 'float',
  Bool: 'bool',
  String: 'string',
  Color: 'color',
  Void: 'void',
  Na: 'na',
  Line: 'line',
  Label: 'label',
  Box: 'box',
  Table: 'table',
  Polyline: 'polyline',
  Linefill: 'linefill',
  Plot: 'plot',
  Hline: 'hline',
};

export function formatType(t: Type): string {
  switch (t.kind) {
    case TypeKind.Invalid:
      return '<invalid>';
    case TypeKind.Array:
      return `array<${formatType(t.elem)}>`;
    case TypeKind.Matrix:
      return `matrix<${formatType(t.elem)}>`;
    case TypeKind.Map:
      return `map<${formatType(t.key)}, ${formatType(t.value)}>`;
    case TypeKind.Udt:
    case TypeKind.Enum:
      return t.name;
    case TypeKind.Tuple:
      return `[${t.elems.map(formatType).join(', ')}]`;
    case TypeKind.Func:
      return `(${t.params
        .map(p => `${p.qualifierCap} ${formatType(p.type)}`)
        .join(', ')}) => ${t.resultQualifier} ${formatType(t.result)}`;
    default:
      return PRIMITIVE_NAMES[t.kind];
  }
}

// `series float`, `simple string` — the full two-axis display form.
export function formatTypeAndQualifier(
  type: Type,
  qualifier: Qualifier,
): string {
  return `${qualifier} ${formatType(type)}`;
}
