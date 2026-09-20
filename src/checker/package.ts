// Purpose: Checked-package ownership boundary pairing parsed files with their semantic package scope and root facts.

import type * as syntax from '../syntax/nodes';
import type {EnumType, StructType} from '../ir/type';
import type {FunctionInstance, Info} from './info';
import type {FunctionObject, Object, VariableObject} from './object';
import type {Scope} from './scope';

export interface Package {
  readonly path: string;
  readonly name: string;
  readonly files: readonly syntax.File[];
  readonly scope: Scope;
  // Direct dependency identities. Local aliases are PackageNameObjects in
  // the importing scope, never properties of the dependency graph.
  readonly imports: readonly Package[];
  // The public namespace points at the same canonical objects held by scope.
  readonly exports: ReadonlyMap<string, Object>;
}

export interface PackageContext {
  readonly info: Info;
  // Checker-computed dependency order. Scope remains the canonical package
  // declaration inventory; this is execution metadata only.
  readonly initOrder: readonly VariableObject[];
}

export interface CheckedPackage {
  readonly pkg: Package;
  readonly info: Info;
  // All elaborated package facts share the same canonical Package identities.
  // Noder selects the transitive runtime-state closure from this map.
  readonly packageContexts: ReadonlyMap<Package, PackageContext>;
  // Canonical nominal identities are checker-owned because only semantic
  // package/object provenance can distinguish equal display names. Generic
  // specializations recursively include the canonical ids of their concrete
  // type arguments.
  readonly nominalTypeIds: ReadonlyMap<StructType | EnumType, string>;
  /**
   * Every function instance the checker stenciled, grouped by template and in
   * instantiation order, across the root package and its libraries. Function
   * bodies are checked only here, so each instance's `Info` holds the facts
   * for one signature of that body.
   *
   * This is the checker's own memo table, read-only. It is the only path to a
   * method's declaration-validation instance: no `CallExpr` owns that one, so
   * walking `Info.calls` never reaches it. A free function that is never
   * called has no entry. Instances whose body reported errors stay listed.
   *
   * @example
   * ```ts
   * // After `g(close)` and `g(1)`, the parameter of `g` has two types.
   * const g = checked.pkg.scope.lookup('g') as FunctionObject;
   * checked.instances.get(g)?.map(instance => instance.signature[0]?.type);
   * ```
   */
  readonly instances: ReadonlyMap<FunctionObject, readonly FunctionInstance[]>;
}
