// The handwritten/generated TypeScript runtime ships without compiler or Node API code.

import {build} from 'esbuild';
import {expect, test} from 'vitest';

test('tea/runtime bundles independently of the frontend and Node API', async () => {
  const result = await build({
    entryPoints: ['src/runtime/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    metafile: true,
  });
  expect(
    Object.keys(result.metafile.inputs).filter(
      path =>
        /^src\/(?:api|syntax|checker|loader|noder|codegen)\//.test(path) ||
        path === 'src/compiler.ts',
    ),
  ).toEqual([]);
  expect(
    Object.values(result.metafile.outputs).flatMap(output =>
      output.imports.filter(dependency =>
        ['typescript', 'esbuild'].includes(dependency.path),
      ),
    ),
  ).toEqual([]);
});
