// Purpose: Checked-package ownership boundary pairing parsed files with their semantic package scope and root facts.

import type * as syntax from '../syntax/nodes';
import type {Info} from './info';
import type {Object} from './object';
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

export interface CheckedPackage {
  readonly pkg: Package;
  readonly info: Info;
}
