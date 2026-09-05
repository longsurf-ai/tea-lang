import type {Module} from './module-binding';
// Load the same ordinary TypeScript module written by the compiler.

import {transformSync} from 'esbuild';
import * as runtime from './index';

/**
 * Transpile and load a TypeScript module synchronously, without executing steps.
 * Generated imports use the same runtime library as standalone compiled files.
 * Type checking belongs to builds; loading preserves the fast template path.
 *
 * @example `loadModule(generate(program)).bind({length: 20})` constructs and
 * configures the module without subscribing to inputs or running the program.
 */
export function loadModule(source: string): Module {
  const {code} = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
    sourcefile: 'generated.ts',
  });
  const module = {exports: {} as {default?: Module}};
  new Function('require', 'module', 'exports', code)(
    (specifier: string) => {
      if (specifier !== 'tea/runtime') {
        throw new Error(`generated module cannot import '${specifier}'`);
      }
      return runtime;
    },
    module,
    module.exports,
  );
  if (!(module.exports.default instanceof runtime.Module)) {
    throw new Error('generated module must export a runtime Module');
  }
  return module.exports.default;
}
