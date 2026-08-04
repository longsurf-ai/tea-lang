// Purpose: Module loader — turns generated JavaScript source into a live TeaModule; the only place generated code is evaluated in-process (isolate embedding replaces this seam later).

import type {TeaModule} from './abi';

// Generated source is a strict-mode function body ending in `return {...}`.
export function loadModule(js: string): TeaModule {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(js) as () => TeaModule;
  return factory();
}
