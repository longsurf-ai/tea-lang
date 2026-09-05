// Purpose: Module loader — evaluates one raw recursive generated JavaScript
// module and initializes its mutable configuration.

import type {JSModule} from './module-abi';
import {initializeModule} from './module-binding';

/**
 * Evaluate a generated function body and restore its Arrow schemas. The result
 * owns its configuration; Node captures another copy before beginning execution.
 * @example `loadModule(generate(program)).outputs.schema.fields` are real Arrow Fields.
 */
export function loadModule(js: string): JSModule {
  const factory = new Function(js) as () => Parameters<
    typeof initializeModule
  >[0];
  return initializeModule(factory());
}
