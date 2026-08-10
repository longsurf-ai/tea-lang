// Purpose: Checked-package ownership boundary pairing parsed files with their semantic package scope and root facts.

import type * as syntax from '../syntax/nodes';
import type {Info} from './info';
import type {Scope} from './scope';

export interface Package {
  readonly path: string;
  readonly name: string;
  readonly files: readonly syntax.File[];
  readonly scope: Scope;
  readonly imports: ReadonlyMap<string, Package>;
  readonly exports: ReadonlySet<string>;
}

export interface CheckedPackage {
  readonly pkg: Package;
  readonly info: Info;
}
