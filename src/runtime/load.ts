// Purpose: Module loader — evaluates one raw recursive generated JavaScript
// module and initializes its immutable manifest snapshots.

import type {JSModule} from './module-abi';
import {initializeModuleTree} from './module-binding';

/**
 * Evaluate a generated function body and restore its Arrow schemas. The result
 * owns its manifest; Node captures another copy before beginning execution.
 * @example `loadModule(generate(program)).outputs.fields` are real Arrow Fields.
 */
export function loadModule(js: string): JSModule {
  const factory = new Function(js) as () => JSModule;
  return initializeModuleTree(factory());
}
