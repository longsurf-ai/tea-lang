// Purpose: Canonical semantic declaration objects stored in checker scopes and referenced by Info definition/use facts.

import type {
  ConstValue,
  EnumType,
  NameStorage,
  Qualifier,
  Type,
  UserType,
} from '../ir/type';
import type {
  EnumMember,
  FieldDecl,
  FuncDecl,
  MethodDecl,
} from '../syntax/nodes';
import type {CheckedDefaultExpression} from './info';
import type {Package} from './package';
import type {Scope} from './scope';

export const ObjectKind = {
  Variable: 'variable',
  Function: 'function',
  UserType: 'userType',
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

interface FunctionObjectBase {
  readonly kind: typeof ObjectKind.Function;
  readonly pkg: Package;
  readonly exported: boolean;
  readonly name: string;
  readonly displayName: string;
  // The scope the template's body resolves against when instantiated: the
  // user package scope, or the owning library's scope.
  readonly base: Scope;
}

export interface FreeFunctionObject extends FunctionObjectBase {
  readonly decl: FuncDecl;
  readonly receiver: null;
  // A null entry is a genuinely polymorphic source parameter. Written
  // annotations are resolved once at package elaboration and reused by every
  // concrete stencil.
  readonly declaredParams: readonly ({
    readonly type: Type;
    readonly qualifier: Qualifier | null;
  } | null)[];
}

export interface MethodObject extends FunctionObjectBase {
  readonly decl: MethodDecl;
  readonly receiver: {
    readonly owner: UserTypeObject;
    readonly mode: ReceiverMode;
  };
  readonly declaredParams: readonly {
    readonly type: Type;
    readonly qualifier: Qualifier | null;
  }[];
  // Defaults rejected by the declaration-owner scan. Calls may still supply
  // those parameters explicitly for poison-resistant checking, but omission
  // never creates a callable/lowerable resolution.
  readonly invalidDefaults: ReadonlySet<number>;
  readonly declaredResult: Type;
}

export type FunctionObject = FreeFunctionObject | MethodObject;

export type ReceiverMode = 'mutable' | 'const';

export interface UserTypeObject {
  readonly kind: typeof ObjectKind.UserType;
  readonly pkg: Package;
  readonly exported: boolean;
  readonly name: string;
  readonly type: UserType;
  readonly fields: readonly FieldObject[];
  readonly methods: readonly MethodObject[];
}

export interface FieldObject {
  readonly kind: typeof ObjectKind.Field;
  readonly owner: UserTypeObject;
  readonly index: number;
  readonly name: string;
  readonly type: Type;
  readonly decl: FieldDecl;
  // @agent invariant: the checker assigns this slot exactly once when the
  // source-order pass reaches the owning type declaration. It is read-only
  // after CheckedPackage publication.
  defaultValue: CheckedDefaultExpression | null;
}

export interface EnumObject {
  readonly kind: typeof ObjectKind.Enum;
  readonly pkg: Package;
  readonly exported: boolean;
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
  | UserTypeObject
  | FieldObject
  | EnumObject
  | EnumMemberObject
  | PackageNameObject
  | BuiltinObject;
