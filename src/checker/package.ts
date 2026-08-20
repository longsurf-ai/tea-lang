// Purpose: Checked-package ownership boundary pairing parsed files with their semantic package scope and root facts.

import type * as syntax from '../syntax/nodes';
import type {EnumType, StructType} from '../ir/type';
import type {Info} from './info';
import type {Object, VariableObject} from './object';
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
}
