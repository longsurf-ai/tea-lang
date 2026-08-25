// Purpose: Module loader — turns generated JavaScript source into a live JSModule; the only place generated code is evaluated in-process (isolate embedding replaces this seam later).

import type {JSModule} from './module-abi';

// Generated source is a strict-mode function body ending in `return {...}`.
export function loadModule(js: string): JSModule {
  const factory = new Function(js) as () => JSModule;
  return factory();
}
