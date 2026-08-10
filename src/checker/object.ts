// Purpose: Canonical semantic declaration objects stored in checker scopes and referenced by Info definition/use facts.

import type {
  ConstValue,
  EnumType,
  NameStorage,
  Qualifier,
  Type,
  UdtType,
} from '../ir/type';
import type {EnumMember, FieldDecl, FuncDecl} from '../syntax/nodes';
import type {CheckedDefaultExpression} from './info';
import type {Package} from './package';
import type {Scope} from './scope';

export const ObjectKind = {
  Variable: 'variable',
  Function: 'function',
  Udt: 'udt',
  Field: 'field',
  Enum: 'enum',
  EnumMember: 'enumMember',
  PackageName: 'packageName',
  Builtin: 'builtin',
} as const;

export interface VariableObject {
  readonly kind: typeof ObjectKind.Variable;
  readonly name: string;
  readonly storage: NameStorage;
  readonly constDecl: boolean;
  type: Type;
  qualifier: Qualifier;
  constValue: ConstValue | null;
}

export interface FunctionObject {
  readonly kind: typeof ObjectKind.Function;
  readonly name: string;
  readonly displayName: string;
  readonly decl: FuncDecl;
  // The scope the template's body resolves against when instantiated: the
  // user package scope, or the owning library's scope.
  readonly base: Scope;
}

export interface UdtObject {
  readonly kind: typeof ObjectKind.Udt;
  readonly name: string;
  readonly type: UdtType;
  readonly fields: readonly FieldObject[];
}

export interface FieldObject {
  readonly kind: typeof ObjectKind.Field;
  readonly name: string;
  readonly type: Type;
  readonly varip: boolean;
  readonly decl: FieldDecl;
  readonly defaultValue: CheckedDefaultExpression | null;
}

export interface EnumObject {
  readonly kind: typeof ObjectKind.Enum;
  readonly name: string;
  readonly type: EnumType;
  readonly members: readonly EnumMemberObject[];
}

export interface EnumMemberObject {
  readonly kind: typeof ObjectKind.EnumMember;
  readonly name: string;
  readonly decl: EnumMember;
  readonly owner: EnumObject;
}

export interface PackageNameObject {
  readonly kind: typeof ObjectKind.PackageName;
  readonly name: string;
  readonly pkg: Package;
}

export interface BuiltinObject {
  readonly kind: typeof ObjectKind.Builtin;
  readonly name: string;
  readonly hostId: string;
  readonly type: Type;
  readonly qualifier: Qualifier;
  readonly value: ConstValue | null;
}

export type Object =
  | VariableObject
  | FunctionObject
  | UdtObject
  | FieldObject
  | EnumObject
  | EnumMemberObject
  | PackageNameObject
  | BuiltinObject;
