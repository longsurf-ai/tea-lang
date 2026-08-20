// Purpose: Checker-owned catalog of implemented source-facing Tea type forms; compiler-only representations are explicitly excluded.

import {
  BoolType,
  BoxType,
  ColorType,
  FloatType,
  IntType,
  LabelType,
  LinefillType,
  LineType,
  PolylineType,
  StringType,
  TableType,
  TypeKind,
  VoidType,
  type Type,
  type TypeKindName,
} from '../ir/type';

interface PublicTypeBase {
  readonly name: string;
  readonly forms: readonly string[];
  readonly summary: string;
  readonly typeKind: TypeKindName;
}

export interface AnnotationTypeDescriptor extends PublicTypeBase {
  readonly kind: 'annotation';
  readonly type: Type;
}

export type CollectionTypeName = 'array' | 'matrix' | 'map';
export type CollectionTypeConstraint = 'storable' | 'map-key';

export interface CollectionTypeDescriptor extends PublicTypeBase {
  readonly kind: 'collection';
  readonly name: CollectionTypeName;
  readonly typeParams: readonly {
    readonly name: string;
    readonly constraint: CollectionTypeConstraint;
  }[];
}

export interface DeclarationTypeDescriptor extends PublicTypeBase {
  readonly kind: 'declaration';
}

export interface ReferenceOnlyTypeDescriptor extends PublicTypeBase {
  readonly kind: 'reference-only';
  readonly methodResultType?: Type;
}

export type PublicTypeDescriptor =
  | AnnotationTypeDescriptor
  | CollectionTypeDescriptor
  | DeclarationTypeDescriptor
  | ReferenceOnlyTypeDescriptor;

// @agent invariant: This catalog is the complete public projection of Tea's
// implemented type domain. Adding a source-facing TypeKind requires a
// descriptor; compiler poison and non-source function signatures stay in the
// explicit omission list below.
export const PUBLIC_TYPE_CATALOG: readonly PublicTypeDescriptor[] = [
  {
    kind: 'annotation',
    name: 'int',
    forms: ['int'],
    summary: 'Integer value type.',
    typeKind: TypeKind.Int,
    type: IntType,
  },
  {
    kind: 'annotation',
    name: 'float',
    forms: ['float'],
    summary: 'Floating-point value type.',
    typeKind: TypeKind.Float,
    type: FloatType,
  },
  {
    kind: 'annotation',
    name: 'bool',
    forms: ['bool'],
    summary: 'Boolean value type. Boolean values are never na.',
    typeKind: TypeKind.Bool,
    type: BoolType,
  },
  {
    kind: 'annotation',
    name: 'string',
    forms: ['string'],
    summary: 'String value type.',
    typeKind: TypeKind.String,
    type: StringType,
  },
  {
    kind: 'annotation',
    name: 'color',
    forms: ['color'],
    summary: 'Color value type.',
    typeKind: TypeKind.Color,
    type: ColorType,
  },
  {
    kind: 'annotation',
    name: 'line',
    forms: ['line'],
    summary: 'Drawing-object line handle type.',
    typeKind: TypeKind.Line,
    type: LineType,
  },
  {
    kind: 'annotation',
    name: 'label',
    forms: ['label'],
    summary: 'Drawing-object label handle type.',
    typeKind: TypeKind.Label,
    type: LabelType,
  },
  {
    kind: 'annotation',
    name: 'box',
    forms: ['box'],
    summary: 'Drawing-object box handle type.',
    typeKind: TypeKind.Box,
    type: BoxType,
  },
  {
    kind: 'annotation',
    name: 'table',
    forms: ['table'],
    summary: 'Drawing-object table handle type.',
    typeKind: TypeKind.Table,
    type: TableType,
  },
  {
    kind: 'annotation',
    name: 'polyline',
    forms: ['polyline'],
    summary: 'Drawing-object polyline handle type.',
    typeKind: TypeKind.Polyline,
    type: PolylineType,
  },
  {
    kind: 'annotation',
    name: 'linefill',
    forms: ['linefill'],
    summary: 'Drawing-object line-fill handle type.',
    typeKind: TypeKind.Linefill,
    type: LinefillType,
  },
  {
    kind: 'collection',
    name: 'array',
    forms: ['array<T>', 'T[]'],
    summary: 'Ordered collection with one storable element type.',
    typeKind: TypeKind.Array,
    typeParams: [{name: 'T', constraint: 'storable'}],
  },
  {
    kind: 'collection',
    name: 'matrix',
    forms: ['matrix<T>'],
    summary: 'Two-dimensional collection with one storable element type.',
    typeKind: TypeKind.Matrix,
    typeParams: [{name: 'T', constraint: 'storable'}],
  },
  {
    kind: 'collection',
    name: 'map',
    forms: ['map<K, V>'],
    summary: 'Key/value collection with constrained key and value types.',
    typeKind: TypeKind.Map,
    typeParams: [
      {name: 'K', constraint: 'map-key'},
      {name: 'V', constraint: 'storable'},
    ],
  },
  {
    kind: 'declaration',
    name: 'enum',
    forms: ['enum Name'],
    summary: 'Nominal enum type declared by a Tea program.',
    typeKind: TypeKind.Enum,
  },
  {
    kind: 'declaration',
    name: 'struct',
    forms: ['struct Name', 'type Name'],
    summary: 'Nominal reference type declared with struct or block-form type.',
    typeKind: TypeKind.Struct,
  },
  {
    kind: 'reference-only',
    name: 'na',
    forms: ['na'],
    summary:
      'Missing-value type before context resolves the na literal to a concrete type; it is not a type annotation.',
    typeKind: TypeKind.Na,
  },
  {
    kind: 'reference-only',
    name: 'tuple',
    forms: ['[T1, T2, ...]'],
    summary:
      'Transport-only multi-value shape used for returns and declaration destructuring; it is not a type annotation.',
    typeKind: TypeKind.Tuple,
  },
  {
    kind: 'reference-only',
    name: 'void',
    forms: ['void'],
    summary:
      'No-value result type. It is writable only as a method result annotation.',
    typeKind: TypeKind.Void,
    methodResultType: VoidType,
  },
  {
    kind: 'reference-only',
    name: 'plot',
    forms: ['plot'],
    summary:
      'Compile-time output reference returned by plot() and consumed by fill(); it is not a type annotation.',
    typeKind: TypeKind.Plot,
  },
  {
    kind: 'reference-only',
    name: 'hline',
    forms: ['hline'],
    summary:
      'Compile-time output reference returned by hline() and consumed by fill(); it is not a type annotation.',
    typeKind: TypeKind.Hline,
  },
];

export const INTERNAL_TYPE_KINDS: readonly TypeKindName[] = [
  TypeKind.Invalid,
  TypeKind.Func,
];

const annotationTypes = new Map<string, Type>();
const collectionTypes = new Map<CollectionTypeName, CollectionTypeDescriptor>();
const methodResultTypes = new Map<string, Type>();

for (const descriptor of PUBLIC_TYPE_CATALOG) {
  if (descriptor.kind === 'annotation') {
    annotationTypes.set(descriptor.name, descriptor.type);
  } else if (descriptor.kind === 'collection') {
    collectionTypes.set(descriptor.name, descriptor);
  } else if (
    descriptor.kind === 'reference-only' &&
    descriptor.methodResultType !== undefined
  ) {
    methodResultTypes.set(descriptor.name, descriptor.methodResultType);
  }
}

export const BUILTIN_ANNOTATION_TYPES: ReadonlyMap<string, Type> =
  annotationTypes;
export const COLLECTION_TYPE_CATALOG: ReadonlyMap<
  string,
  CollectionTypeDescriptor
> = collectionTypes;
export const METHOD_RESULT_TYPES: ReadonlyMap<string, Type> = methodResultTypes;
