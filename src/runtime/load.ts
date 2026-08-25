// Purpose: Module loader — evaluates generated JavaScript with its private
// binding evaluator/module-constructor injection and returns an immutable
// unbound JSModule.

import type {JSModule} from './module-abi';
import {
  createGeneratedModule,
  evaluateGeneratedModule,
  initializeModuleTree,
} from './module-binding';

// Generated source is a strict-mode function body ending in `return {...}`.
export function loadModule(js: string): JSModule {
  const factory = new Function('$evaluate', '$module', js) as (
    evaluate: typeof evaluateGeneratedModule,
    module: typeof createGeneratedModule,
  ) => JSModule;
  const generated = factory(evaluateGeneratedModule, createGeneratedModule);
  return initializeModuleTree(
    'bindings' in generated ? generated : createGeneratedModule(generated),
  );
}
