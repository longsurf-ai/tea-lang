// Purpose: Canonical semantic declaration objects stored in checker scopes and referenced by Info definition/use facts.

import {formatType, Qualifier, typesEqual} from '../ir/type';
import type {
  ConstValue,
  EnumType,
  Storage,
  Qualifier as QualifierName,
  Type,
  StructType,
} from '../ir/type';
import type {
  EnumMember,
  FieldDecl,
  FuncDecl,
  InterfaceDecl,
  InterfaceMethodDecl,
  MethodDecl,
} from '../syntax/nodes';
import type {CheckedDefaultExpression} from './info';
import type {Info} from './info';
import type {BuiltinBinding} from './catalog';
import type {Package} from './package';
import type {Scope} from './scope';

export const ObjectKind = {
  Variable: 'variable',
  Function: 'function',
  Interface: 'interface',
  InterfaceMethod: 'interfaceMethod',
  GenericStruct: 'genericStruct',
  TypeParameter: 'typeParameter',
  Struct: 'struct',
  Field: 'field',
  Enum: 'enum',
  EnumMember: 'enumMember',
  PackageName: 'packageName',
  Builtin: 'builtin',
} as const;

export interface VariableObject {
  readonly kind: typeof ObjectKind.Variable;
  readonly name: string;
  readonly storage: Storage;
  readonly constDecl: boolean;
  // Non-null only for a library-root runtime global. Ordinary script globals
  // and function locals stay context-owned without package privileges.
  packageGlobal: {
    readonly pkg: Package;
    readonly decl: import('../syntax/nodes').DeclStmt;
    readonly sourceOrder: number;
  } | null;
  type: Type;
  qualifier: QualifierName;
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
    readonly qualifier: QualifierName | null;
  } | null)[];
}

export interface MethodObject extends FunctionObjectBase {
  readonly decl: MethodDecl;
  readonly receiver: {
    readonly owner: StructObject;
    readonly mode: ReceiverMode;
  };
  readonly declaredParams: readonly {
    readonly type: Type;
    readonly qualifier: QualifierName | null;
  }[];
  // Defaults rejected by the declaration-owner scan. Calls may still supply
  // those parameters explicitly for poison-resistant checking, but omission
  // never creates a callable/lowerable resolution.
  readonly invalidDefaults: ReadonlySet<number>;
  readonly declaredResult: Type;
  // Concrete substitution owned by this specialized method declaration.
  // Non-generic methods carry null. The map is restored while checking the
  // method body, so annotation occurrences never publish checker-only types.
  readonly substitutions: ReadonlyMap<string, TypeSubstitution> | null;
}

export type FunctionObject = FreeFunctionObject | MethodObject;

export type ReceiverMode = 'mutable' | 'const';

// Interfaces are checker-only method sets. They are declaration objects, but
// deliberately have no Type: an interface can constrain a generic template
// without ever becoming a source value or a Program/runtime type.
export interface InterfaceObject {
  readonly kind: typeof ObjectKind.Interface;
  readonly pkg: Package;
  readonly exported: boolean;
  readonly name: string;
  readonly decl: InterfaceDecl;
  readonly methods: readonly InterfaceMethodObject[];
}

export interface InterfaceMethodObject {
  readonly kind: typeof ObjectKind.InterfaceMethod;
  readonly owner: InterfaceObject;
  readonly name: string;
  readonly decl: InterfaceMethodDecl;
  readonly receiverMode: ReceiverMode;
  readonly params: readonly {
    readonly type: Type;
    readonly qualifier: QualifierName | null;
  }[];
  readonly result: Type;
}

export interface TypeParameterObject {
  readonly kind: typeof ObjectKind.TypeParameter;
  readonly owner: GenericStructObject;
  readonly index: number;
  readonly name: string;
  readonly decl: import('../syntax/nodes').TypeParam;
  readonly constraint: InterfaceObject;
}

export interface TypeSubstitution {
  readonly parameter: TypeParameterObject;
  readonly object: StructObject;
}

export interface GenericInstantiation {
  readonly template: GenericStructObject;
  readonly typeArgs: readonly StructObject[];
  readonly object: StructObject;
  readonly info: Info;
}

export interface GenericStructObject {
  readonly kind: typeof ObjectKind.GenericStruct;
  readonly pkg: Package;
  readonly exported: boolean;
  readonly name: string;
  readonly decl: import('../syntax/nodes').StructDecl;
  readonly base: Scope;
  readonly typeParams: readonly TypeParameterObject[];
  readonly instances: readonly GenericInstantiation[];
  // Checker-only facts for a template that has no concrete specialization in
  // this compilation. Concrete instances retain their own distinct Info.
  readonly validationInfo: Info;
}

export interface StructObject {
  readonly kind: typeof ObjectKind.Struct;
  readonly pkg: Package;
  readonly exported: boolean;
  readonly name: string;
  readonly type: StructType;
  readonly fields: readonly FieldObject[];
  readonly methods: readonly MethodObject[];
}

export interface FieldObject {
  readonly kind: typeof ObjectKind.Field;
  readonly owner: StructObject;
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

interface BuiltinObjectBase {
  readonly kind: typeof ObjectKind.Builtin;
  readonly name: string;
  readonly type: Type;
}

export interface BuiltinConstObject extends BuiltinObjectBase {
  readonly binding: null;
  readonly qualifier: typeof Qualifier.Const;
  readonly value: ConstValue;
}

export interface BuiltinBoundObject extends BuiltinObjectBase {
  readonly binding: BuiltinBinding;
  readonly qualifier: Exclude<QualifierName, typeof Qualifier.Const>;
  readonly value: null;
}

export type BuiltinObject = BuiltinConstObject | BuiltinBoundObject;

export type Object =
  | VariableObject
  | FunctionObject
  | InterfaceObject
  | InterfaceMethodObject
  | GenericStructObject
  | TypeParameterObject
  | StructObject
  | FieldObject
  | EnumObject
  | EnumMemberObject
  | PackageNameObject
  | BuiltinObject;

// V1 interface satisfaction is an exact, static method-set relation. Method
// parameter names are documentation only; every callable property of the
// signature must match, and extra concrete methods are allowed.
export function satisfies(
  concrete: StructObject,
  required: InterfaceObject,
): boolean {
  return required.methods.every(want => {
    const got = concrete.methods.find(method => method.name === want.name);
    return (
      got !== undefined &&
      got.receiver.mode === want.receiverMode &&
      got.declaredParams.length === want.params.length &&
      got.declaredParams.every(
        (param, index) =>
          param.qualifier === want.params[index].qualifier &&
          typesEqual(param.type, want.params[index].type),
      ) &&
      typesEqual(got.declaredResult, want.result)
    );
  });
}

export function satisfactionError(
  concrete: StructObject,
  required: InterfaceObject,
): string | null {
  for (const want of required.methods) {
    const got = concrete.methods.find(method => method.name === want.name);
    const prefix = `${concrete.name} does not satisfy ${required.name}: method '${want.name}'`;
    if (got === undefined) {
      return `${concrete.name} does not satisfy ${required.name}: missing method '${want.name}'`;
    }
    if (got.declaredParams.length !== want.params.length) {
      return `${prefix} has ${got.declaredParams.length} parameters, want ${want.params.length}`;
    }
    for (const [index, parameter] of got.declaredParams.entries()) {
      const expected = want.params[index];
      if (!typesEqual(parameter.type, expected.type)) {
        return `${prefix} parameter ${index + 1} has type ${formatType(parameter.type)}, want ${formatType(expected.type)}`;
      }
      if (parameter.qualifier !== expected.qualifier) {
        return `${prefix} parameter ${index + 1} has qualifier ${parameter.qualifier ?? 'unqualified'}, want ${expected.qualifier ?? 'unqualified'}`;
      }
    }
    if (!typesEqual(got.declaredResult, want.result)) {
      return `${prefix} returns ${formatType(got.declaredResult)}, want ${formatType(want.result)}`;
    }
    if (got.receiver.mode !== want.receiverMode) {
      return `${prefix} has ${got.receiver.mode} receiver, want ${want.receiverMode}`;
    }
  }
  return null;
}
