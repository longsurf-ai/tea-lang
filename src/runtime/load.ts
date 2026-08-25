// Purpose: Module loader — evaluates one raw recursive generated JavaScript
// module and initializes its immutable manifest snapshots.

import type {JSModule} from './module-abi';
import {initializeModuleTree} from './module-binding';

// Generated source is a strict-mode function body ending in `return M`.
export function loadModule(js: string): JSModule {
  const factory = new Function(js) as () => JSModule;
  return initializeModuleTree(factory());
}
