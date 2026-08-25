// Purpose: Module loader — evaluates generated JavaScript with its private
// pure-binding evaluator injection and returns a live JSModule.

import type {JSModule} from './module-abi';
import {bindGeneratedModule} from './module-binding';

// Generated source is a strict-mode function body ending in `return {...}`.
export function loadModule(js: string): JSModule {
  const factory = new Function('$bind', js) as (
    bind: typeof bindGeneratedModule,
  ) => JSModule;
  return factory(bindGeneratedModule);
}
